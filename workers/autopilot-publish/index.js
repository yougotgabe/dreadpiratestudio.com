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

  const pageId    = token.fb_page_id;
  const pageToken = token.page_access_token;

  // Upload all images to Facebook and collect attachment IDs
  const attachments = [];

  // Generated image first
  if (post.image_url) {
    const id = await uploadImageToFacebook(post.image_url, pageToken, pageId);
    if (id) attachments.push({ media_fbid: id });
  }

  // Client-supplied additional photos (base64 strings, max 3)
  const extraPhotos = (clientPhotos || []).slice(0, 3);
  for (const b64 of extraPhotos) {
    try {
      const id = await uploadBase64ImageToFacebook(b64, pageToken, pageId);
      if (id) attachments.push({ media_fbid: id });
    } catch (e) {
      console.warn('Client photo upload failed, skipping:', e.message);
    }
  }

  const payload = { message: post.caption, access_token: pageToken };
  if (attachments.length > 0) payload.attached_media = attachments;

  const res = await fetch(`https://graph.facebook.com/v19.0/${pageId}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message || 'Facebook publish failed');

  await supabase(env, 'PATCH', `/rest/v1/posts?id=eq.${post.id}`, {
    status:       'published',
    fb_post_id:   data.id,
    published_at: new Date().toISOString(),
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

// ─── PUSH NOTIFICATIONS ───────────────────────────────────────────────────────

async function sendPushNotification(clientId, { title, body, url }, env) {
  // Get all push subscriptions for this client
  const subs = await supabase(env, 'GET',
    `/rest/v1/notification_log?client_id=eq.${clientId}&subscription_active=eq.true&select=push_subscription`
  );

  if (!Array.isArray(subs) || subs.length === 0) return;

  const payload = JSON.stringify({ title, body, url });

  await Promise.allSettled(subs.map(sub =>
    sendWebPush(sub.push_subscription, payload, env)
  ));
}

async function sendWebPush(subscription, payload, env) {
  // Minimal Web Push via Cloudflare — requires VAPID keys
  // For now logs intent; replace with full VAPID implementation when push is wired up
  console.log('Push notification queued for subscription:', JSON.stringify(subscription), payload);
}

// ─── SLOT HELPERS ─────────────────────────────────────────────────────────────

function nextSlotOccurrence(slot, fromDate) {
  // Parse post_time as HH:MM:SS in slot's timezone
  const [h, m] = slot.post_time.split(':').map(Number);

  // Find next occurrence of slot.day_of_week from fromDate
  const d = new Date(fromDate);
  const diff = (slot.day_of_week - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + (diff === 0 ? 7 : diff)); // always next occurrence, not today
  d.setHours(h, m, 0, 0);

  // Note: this uses UTC. For timezone-accurate scheduling, convert using slot.timezone.
  // Full tz conversion can be added once Intl.DateTimeFormat is confirmed available in worker.
  return d;
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
