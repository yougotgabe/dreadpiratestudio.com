/**
 * DPS Autopilot — autopilot-caption Worker
 *
 * Routes:
 *   POST /generate    — generate a caption for a post
 *   POST /regenerate  — regenerate with feedback
 *
 * Env:
 *   ANTHROPIC_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const path = new URL(request.url).pathname;

    try {
      if (path === '/generate'   && request.method === 'POST') return handleGenerate(request, env);
      if (path === '/regenerate' && request.method === 'POST') return handleRegenerate(request, env);
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('Caption worker error:', err);
      return json({ error: err.message }, 500);
    }
  }
};

// ─── Generate ─────────────────────────────────────────────────────────────────

async function handleGenerate(request, env) {
  const { post_id, post_type, manual_prompt } = await request.json();
  if (!post_id) return json({ error: 'Missing post_id' }, 400);

  const post = await getPost(post_id, env);
  if (!post) return json({ error: 'Post not found' }, 404);

  const profile = await getBrandProfile(post.client_id, env);
  if (!profile) return json({ error: 'Brand profile not found' }, 404);

  const type = post_type || post.post_category || 'general';
  const systemPrompt = buildCaptionPrompt(profile, type, manual_prompt);

  const recentApproved = await getRecentApproved(post.client_id, env, 8);
  const recentRejected = await getRecentRejected(post.client_id, env, 10);
  const messages = buildMessages(recentApproved, recentRejected);

  // Stage 1 — generate caption
  const caption = await callClaude(messages, env, systemPrompt);

  // Stage 2 — generate image prompt based on caption
  const imagePrompt = await buildImagePromptViaClaude(caption, profile, type, env);

  // Save both to post row
  await supabase(env, 'PATCH', `/rest/v1/posts?id=eq.${post_id}`, {
    caption,
    image_prompt: imagePrompt,
    status: 'pending',
    post_category: type,
  });

  return json({ success: true, caption, image_prompt: imagePrompt });
}

// ─── Regenerate ───────────────────────────────────────────────────────────────

async function handleRegenerate(request, env) {
  const { post_id, image_feedback, caption_feedback, notes } = await request.json();
  if (!post_id) return json({ error: 'Missing post_id' }, 400);

  const post = await getPost(post_id, env);
  if (!post) return json({ error: 'Post not found' }, 404);

  const profile = await getBrandProfile(post.client_id, env);
  if (!profile) return json({ error: 'Brand profile not found' }, 404);

  const type = post.post_category || 'general';
  const systemPrompt = buildCaptionPrompt(profile, type, null);

  const recentApproved = await getRecentApproved(post.client_id, env, 8);
  const recentRejected = await getRecentRejected(post.client_id, env, 10);
  const feedbackNote = buildFeedbackNote(caption_feedback, notes);
  const messages = buildMessages(recentApproved, recentRejected, feedbackNote);

  // Stage 1 — regenerate caption with feedback
  const caption = await callClaude(messages, env, systemPrompt);

  // Stage 2 — regenerate image prompt, passing image feedback as context
  const imagePrompt = await buildImagePromptViaClaude(caption, profile, type, env, image_feedback, notes);

  await supabase(env, 'PATCH', `/rest/v1/posts?id=eq.${post_id}`, {
    caption,
    image_prompt: imagePrompt,
    status: 'pending',
  });

  return json({ success: true, caption, image_prompt: imagePrompt });
}

// ─── Stage 2: Image Prompt Generation ────────────────────────────────────────

async function buildImagePromptViaClaude(caption, profile, postType, env, imageFeedback = [], notes = '') {
  const colorHints = profile.color_palette && Object.values(profile.color_palette).length
    ? `Brand colors: ${Object.values(profile.color_palette).join(', ')}.`
    : '';

  const feedbackHint = imageFeedback?.length
    ? `\nPrevious image was rejected for: ${imageFeedback.join(', ')}. Avoid these issues.`
    : '';

  const notesHint = notes ? `\nAdditional direction: ${notes}` : '';

  const systemPrompt = `You are an AI image prompt engineer. Your job is to write a single, detailed image generation prompt for a Facebook post image.

The prompt must:
- Be one paragraph, no longer than 150 words
- Describe a specific visual scene or composition that complements the caption
- Specify how the business logo should be incorporated (e.g. on a product, storefront, banner, overlay)
- Reference the brand colors if provided
- Match the mood and tone of the caption
- Be suitable for a 1:1 square social media image
- Be high quality and visually compelling
- NOT include any text overlays or words in the image (Facebook renders caption separately)

Output only the image prompt. No preamble, no explanation.`;

  const userMessage = `BUSINESS: ${profile.business_name} — ${profile.industry} in ${profile.location}
BRAND VOICE: ${profile.brand_voice || 'professional and approachable'}
${colorHints}
POST TYPE: ${postType}
CAPTION: "${caption}"
${feedbackHint}${notesHint}

Write the image generation prompt now.`;

  const imagePrompt = await callClaude(
    [{ role: 'user', content: userMessage }],
    env,
    systemPrompt,
    200
  );

  return imagePrompt;
}

// ─── Caption Prompt Building ───────────────────────────────────────────────────

function buildCaptionPrompt(profile, type, manualPrompt) {
  const typeInstructions = {
    general: `Write a natural, on-brand social media post that showcases the business personality and value. No hard sell.`,
    event:   `Write a post announcing or reminding followers about an upcoming event, special, or happening at the business.`,
    cta:     `Write a direct, energetic call-to-action post that encourages customers to visit, call, or buy. Make it feel exciting, not pushy.`,
    joke:    `Write a post that includes a clever joke or pun specifically related to the business, industry, or products. Keep it light and shareable.`,
  };

  const typeInstruction = typeInstructions[type] || typeInstructions.general;

  return `You are a social media copywriter for a local business. Write ONE Facebook post caption.

BUSINESS PROFILE:
- Name: ${profile.business_name}
- Industry: ${profile.industry}
- Location: ${profile.location}
- Description: ${profile.business_description}
- Target audience: ${profile.target_audience}
- Brand voice: ${profile.brand_voice}
- Posting goals: ${Array.isArray(profile.posting_goals) ? profile.posting_goals.join(', ') : profile.posting_goals}
- Off-limits: ${profile.off_limits || 'None'}
- Extra context: ${profile.extra_context || 'None'}

POST TYPE: ${type.toUpperCase()}
INSTRUCTION: ${typeInstruction}
${manualPrompt ? `\nCLIENT NOTES: ${manualPrompt}` : ''}

Write only the caption text. No explanations, no hashtag blocks, no "Here is your caption:" preamble. 2-4 sentences. Natural, human tone. May include 1-3 relevant emojis if appropriate for the brand voice.`;
}

function buildFeedbackNote(captionFeedback, notes) {
  const parts = [];
  if (captionFeedback?.length) parts.push(`Previous caption issues: ${captionFeedback.join(', ')}.`);
  if (notes) parts.push(`Client notes: ${notes}`);
  return parts.join(' ');
}

function buildMessages(recentApproved, recentRejected, feedbackNote = '') {
  let userContent = 'Write the Facebook post caption now.';

  if (recentApproved.length) {
    userContent += `\n\nRECENTLY APPROVED CAPTIONS (avoid repetition):\n${recentApproved.map(p => `- "${p.caption}"`).join('\n')}`;
  }

  if (recentRejected.length) {
    const rejectedSummary = recentRejected
      .filter(p => p.caption_feedback?.length || p.rejection_notes)
      .map(p => `- Rejected for: ${[...(p.caption_feedback || []), p.rejection_notes].filter(Boolean).join(', ')}`)
      .join('\n');
    if (rejectedSummary) userContent += `\n\nRECENT REJECTION PATTERNS (avoid these):\n${rejectedSummary}`;
  }

  if (feedbackNote) userContent += `\n\nFEEDBACK FOR THIS REGENERATION: ${feedbackNote}`;

  return [{ role: 'user', content: userContent }];
}

// ─── Claude API ───────────────────────────────────────────────────────────────

async function callClaude(messages, env, systemPrompt, maxTokens = 300) {
  const body = {
    model: 'claude-3-5-haiku-20241022',
    max_tokens: maxTokens,
    messages,
  };
  if (systemPrompt) body.system = systemPrompt;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error: ${err}`);
  }

  const data = await res.json();
  return data.content[0].text.trim();
}

// ─── Supabase Helpers ─────────────────────────────────────────────────────────

async function getPost(postId, env) {
  const rows = await supabase(env, 'GET', `/rest/v1/posts?id=eq.${postId}&select=*&limit=1`);
  return Array.isArray(rows) ? rows[0] : null;
}

async function getBrandProfile(clientId, env) {
  const rows = await supabase(env, 'GET', `/rest/v1/brand_profiles?client_id=eq.${clientId}&select=*&limit=1`);
  return Array.isArray(rows) ? rows[0] : null;
}

async function getRecentApproved(clientId, env, limit) {
  const rows = await supabase(env, 'GET',
    `/rest/v1/posts?client_id=eq.${clientId}&status=eq.approved&order=created_at.desc&limit=${limit}&select=caption`
  );
  return Array.isArray(rows) ? rows.filter(p => p.caption) : [];
}

async function getRecentRejected(clientId, env, limit) {
  const rows = await supabase(env, 'GET',
    `/rest/v1/posts?client_id=eq.${clientId}&status=eq.rejected&order=created_at.desc&limit=${limit}&select=caption,caption_feedback,rejection_notes`
  );
  return Array.isArray(rows) ? rows : [];
}

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
