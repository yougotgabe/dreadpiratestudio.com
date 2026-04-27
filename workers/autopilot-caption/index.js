/**
 * DPS Autopilot — autopilot-caption Worker
 *
 * Generates Facebook post captions using the Claude API.
 * Callable on demand (client pre-generates) or by the scheduler
 * (auto-generation 24hrs before scheduled post time).
 *
 * Routes:
 *   POST /generate   — generate a caption, returns caption + metadata
 *   POST /regenerate — regenerate with rejection feedback injected
 *
 * Env vars:
 *   ANTHROPIC_API_KEY    — sk-ant-...
 *   SUPABASE_URL         — https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY — service_role key
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Post category → caption style guidance
const CATEGORY_GUIDANCE = {
  promotional: {
    label: 'Promotional',
    style: 'Focus on the offer, create urgency, include a clear call to action. Keep it punchy and benefit-led.',
    avoid: 'Vague language, passive voice, burying the offer.',
  },
  seasonal: {
    label: 'Seasonal / Holiday',
    style: 'Tie the post to the season or holiday naturally. Warm, timely, and community-oriented. Light sell if any.',
    avoid: 'Generic holiday copy that could apply to any business.',
  },
  behind_the_scenes: {
    label: 'Behind the Scenes',
    style: 'Authentic, personal, conversational. Give people a peek at the real people and process behind the business.',
    avoid: 'Overly polished or corporate language. This should feel human.',
  },
  product_feature: {
    label: 'Product / Menu Feature',
    style: 'Make the product the hero. Describe it vividly — sensory details work well. Include a soft CTA.',
    avoid: 'Listing features without painting a picture. Dry product descriptions.',
  },
  community: {
    label: 'Community',
    style: 'Celebrate the local community, customers, or a cause. Inclusive, warm, genuine.',
    avoid: 'Anything that sounds like marketing. This post should feel like a neighbor talking.',
  },
  event: {
    label: 'Event Announcement',
    style: 'Lead with the event name and date. Build excitement. Include all essential details: what, when, where.',
    avoid: 'Burying the date. Vague "come join us" copy without specifics.',
  },
  lifestyle: {
    label: 'Lifestyle / Mood',
    style: 'Aspirational but grounded. Paint a scene or feeling associated with the brand. Minimal direct selling.',
    avoid: 'Hard sell. This post is about brand identity, not a specific product.',
  },
  testimonial: {
    label: 'Customer Story',
    style: 'Let the customer be the voice. If no specific testimonial, write as if sharing a customer experience. Warm and specific.',
    avoid: 'Generic praise. Vague "our customers love us" language.',
  },
};

// Plan → max attempts mapping
const PLAN_MAX_ATTEMPTS = {
  starter: 3,
  growth:  4,
  daily:   5,
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const path = new URL(request.url).pathname;

    try {
      if (path === '/generate' && request.method === 'POST') {
        return handleGenerate(request, env, false);
      }
      if (path === '/regenerate' && request.method === 'POST') {
        return handleGenerate(request, env, true);
      }
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('Caption worker error:', err);
      return json({ error: 'Internal server error', detail: err.message }, 500);
    }
  },
};

// ─── Core handler (shared by generate + regenerate) ───────────────────────────

async function handleGenerate(request, env, isRegeneration) {
  const body = await request.json();

  // Required: client_id, post_category, scheduled_for
  // Optional on regen: post_id (the rejected post), rejection feedback fields
  const {
    client_id,
    post_category,
    scheduled_for,
    post_id,              // the rejected post_id (regeneration only)
    image_feedback,       // array of image feedback keys
    caption_feedback,     // array of caption feedback keys
    rejection_notes,      // client freetext
  } = body;

  if (!client_id || !post_category || !scheduled_for) {
    return json({ error: 'Missing required fields: client_id, post_category, scheduled_for' }, 400);
  }

  if (!CATEGORY_GUIDANCE[post_category]) {
    return json({ error: `Unknown post_category: ${post_category}` }, 400);
  }

  // ── Load client data from Supabase ────────────────────────────────────────

  const [clientRows, profileRows, recentPosts, feedbackHistory] = await Promise.all([
    supabase(env, 'GET', `/rest/v1/clients?id=eq.${client_id}&select=id,plan,email&limit=1`),
    supabase(env, 'GET', `/rest/v1/brand_profiles?client_id=eq.${client_id}&limit=1`),
    getRecentPosts(env, client_id),
    getFeedbackHistory(env, client_id),
  ]);

  if (!clientRows?.length) return json({ error: 'Client not found' }, 404);
  if (!profileRows?.length) return json({ error: 'Brand profile not found — onboarding incomplete' }, 400);

  const client = clientRows[0];
  const profile = profileRows[0];
  const maxAttempts = PLAN_MAX_ATTEMPTS[client.plan] || 3;

  // ── Check attempt limit (regeneration only) ───────────────────────────────

  if (isRegeneration && post_id) {
    const postRows = await supabase(env, 'GET',
      `/rest/v1/posts?id=eq.${post_id}&select=attempt_number,max_attempts&limit=1`
    );
    const post = postRows?.[0];
    if (post && post.attempt_number >= post.max_attempts) {
      return json({
        error: 'attempt_limit_reached',
        message: `This post has reached its maximum of ${post.max_attempts} attempts.`,
        manual_mode: true,
      }, 400);
    }
  }

  // ── Build the prompt ──────────────────────────────────────────────────────

  const systemPrompt = buildSystemPrompt(profile, client.plan);
  const userPrompt = buildUserPrompt({
    profile,
    post_category,
    scheduled_for,
    recentPosts,
    feedbackHistory,
    isRegeneration,
    image_feedback,
    caption_feedback,
    rejection_notes,
  });

  // ── Call Claude API ───────────────────────────────────────────────────────

  let caption;
  try {
    caption = await callClaude(env, systemPrompt, userPrompt);
  } catch (err) {
    console.error('Claude API error:', err);
    return json({ error: 'Caption generation failed', detail: err.message }, 502);
  }

  // ── Create / update post row in Supabase ──────────────────────────────────

  let newPostId;
  let attemptNumber = 1;

  if (isRegeneration && post_id) {
    // Mark previous attempt as no longer latest
    await supabase(env, 'PATCH',
      `/rest/v1/posts?id=eq.${post_id}`,
      { is_latest_attempt: false },
      { Prefer: 'return=minimal' }
    );

    // Get current attempt number from the rejected post
    const prevPost = await supabase(env, 'GET',
      `/rest/v1/posts?id=eq.${post_id}&select=attempt_number&limit=1`
    );
    attemptNumber = (prevPost?.[0]?.attempt_number || 1) + 1;

    // Build the regeneration prompt summary for storage
    const regenPromptSummary = buildRegenPromptSummary({
      image_feedback, caption_feedback, rejection_notes
    });

    // Insert new attempt row
    const newPost = await supabase(env, 'POST', '/rest/v1/posts', {
      client_id,
      slot_id: body.slot_id || null,
      scheduled_for,
      attempt_number: attemptNumber,
      max_attempts: maxAttempts,
      is_latest_attempt: true,
      post_category,
      caption,
      caption_model: 'claude-sonnet-4-6',
      status: 'pending',
      regeneration_prompt: regenPromptSummary,
      // Carry forward image feedback so image worker can read it
      image_feedback: JSON.stringify(image_feedback || []),
      caption_feedback: JSON.stringify(caption_feedback || []),
      rejection_notes: rejection_notes || '',
    });

    newPostId = newPost?.[0]?.id;

    // Log to feedback_log
    if (newPostId) {
      await supabase(env, 'POST', '/rest/v1/feedback_log', {
        client_id,
        post_id,   // the rejected post
        event_type: 'rejected',
        image_feedback: JSON.stringify(image_feedback || []),
        caption_feedback: JSON.stringify(caption_feedback || []),
        rejection_notes: rejection_notes || '',
        caption_snapshot: body.previous_caption || '',
        image_url_snapshot: body.previous_image_url || '',
        post_category,
      });
    }

  } else {
    // Fresh generation — insert new post row
    const newPost = await supabase(env, 'POST', '/rest/v1/posts', {
      client_id,
      slot_id: body.slot_id || null,
      scheduled_for,
      attempt_number: 1,
      max_attempts: maxAttempts,
      is_latest_attempt: true,
      post_category,
      caption,
      caption_model: 'claude-sonnet-4-6',
      status: 'pending',
    });

    newPostId = newPost?.[0]?.id;
  }

  return json({
    success: true,
    post_id: newPostId,
    caption,
    attempt_number: attemptNumber,
    max_attempts: maxAttempts,
    post_category,
    is_regeneration: isRegeneration,
  });
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildSystemPrompt(profile, plan) {
  return `You are a social media copywriter for local small businesses. You write Facebook post captions that sound exactly like the business owner — authentic, specific, and never generic.

Your job is to write ONE caption per request. The caption must:
- Sound like it came from a real person, not a marketing department
- Be specific to this business — never interchangeable with another
- Match the brand voice exactly as described
- Be appropriate length for Facebook: 40–150 words typically, never more than 200
- End naturally — no hashtags unless the brand profile specifically requests them
- Never use em dashes (—) in the final copy
- Never start with "Hey [City]!" or similar generic openers

You return ONLY the caption text. No preamble, no explanation, no quotation marks around it, no "Here's your caption:" — just the caption itself, ready to copy and paste.`.trim();
}

function buildUserPrompt({
  profile,
  post_category,
  scheduled_for,
  recentPosts,
  feedbackHistory,
  isRegeneration,
  image_feedback,
  caption_feedback,
  rejection_notes,
}) {
  const guidance = CATEGORY_GUIDANCE[post_category];
  const scheduledDate = new Date(scheduled_for).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  // Build recent posts context (non-repetition)
  const recentContext = recentPosts.length > 0
    ? `\nRECENT POSTS (do not repeat these topics or themes):\n${recentPosts.map((p, i) =>
        `${i + 1}. [${p.post_category}] "${p.caption?.slice(0, 120)}..."`
      ).join('\n')}`
    : '';

  // Build feedback history context
  const captionFeedbackHistory = feedbackHistory.filter(f =>
    f.caption_feedback?.length > 0
  );
  const feedbackContext = captionFeedbackHistory.length > 0
    ? `\nPAST CAPTION FEEDBACK (patterns to avoid):\n${captionFeedbackHistory.slice(0, 5).map(f =>
        `- ${f.caption_feedback.join(', ')}${f.rejection_notes ? `: "${f.rejection_notes}"` : ''}`
      ).join('\n')}`
    : '';

  // Build regeneration context
  let regenContext = '';
  if (isRegeneration) {
    const captionIssues = caption_feedback?.length
      ? `Caption issues: ${caption_feedback.join(', ')}.`
      : '';
    const imageIssues = image_feedback?.length
      ? `(Image issues noted separately — not your concern for the caption: ${image_feedback.join(', ')}.)`
      : '';
    const notes = rejection_notes
      ? `Client's specific note: "${rejection_notes}"`
      : '';

    regenContext = `
REGENERATION REQUEST
The previous caption was rejected. Address these issues in your new version:
${captionIssues}
${imageIssues}
${notes}
Write a meaningfully different caption that fixes the identified issues while staying true to the brand voice.`.trim();
  }

  return `Write a Facebook post caption for the following business.

BUSINESS PROFILE
Name: ${profile.business_name}
Industry: ${profile.industry}
Location: ${profile.location || 'Willmar, MN area'}
About: ${profile.business_description}
Target audience: ${profile.target_audience}
Brand voice: ${profile.brand_voice}
Posting goals: ${Array.isArray(profile.posting_goals) ? profile.posting_goals.join(', ') : profile.posting_goals}
${profile.off_limits ? `Never mention or reference: ${profile.off_limits}` : ''}
${profile.extra_context ? `Additional context: ${profile.extra_context}` : ''}

POST DETAILS
Type: ${guidance.label}
Scheduled for: ${scheduledDate}
Style guidance: ${guidance.style}
Avoid: ${guidance.avoid}
${recentContext}
${feedbackContext}
${regenContext}

Write the caption now.`.trim();
}

function buildRegenPromptSummary({ image_feedback, caption_feedback, rejection_notes }) {
  const parts = [];
  if (caption_feedback?.length) parts.push(`Caption: ${caption_feedback.join(', ')}`);
  if (image_feedback?.length) parts.push(`Image: ${image_feedback.join(', ')}`);
  if (rejection_notes) parts.push(`Notes: "${rejection_notes}"`);
  return parts.join(' | ');
}

// ─── Data fetchers ────────────────────────────────────────────────────────────

async function getRecentPosts(env, client_id) {
  // Last 8 approved/published posts — used for non-repetition context
  try {
    return await supabase(env, 'GET',
      `/rest/v1/posts?client_id=eq.${client_id}&status=in.(approved,published)&is_latest_attempt=eq.true&select=post_category,caption&order=scheduled_for.desc&limit=8`
    ) || [];
  } catch { return []; }
}

async function getFeedbackHistory(env, client_id) {
  // Last 10 rejection events — used to learn caption patterns to avoid
  try {
    return await supabase(env, 'GET',
      `/rest/v1/feedback_log?client_id=eq.${client_id}&event_type=eq.rejected&select=caption_feedback,image_feedback,rejection_notes,post_category&order=created_at.desc&limit=10`
    ) || [];
  } catch { return []; }
}

// ─── Claude API call ──────────────────────────────────────────────────────────

async function callClaude(env, systemPrompt, userPrompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${err}`);
  }

  const data = await res.json();
  const caption = data.content?.[0]?.text?.trim();

  if (!caption) throw new Error('Empty response from Claude API');

  return caption;
}

// ─── Supabase helper ──────────────────────────────────────────────────────────

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
