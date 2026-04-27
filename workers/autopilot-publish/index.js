/**
 * DPS Autopilot — autopilot-publish Worker
 *
 * Runs on a cron schedule every 5 minutes.
 * Handles three jobs:
 *
 *   1. AUTO-GENERATE — Creates post rows and fires caption+image workers
 *      for any slot that has a post coming up in the next 24hrs with no
 *      current generation.
 *
 *   2. AUTO-PUBLISH — Publishes approved posts to Facebook via the
 *      Meta Pages API when their scheduled_for time has arrived.
 *      Also handles draft saves for posts in 'draft' status.
 *
 *   3. PUSH NOTIFY — Sends push notifications to clients when newly
 *      generated posts are ready for review.
 *
 * Routes (manual triggers for testing):
 *   GET /run          — run all three jobs now
 *   GET /generate     — run auto-generate only
 *   GET /publish      — run auto-publish only
 *   GET /notify/:id   — send test push to a specific client
 *
 * Env vars:
 *   SUPABASE_URL           — https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY   — service_role key
 *   CAPTION_WORKER_URL     — https://autopilot-caption.dreadpiratestudio.workers.dev
 *   IMAGE_WORKER_URL       — https://autopilot-image.dreadpiratestudio.workers.dev
 *   VAPID_PRIVATE_KEY      — your VAPID private key
 *   VAPID_PUBLIC_KEY       — your VAPID public key
 *   VAPID_SUBJECT          — mailto:gabe@dreadpiratestudio.com
 *   RESEND_API_KEY         — re_... (for email fallback)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const FB_API = 'https://graph.facebook.com/v21.0';

// Plan → max_attempts mapping (must match caption worker)
const PLAN_MAX_ATTEMPTS = { starter: 3, growth: 4, daily: 5 };

// ── Entry point ────────────────────────────────────────────────────────────────

export default {
  // Cron trigger — runs every 5 minutes
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAllJobs(env));
  },

  // HTTP trigger — for manual testing
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    if (path === '/run') {
      const results = await runAllJobs(env);
      return json(results);
    }
    if (path === '/generate') {
      const results = await jobAutoGenerate(env);
      return json(results);
    }
    if (path === '/publish') {
      const results = await jobAutoPublish(env);
      return json(results);
    }
    if (path.startsWith('/notify/')) {
      const clientId = path.split('/notify/')[1];
      await sendPushToClient(env, clientId, {
        title: 'DPS Autopilot',
        body: 'Test notification — your posts are ready for review.',
        url: 'https://dreadpiratestudio.com/autopilot/dashboard/dashboard.html',
      });
      return json({ sent: true });
    }

    return json({ status: 'autopilot-publish worker running' });
  },
};

// ── Job runner ─────────────────────────────────────────────────────────────────

async function runAllJobs(env) {
  const [generateResult, publishResult] = await Promise.allSettled([
    jobAutoGenerate(env),
    jobAutoPublish(env),
  ]);

  return {
    generate: generateResult.status === 'fulfilled' ? generateResult.value : { error: generateResult.reason?.message },
    publish:  publishResult.status  === 'fulfilled' ? publishResult.value  : { error: publishResult.reason?.message  },
  };
}

// ── JOB 1: Auto-generate ───────────────────────────────────────────────────────
// Find slots where scheduled_for is within 24hrs and no post exists yet.
// Create a post row and fire caption + image workers.

async function jobAutoGenerate(env) {
  const generated = [];

  // Use the posts_due_for_generation view from schema
  const slots = await sb(env, 'GET',
    '/rest/v1/posts_due_for_generation?select=*'
  );

  if (!slots?.length) return { generated: 0 };

  for (const slot of slots) {
    try {
      // Calculate next scheduled_for based on day_of_week + post_time
      const scheduledFor = nextOccurrence(slot.day_of_week, slot.post_time, slot.timezone);

      // Only generate if within 24 hours
      const hoursUntil = (new Date(scheduledFor) - Date.now()) / 3600000;
      if (hoursUntil > 24 || hoursUntil < 0) continue;

      // Create the post row
      const maxAttempts = PLAN_MAX_ATTEMPTS[slot.plan] || 3;
      const postRows = await sb(env, 'POST', '/rest/v1/posts', {
        client_id:       slot.client_id,
        slot_id:         slot.slot_id,
        scheduled_for:   scheduledFor,
        status:          'generating',
        attempt_number:  1,
        max_attempts:    maxAttempts,
        post_category:   slot.preferred_post_category || pickCategory(),
        is_latest_attempt: true,
      });

      const postId = Array.isArray(postRows) ? postRows[0]?.id : postRows?.id;
      if (!postId) continue;

      // Fire caption worker (don't await — let it run async)
      fetch(`${env.CAPTION_WORKER_URL}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post_id: postId }),
      }).then(async (res) => {
        if (res.ok) {
          // After caption succeeds, fire image worker
          await fetch(`${env.IMAGE_WORKER_URL}/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ post_id: postId }),
          });
          // Mark pending and notify client
          await sb(env, 'PATCH', `/rest/v1/posts?id=eq.${postId}`, { status: 'pending' });
          await notifyClientPostReady(env, slot.client_id, postId);
        }
      }).catch(err => console.error(`Generation failed for post ${postId}:`, err));

      generated.push({ post_id: postId, slot_id: slot.slot_id, client_id: slot.client_id });
    } catch (err) {
      console.error(`Auto-generate error for slot ${slot.slot_id}:`, err.message);
    }
  }

  return { generated: generated.length, posts: generated };
}

// ── JOB 2: Auto-publish ────────────────────────────────────────────────────────
// Find approved posts whose scheduled_for has passed. Publish to Facebook.
// Also handle posts in 'draft' status.

async function jobAutoPublish(env) {
  const now = new Date().toISOString();
  const published = [];
  const drafted = [];
  const failed = [];

  // Fetch approved posts that are due
  const approvedPosts = await sb(env, 'GET',
    `/rest/v1/posts?status=eq.approved&scheduled_for=lte.${now}&is_latest_attempt=eq.true&select=*`
  );

  // Fetch draft posts that are due
  const draftPosts = await sb(env, 'GET',
    `/rest/v1/posts?status=eq.draft&scheduled_for=lte.${now}&is_latest_attempt=eq.true&select=*`
  );

  const allDuePosts = [
    ...(approvedPosts || []).map(p => ({ ...p, _action: 'publish' })),
    ...(draftPosts    || []).map(p => ({ ...p, _action: 'draft'   })),
  ];

  if (!allDuePosts.length) return { published: 0, drafted: 0, failed: 0 };

  for (const post of allDuePosts) {
    try {
      // Get the client's Facebook page token
      const tokens = await sb(env, 'GET',
        `/rest/v1/facebook_tokens?client_id=eq.${post.client_id}&is_active=eq.true&select=page_id,page_token&limit=1`
      );

      if (!tokens?.length) {
        console.warn(`No Facebook token for client ${post.client_id}, skipping post ${post.id}`);
        await sb(env, 'PATCH', `/rest/v1/posts?id=eq.${post.id}`, {
          status: 'failed',
          updated_at: new Date().toISOString(),
        });
        failed.push({ post_id: post.id, reason: 'no_facebook_token' });
        continue;
      }

      const { page_id, page_token } = tokens[0];

      if (post._action === 'publish') {
        // Publish to Facebook
        const fbResult = await publishToFacebook(page_id, page_token, post);
        if (fbResult.success) {
          await sb(env, 'PATCH', `/rest/v1/posts?id=eq.${post.id}`, {
            status:       'published',
            fb_post_id:   fbResult.post_id,
            fb_page_id:   page_id,
            published_at: new Date().toISOString(),
            updated_at:   new Date().toISOString(),
          });
          // Log to feedback_log
          await logFeedbackEvent(env, post, 'approved');
          // Notify client of publish
          await notifyClientPostPublished(env, post.client_id, post.id);
          published.push({ post_id: post.id, fb_post_id: fbResult.post_id });
        } else {
          await sb(env, 'PATCH', `/rest/v1/posts?id=eq.${post.id}`, {
            status:     'failed',
            updated_at: new Date().toISOString(),
          });
          failed.push({ post_id: post.id, reason: fbResult.error });
        }
      } else {
        // Save as Facebook draft
        const fbResult = await saveFacebookDraft(page_id, page_token, post);
        if (fbResult.success) {
          await sb(env, 'PATCH', `/rest/v1/posts?id=eq.${post.id}`, {
            status:           'draft',
            fb_draft_post_id: fbResult.post_id,
            fb_page_id:       page_id,
            updated_at:       new Date().toISOString(),
          });
          drafted.push({ post_id: post.id, fb_draft_id: fbResult.post_id });
        } else {
          failed.push({ post_id: post.id, reason: fbResult.error });
        }
      }
    } catch (err) {
      console.error(`Publish error for post ${post.id}:`, err.message);
      failed.push({ post_id: post.id, reason: err.message });
    }
  }

  return { published: published.length, drafted: drafted.length, failed: failed.length, details: { published, drafted, failed } };
}

// ── Facebook API ───────────────────────────────────────────────────────────────

async function publishToFacebook(pageId, pageToken, post) {
  try {
    const body = new URLSearchParams();
    body.set('message', post.caption || '');
    body.set('access_token', pageToken);

    // Attach image if available
    if (post.image_url) {
      // Use the attached media endpoint
      // First upload the photo as unpublished, then attach to feed post
      const photoRes = await fetch(`${FB_API}/${pageId}/photos`, {
        method: 'POST',
        body: new URLSearchParams({
          url:          post.image_url,
          access_token: pageToken,
          published:    'false',
        }),
      });
      const photoData = await photoRes.json();
      if (photoData.id) {
        body.set('attached_media[0]', JSON.stringify({ media_fbid: photoData.id }));
      }
    }

    const res  = await fetch(`${FB_API}/${pageId}/feed`, { method: 'POST', body });
    const data = await res.json();

    if (data.error) {
      console.error('Facebook publish error:', data.error);
      return { success: false, error: data.error.message };
    }

    return { success: true, post_id: data.id };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function saveFacebookDraft(pageId, pageToken, post) {
  try {
    const body = new URLSearchParams({
      message:        post.caption || '',
      access_token:   pageToken,
      published:      'false',
      scheduled_publish_time: Math.floor(new Date(post.scheduled_for).getTime() / 1000).toString(),
    });

    if (post.image_url) {
      const photoRes = await fetch(`${FB_API}/${pageId}/photos`, {
        method: 'POST',
        body: new URLSearchParams({
          url:          post.image_url,
          access_token: pageToken,
          published:    'false',
        }),
      });
      const photoData = await photoRes.json();
      if (photoData.id) {
        body.set('attached_media[0]', JSON.stringify({ media_fbid: photoData.id }));
      }
    }

    const res  = await fetch(`${FB_API}/${pageId}/feed`, { method: 'POST', body });
    const data = await res.json();

    if (data.error) return { success: false, error: data.error.message };
    return { success: true, post_id: data.id };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Push notifications ─────────────────────────────────────────────────────────

async function notifyClientPostReady(env, clientId, postId) {
  const payload = {
    title: 'New post ready for review',
    body:  'Your AI-generated post is ready — approve, reject, or regenerate.',
    tag:   `post-ready-${postId}`,
    url:   'https://dreadpiratestudio.com/autopilot/dashboard/dashboard.html',
  };
  await sendPushToClient(env, clientId, payload);
  await logNotification(env, clientId, postId, 'post_ready_for_review');
}

async function notifyClientPostPublished(env, clientId, postId) {
  const payload = {
    title: 'Post published ✓',
    body:  'Your scheduled post went live on Facebook.',
    tag:   `published-${postId}`,
    url:   'https://dreadpiratestudio.com/autopilot/dashboard/dashboard.html',
  };
  await sendPushToClient(env, clientId, payload);
  await logNotification(env, clientId, postId, 'post_published');
}

async function sendPushToClient(env, clientId, payload) {
  try {
    const clients = await sb(env, 'GET',
      `/rest/v1/clients?id=eq.${clientId}&select=push_enabled,push_subscription,push_fallback_email,email`
    );
    const client = clients?.[0];
    if (!client) return;

    if (client.push_enabled && client.push_subscription) {
      await sendWebPush(env, client.push_subscription, payload);
    }

    // Email fallback
    if (client.push_fallback_email || !client.push_enabled) {
      await sendFallbackEmail(env, client.email, payload);
    }
  } catch (err) {
    console.error(`Push error for client ${clientId}:`, err.message);
  }
}

async function sendWebPush(env, subscription, payload) {
  // Build VAPID JWT
  const vapidHeaders = await buildVapidHeaders(
    env,
    subscription.endpoint,
    payload
  );

  const res = await fetch(subscription.endpoint, {
    method:  'POST',
    headers: vapidHeaders,
    body:    JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('Web push failed:', res.status, text);
  }
}

async function buildVapidHeaders(env, endpoint, payload) {
  const audience = new URL(endpoint).origin;
  const expiry   = Math.floor(Date.now() / 1000) + 12 * 3600; // 12hr

  const header  = { typ: 'JWT', alg: 'ES256' };
  const claims  = { aud: audience, exp: expiry, sub: env.VAPID_SUBJECT };

  const headerB64  = base64url(JSON.stringify(header));
  const claimsB64  = base64url(JSON.stringify(claims));
  const sigInput   = `${headerB64}.${claimsB64}`;

  // Import VAPID private key
  const privateKeyBytes = base64urlDecode(env.VAPID_PRIVATE_KEY);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    privateKeyBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    new TextEncoder().encode(sigInput)
  );

  const jwt = `${sigInput}.${base64url(sig)}`;

  return {
    'Authorization':  `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
    'Content-Type':   'application/json',
    'TTL':            '86400',
  };
}

async function sendFallbackEmail(env, email, payload) {
  if (!env.RESEND_API_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    'DPS Autopilot <autopilot@dreadpiratestudio.com>',
        to:      [email],
        subject: payload.title,
        html:    `<p>${payload.body}</p><p><a href="${payload.url}">Open Dashboard →</a></p>`,
      }),
    });
  } catch (err) {
    console.error('Email fallback error:', err.message);
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────────

async function logFeedbackEvent(env, post, eventType) {
  try {
    await sb(env, 'POST', '/rest/v1/feedback_log', {
      client_id:          post.client_id,
      post_id:            post.id,
      event_type:         eventType,
      caption_snapshot:   post.caption || '',
      image_url_snapshot: post.image_url || '',
      post_category:      post.post_category || '',
    });
  } catch (err) {
    console.error('feedback_log error:', err.message);
  }
}

async function logNotification(env, clientId, postId, type) {
  try {
    await sb(env, 'POST', '/rest/v1/notification_log', {
      client_id:         clientId,
      post_id:           postId,
      notification_type: type,
      channel:           'push',
      delivered:         true,
    });
  } catch (err) {
    console.error('notification_log error:', err.message);
  }
}

function nextOccurrence(dayOfWeek, postTime, timezone) {
  const now = new Date();
  const [hours, minutes] = postTime.split(':').map(Number);
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);

  // Find next occurrence of this day_of_week
  const currentDay = now.getDay();
  let daysUntil = (dayOfWeek - currentDay + 7) % 7;
  if (daysUntil === 0 && target <= now) daysUntil = 7;

  target.setDate(target.getDate() + daysUntil);
  return target.toISOString();
}

function pickCategory() {
  const cats = ['promotional','seasonal','behind_the_scenes','product_feature','community','lifestyle'];
  return cats[Math.floor(Math.random() * cats.length)];
}

function base64url(data) {
  const bytes = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : new Uint8Array(data);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return new Uint8Array([...raw].map(c => c.charCodeAt(0)));
}

async function sb(env, method, path, body = null) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'apikey':         env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Prefer':         method === 'POST' ? 'return=representation' : 'return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path} → ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
