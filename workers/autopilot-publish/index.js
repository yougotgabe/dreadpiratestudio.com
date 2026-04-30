/**
 * DPS Autopilot — autopilot-publish Worker
 *
 * Cron (every 5 min):
 *   Phase 1 — Auto-generate: find slots due in ~24hrs, fire caption+image workers
 *   Phase 2 — Publish: find approved posts due in next 30min, publish to Facebook
 *   Phase 3 — Missed drafts: find pending posts past scheduled time, auto-draft
 *   Phase 4 — Cleanup: enforce rolling 5-post limit per client in generated_images
 *
 * Manual routes:
 *   POST /publish  — publish a specific approved post
 *   POST /draft    — save a specific post as Facebook draft
 *   GET  /run      — manually trigger cron logic
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   CAPTION_WORKER_URL, IMAGE_WORKER_URL
 *   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// How many hours before slot time to auto-generate
const GENERATE_LOOKAHEAD_HOURS = 24;
// Window around lookahead to catch (prevents double-firing between cron runs)
const GENERATE_WINDOW_MINUTES = 10;
// Rolling post history limit per client
const MAX_GENERATED_IMAGES = 5;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const path = new URL(request.url).pathname;
    try {
      if (path === '/publish' && request.method === 'POST') return handlePublish(request, env);
      if (path === '/draft'   && request.method === 'POST') return handleDraft(request, env);
      if (path === '/run'     && request.method === 'GET')  return handleRun(null, env);
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('Publish worker error:', err);
      return json({ error: err.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleRun(null, env));
  },
};

// ─── CRON ENTRY POINT ─────────────────────────────────────────────────────────

async function handleRun(request, env) {
  const results = { generated: 0, published: 0, drafted: 0, missed_drafted: 0, cleaned: 0, errors: [] };

  // Phase 1 — Auto-generate posts for slots due in ~24 hours
  try {
    const generated = await runAutoGenerate(env);
    results.generated = generated;
  } catch (err) {
    results.errors.push(`Auto-generate: ${err.message}`);
    console.error('Auto-generate phase failed:', err);
  }

  // Phase 2 — Publish approved posts due in next 30 minutes
  try {
    const published = await runPublish(env);
    results.published = published;
  } catch (err) {
    results.errors.push(`Publish: ${err.message}`);
    console.error('Publish phase failed:', err);
  }

  // Phase 3 — Auto-draft posts that missed their approval window
  try {
    const drafted = await runMissedDrafts(env);
    results.missed_drafted = drafted;
  } catch (err) {
    results.errors.push(`Missed drafts: ${err.message}`);
    console.error('Missed drafts phase failed:', err);
  }

  // Phase 4 — Enforce rolling 5-post limit in generated_images
  try {
    const cleaned = await runCleanup(env);
    results.cleaned = cleaned;
  } catch (err) {
    results.errors.push(`Cleanup: ${err.message}`);
    console.error('Cleanup phase failed:', err);
  }

  console.log('Cron run complete:', JSON.stringify(results));
  return json(results);
}

// ─── PHASE 1: AUTO-GENERATE ───────────────────────────────────────────────────

async function runAutoGenerate(env) {
  const now = new Date();

  // Target window: slots whose scheduled time is between 23h50m and 24h10m from now
  const windowStart = new Date(now.getTime() + (GENERATE_LOOKAHEAD_HOURS * 60 - GENERATE_WINDOW_MINUTES) * 60 * 1000);
  const windowEnd   = new Date(now.getTime() + (GENERATE_LOOKAHEAD_HOURS * 60 + GENERATE_WINDOW_MINUTES) * 60 * 1000);

  // Get all active slots
  const slots = await supabase(env, 'GET',
    `/rest/v1/scheduled_slots?is_active=eq.true&select=*,clients(id,plan)`
  );

  if (!Array.isArray(slots) || slots.length === 0) return 0;

  let generated = 0;

  for (const slot of slots) {
    try {
      // Calculate next occurrence of this slot's day_of_week + post_time in its timezone
      const slotTime = nextSlotOccurrence(slot, now);

      // Check if this slot falls in our generate window
      if (slotTime < windowStart || slotTime > windowEnd) continue;

      // Check if drafted this week — skip if so
      const thisMonday = getWeekStart(now).toISOString().slice(0, 10);
      if (slot.drafted_week === thisMonday) {
        console.log(`Slot ${slot.id} drafted this week, skipping`);
        continue;
      }

      // Check if a post already exists for this slot this week (any active status)
      const existing = await supabase(env, 'GET',
        `/rest/v1/posts?slot_id=eq.${slot.id}&is_latest_attempt=eq.true&status=in.(generating,pending,approved,published)&select=id,status&limit=1`
      );
      if (Array.isArray(existing) && existing.length > 0) {
        console.log(`Slot ${slot.id} already has post ${existing[0].id} (${existing[0].status}), skipping`);
        continue;
      }

      // Create post row
      const plan = slot.clients?.plan || 'starter';
      const maxAttempts = { starter: 3, growth: 4, daily: 5 }[plan] || 3;

      const newPosts = await supabase(env, 'POST', '/rest/v1/posts', {
        client_id:         slot.client_id,
        slot_id:           slot.id,
        scheduled_for:     slotTime.toISOString(),
        status:            'generating',
        post_category:     slot.post_type || 'general',
        attempt_number:    1,
        max_attempts:      maxAttempts,
        is_latest_attempt: true,
      }, { Prefer: 'return=representation' });

      const postId = Array.isArray(newPosts) ? newPosts[0]?.id : newPosts?.id;
      if (!postId) throw new Error('Post row creation returned no ID');

      // Fire caption worker (which will also generate image prompt)
      await fetch(`${env.CAPTION_WORKER_URL}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          post_id:   postId,
          post_type: slot.post_type || 'general',
        }),
      });

      // Fire image worker
      await fetch(`${env.IMAGE_WORKER_URL}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post_id: postId }),
      });

      // Send push notification to client
      await sendPushNotification(slot.client_id, {
        title: 'Your post is ready for review ✦',
        body:  `Slot ${slot.slot_number} — tap to approve or regenerate before it auto-drafts.`,
        url:   '/autopilot/dashboard/dashboard.html',
      }, env);

      console.log(`Auto-generated post ${postId} for slot ${slot.id}`);
      generated++;

    } catch (err) {
      console.error(`Auto-generate failed for slot ${slot.id}:`, err.message);
    }
  }

  return generated;
}

// ─── PHASE 2: PUBLISH ─────────────────────────────────────────────────────────

async function runPublish(env) {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + 30 * 60 * 1000);

  const posts = await supabase(env, 'GET',
    `/rest/v1/posts?status=eq.approved&scheduled_for=gte.${now.toISOString()}&scheduled_for=lte.${windowEnd.toISOString()}&select=*`
  );

  if (!Array.isArray(posts) || posts.length === 0) return 0;

  const results = await Promise.allSettled(posts.map(post => publishPost(post, [], env)));
  return results.filter(r => r.status === 'fulfilled').length;
}

// ─── PHASE 3: MISSED DRAFTS ───────────────────────────────────────────────────

async function runMissedDrafts(env) {
  const now = new Date().toISOString();

  const missed = await supabase(env, 'GET',
    `/rest/v1/posts?status=eq.pending&scheduled_for=lte.${now}&is_latest_attempt=eq.true&select=*`
  );

  if (!Array.isArray(missed) || missed.length === 0) return 0;

  const results = await Promise.allSettled(missed.map(post => draftPost(post, [], env)));

  // Notify clients whose posts were auto-drafted
  for (let i = 0; i < missed.length; i++) {
    if (results[i].status === 'fulfilled') {
      await sendPushNotification(missed[i].client_id, {
        title: 'Post saved to Facebook drafts',
        body:  'Your post wasn\'t approved in time so we saved it to your Facebook drafts automatically.',
        url:   '/autopilot/dashboard/dashboard.html',
      }, env).catch(() => {});
    }
  }

  return results.filter(r => r.status === 'fulfilled').length;
}

// ─── PHASE 4: ROLLING CLEANUP ─────────────────────────────────────────────────

async function runCleanup(env) {
  // Get all clients that have generated_images entries
  const allImages = await supabase(env, 'GET',
    `/rest/v1/generated_images?select=id,client_id,created_at&order=client_id.asc,created_at.desc`
  );

  if (!Array.isArray(allImages) || allImages.length === 0) return 0;

  // Group by client
  const byClient = {};
  for (const img of allImages) {
    if (!byClient[img.client_id]) byClient[img.client_id] = [];
    byClient[img.client_id].push(img);
  }

  let deleted = 0;

  for (const [clientId, images] of Object.entries(byClient)) {
    if (images.length <= MAX_GENERATED_IMAGES) continue;

    // Images are already sorted newest first — delete everything beyond the limit
    const toDelete = images.slice(MAX_GENERATED_IMAGES);
    for (const img of toDelete) {
      try {
        await supabase(env, 'DELETE',
          `/rest/v1/generated_images?id=eq.${img.id}`,
          null, { Prefer: 'return=minimal' }
        );
        deleted++;
      } catch (err) {
        console.error(`Cleanup failed for image ${img.id}:`, err.message);
      }
    }
  }

  return deleted;
}

// ─── MANUAL ROUTES ────────────────────────────────────────────────────────────

async function handlePublish(request, env) {
  const { post_id, client_photos } = await request.json();
  if (!post_id) return json({ error: 'Missing post_id' }, 400);

  const rows = await supabase(env, 'GET', `/rest/v1/posts?id=eq.${post_id}&select=*&limit=1`);
  const post = Array.isArray(rows) ? rows[0] : null;
  if (!post) return json({ error: 'Post not found' }, 404);

  await publishPost(post, client_photos || [], env);
  return json({ success: true });
}

async function handleDraft(request, env) {
  const { post_id, client_photos } = await request.json();
  if (!post_id) return json({ error: 'Missing post_id' }, 400);

  const rows = await supabase(env, 'GET', `/rest/v1/posts?id=eq.${post_id}&select=*&limit=1`);
  const post = Array.isArray(rows) ? rows[0] : null;
  if (!post) return json({ error: 'Post not found' }, 404);

  await draftPost(post, client_photos || [], env);
  return json({ success: true });
}

// ─── CORE: PUBLISH ────────────────────────────────────────────────────────────

async function publishPost(post, clientPhotos = [], env) {
  const token = await getFacebookToken(post.client_id, env);
  if (!token) throw new Error(`No Facebook token for client ${post.client_id}`);

  const pageId    = token.page_id || token.fb_page_id;
  const pageToken = token.page_token || token.page_access_token;
  const igUserId  = token.instagram_user_id || null;

  // ── Facebook publish ──────────────────────────────────────────────────────
  const attachments = [];

  if (post.image_url) {
    const id = await uploadImageToFacebook(post.image_url, pageToken, pageId);
    if (id) attachments.push({ media_fbid: id });
  }

  const extraPhotos = (clientPhotos || []).slice(0, 3);
  for (const b64 of extraPhotos) {
    try {
      const id = await uploadBase64ImageToFacebook(b64, pageToken, pageId);
      if (id) attachments.push({ media_fbid: id });
    } catch (e) {
      console.warn('Client photo upload failed, skipping:', e.message);
    }
  }

  const fbPayload = { message: post.caption, access_token: pageToken };
  if (attachments.length > 0) fbPayload.attached_media = attachments;

  const fbRes = await fetch(`https://graph.facebook.com/v19.0/${pageId}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fbPayload),
  });

  const fbData = await fbRes.json();
  if (!fbRes.ok || fbData.error) throw new Error(fbData.error?.message || 'Facebook publish failed');

  // ── Instagram publish (if connected) ─────────────────────────────────────
  let igPostId = null;
  if (igUserId && post.image_url) {
    try {
      igPostId = await publishToInstagram(igUserId, pageToken, post.image_url, post.caption);
    } catch(e) {
      console.error('Instagram publish failed (non-fatal):', e.message);
    }
  }

  await supabase(env, 'PATCH', `/rest/v1/posts?id=eq.${post.id}`, {
    status:       'published',
    fb_post_id:   fbData.id,
    published_at: new Date().toISOString(),
    ...(igPostId ? { ig_post_id: igPostId } : {}),
  });
}

// ─── CORE: DRAFT ──────────────────────────────────────────────────────────────

async function draftPost(post, clientPhotos = [], env) {
  const token = await getFacebookToken(post.client_id, env);
  if (!token) throw new Error(`No Facebook token for client ${post.client_id}`);

  const pageId    = token.fb_page_id;
  const pageToken = token.page_access_token;

  const attachments = [];

  if (post.image_url) {
    const id = await uploadImageToFacebook(post.image_url, pageToken, pageId);
    if (id) attachments.push({ media_fbid: id });
  }

  const extraPhotos = (clientPhotos || []).slice(0, 3);
  for (const b64 of extraPhotos) {
    try {
      const id = await uploadBase64ImageToFacebook(b64, pageToken, pageId);
      if (id) attachments.push({ media_fbid: id });
    } catch (e) {
      console.warn('Client photo upload failed, skipping:', e.message);
    }
  }

  const payload = {
    message:   post.caption,
    published: false,
    access_token: pageToken,
  };
  if (attachments.length > 0) payload.attached_media = attachments;

  const res = await fetch(`https://graph.facebook.com/v19.0/${pageId}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message || 'Facebook draft failed');

  await supabase(env, 'PATCH', `/rest/v1/posts?id=eq.${post.id}`, {
    status:           'draft',
    fb_draft_post_id: data.id,
  });
}

// ─── FACEBOOK HELPERS ─────────────────────────────────────────────────────────

async function uploadImageToFacebook(imageUrl, pageToken, pageId) {
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) return null;
  const imgBlob = await imgRes.blob();

  const form = new FormData();
  form.append('source', imgBlob, 'post-image.png');
  form.append('published', 'false');
  form.append('access_token', pageToken);

  const res = await fetch(`https://graph.facebook.com/v19.0/${pageId}/photos`, {
    method: 'POST',
    body: form,
  });

  const data = await res.json();
  return data.id || null;
}

async function uploadBase64ImageToFacebook(b64, pageToken, pageId) {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const blob  = new Blob([bytes], { type: 'image/jpeg' });

  const form = new FormData();
  form.append('source', blob, 'photo.jpg');
  form.append('published', 'false');
  form.append('access_token', pageToken);

  const res = await fetch(`https://graph.facebook.com/v19.0/${pageId}/photos`, {
    method: 'POST',
    body: form,
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.id || null;
}

async function getFacebookToken(clientId, env) {
  const rows = await supabase(env, 'GET',
    `/rest/v1/facebook_tokens?client_id=eq.${clientId}&select=*&limit=1`
  );
  return Array.isArray(rows) ? rows[0] : null;
}

// ─── INSTAGRAM HELPERS ────────────────────────────────────────────────────────

async function publishToInstagram(igUserId, pageToken, imageUrl, caption) {
  // Step 1: Create media container
  const containerParams = new URLSearchParams({
    image_url:    imageUrl,
    caption:      caption,
    access_token: pageToken,
  });

  const containerRes = await fetch(
    `https://graph.facebook.com/v21.0/${igUserId}/media`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: containerParams,
    }
  );

  const containerData = await containerRes.json();
  if (!containerRes.ok || containerData.error) {
    throw new Error(containerData.error?.message || 'Instagram container creation failed');
  }

  const containerId = containerData.id;

  // Step 2: Publish the container
  const publishParams = new URLSearchParams({
    creation_id:  containerId,
    access_token: pageToken,
  });

  const publishRes = await fetch(
    `https://graph.facebook.com/v21.0/${igUserId}/media_publish`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: publishParams,
    }
  );

  const publishData = await publishRes.json();
  if (!publishRes.ok || publishData.error) {
    throw new Error(publishData.error?.message || 'Instagram publish failed');
  }

  return publishData.id;
}

// ─── PUSH NOTIFICATIONS ───────────────────────────────────────────────────────

async function sendPushNotification(clientId, { title, body, url }, env) {
  const subs = await supabase(env, 'GET',
    `/rest/v1/push_subscriptions?client_id=eq.${clientId}&is_active=eq.true&select=id,endpoint,p256dh,auth`
  );

  if (!Array.isArray(subs) || subs.length === 0) {
    console.log(`No active push subscriptions for client ${clientId}`);
    return;
  }

  const payload = JSON.stringify({ title, body, url, tag: 'autopilot-review' });

  await Promise.allSettled(subs.map(sub =>
    sendWebPush(sub, payload, env).catch(async err => {
      console.error(`Push failed for sub ${sub.id}:`, err.message);
      // If subscription is gone (410), mark it inactive
      if (err.message?.includes('410') || err.message?.includes('404')) {
        await supabase(env, 'PATCH',
          `/rest/v1/push_subscriptions?id=eq.${sub.id}`,
          { is_active: false },
          { Prefer: 'return=minimal' }
        ).catch(() => {});
      }
    })
  ));
}

async function sendWebPush(sub, payload, env) {
  // Build VAPID authorization header
  const vapidHeaders = await buildVapidHeaders(
    sub.endpoint,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY,
    env.VAPID_SUBJECT
  );

  const encrypted = await encryptPayload(payload, sub.p256dh, sub.auth);

  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      ...vapidHeaders,
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'Content-Length':   encrypted.byteLength.toString(),
      'TTL':              '86400',
    },
    body: encrypted,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Push endpoint returned ${res.status}: ${text}`);
  }
}

// ── VAPID JWT Builder ──────────────────────────────────────────────────────────

async function buildVapidHeaders(endpoint, publicKeyB64, privateKeyB64, subject) {
  const audience = new URL(endpoint).origin;
  const expiry = Math.floor(Date.now() / 1000) + 12 * 3600;

  const header  = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(JSON.stringify({ aud: audience, exp: expiry, sub: subject }));
  const sigInput = `${header}.${payload}`;

  // Import private key
  const privateKeyBytes = base64urlToBytes(privateKeyB64);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', privateKeyBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    new TextEncoder().encode(sigInput)
  );

  const jwt = `${sigInput}.${bytesToBase64url(new Uint8Array(signature))}`;

  return {
    'Authorization': `vapid t=${jwt}, k=${publicKeyB64}`,
  };
}

// ── Web Push Payload Encryption (RFC 8291 / aes128gcm) ────────────────────────

async function encryptPayload(payload, p256dhB64, authB64) {
  const encoder = new TextEncoder();
  const plaintext = encoder.encode(payload);

  // Decode client keys
  const clientPublicKey = base64urlToBytes(p256dhB64);
  const authSecret      = base64urlToBytes(authB64);

  // Generate server ECDH key pair
  const serverKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true, ['deriveBits']
  );

  const serverPublicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', serverKeyPair.publicKey)
  );

  // Import client public key
  const clientKey = await crypto.subtle.importKey(
    'raw', clientPublicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false, []
  );

  // ECDH shared secret
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: clientKey },
      serverKeyPair.privateKey,
      256
    )
  );

  // Generate salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // HKDF to derive content encryption key and nonce
  const prk = await hkdf(authSecret, sharedSecret,
    buildInfo('auth', new Uint8Array(0), new Uint8Array(0)), 32);

  const cek = await hkdf(salt, prk,
    buildInfo('aesgcm', clientPublicKey, serverPublicKeyBytes), 16);

  const nonce = await hkdf(salt, prk,
    buildInfo('nonce', clientPublicKey, serverPublicKeyBytes), 12);

  // Encrypt with AES-GCM
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext)
  );

  // Build aes128gcm content (RFC 8291)
  // Header: salt(16) + rs(4) + idlen(1) + serverPublicKey(65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);

  const header = new Uint8Array(16 + 4 + 1 + serverPublicKeyBytes.length);
  header.set(salt, 0);
  header.set(rs, 16);
  header[20] = serverPublicKeyBytes.length;
  header.set(serverPublicKeyBytes, 21);

  // Combine header + ciphertext
  const result = new Uint8Array(header.length + ciphertext.length);
  result.set(header, 0);
  result.set(ciphertext, header.length);

  return result;
}

async function hkdf(salt, ikm, info, length) {
  const saltKey = await crypto.subtle.importKey('raw', salt, 'HKDF', false, ['deriveBits']);
  // Extract
  const prk = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: ikm },
    saltKey, 256
  );
  // Expand
  const prkKey = await crypto.subtle.importKey('raw', prk, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info },
      prkKey, length * 8
    )
  );
}

function buildInfo(type, clientKey, serverKey) {
  const encoder = new TextEncoder();
  const typeBytes = encoder.encode(`Content-Encoding: ${type}\0`);
  const info = new Uint8Array(typeBytes.length + 1 + 2 + clientKey.length + 2 + serverKey.length);
  let offset = 0;
  info.set(typeBytes, offset); offset += typeBytes.length;
  info[offset++] = 0x41; // 'A'
  new DataView(info.buffer).setUint16(offset, clientKey.length, false); offset += 2;
  info.set(clientKey, offset); offset += clientKey.length;
  new DataView(info.buffer).setUint16(offset, serverKey.length, false); offset += 2;
  info.set(serverKey, offset);
  return info;
}

// ── Encoding helpers ──────────────────────────────────────────────────────────

function b64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function bytesToBase64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlToBytes(b64) {
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

// ─── SLOT HELPERS ─────────────────────────────────────────────────────────────

function nextSlotOccurrence(slot, fromDate) {
  const tz = slot.timezone || 'America/Chicago';
  const [h, m] = slot.post_time.split(':').map(Number);
  const targetDow = slot.day_of_week; // 0=Sun, 6=Sat

  // We need to find the next date where:
  //   - day of week in the slot's timezone === targetDow
  //   - time in the slot's timezone === h:m
  // Then return that moment as a UTC Date.

  // Start from now and iterate forward day by day (max 8 days)
  // to find the next occurrence of the target day_of_week in the slot's tz.
  for (let daysAhead = 1; daysAhead <= 8; daysAhead++) {
    const candidate = new Date(fromDate.getTime() + daysAhead * 24 * 60 * 60 * 1000);

    // Get the day of week in the slot's timezone for this candidate date
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      year:    'numeric',
      month:   '2-digit',
      day:     '2-digit',
    }).formatToParts(candidate);

    const partMap = {};
    parts.forEach(p => { partMap[p.type] = p.value; });

    const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const candidateDow = dowMap[partMap.weekday];

    if (candidateDow !== targetDow) continue;

    // Found the right day — now build a Date at h:m in the slot's timezone.
    // Construct an ISO-like string and parse it in that timezone.
    const dateStr = `${partMap.year}-${partMap.month}-${partMap.day}`;

    // Use Intl to find the UTC offset for this tz on this date at this time.
    // We do this by formatting a UTC date and comparing to local time.
    const approxLocal = new Date(`${dateStr}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`);

    // Get what UTC time corresponds to h:m local in tz on this date
    // by using the offset between UTC and the tz at that moment.
    const utcTime = localToUTC(dateStr, h, m, tz);
    return utcTime;
  }

  // Fallback — shouldn't happen but return 25hrs from now
  return new Date(fromDate.getTime() + 25 * 60 * 60 * 1000);
}

function localToUTC(dateStr, h, m, tz) {
  // Build a temp date at noon UTC on the target date to get the tz offset
  const noonUTC = new Date(`${dateStr}T12:00:00Z`);

  // Format noon UTC in the target timezone to find what UTC offset applies
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
    year:     'numeric',
    month:    '2-digit',
    day:      '2-digit',
  });

  const parts = formatter.formatToParts(noonUTC);
  const pm = {};
  parts.forEach(p => { pm[p.type] = p.value; });

  // Reconstruct what noon UTC looks like in local time
  const localNoonH = parseInt(pm.hour, 10);
  const localNoonM = parseInt(pm.minute, 10);

  // Offset in minutes: local = UTC + offset → offset = local - UTC
  const offsetMins = (localNoonH * 60 + localNoonM) - (12 * 60);

  // Target time in UTC = target local time - offset
  const targetUTCMins = h * 60 + m - offsetMins;
  const targetUTCH = Math.floor(targetUTCMins / 60);
  const targetUTCM = ((targetUTCMins % 60) + 60) % 60;

  // Build the final UTC date
  const result = new Date(`${dateStr}T00:00:00Z`);
  result.setUTCHours(targetUTCH, targetUTCM, 0, 0);
  return result;
}

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ─── SUPABASE HELPER ──────────────────────────────────────────────────────────

async function supabase(env, method, path, body = null, extraHeaders = {}) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Prefer: 'return=representation',
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path} → ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
