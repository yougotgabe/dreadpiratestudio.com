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
  const { post_id, post_type, manual_prompt, include_logo = true, color_palette = null, featured_product = null } = await request.json();
  if (!post_id) return json({ error: 'Missing post_id' }, 400);

  const post = await getPost(post_id, env);
  if (!post) return json({ error: 'Post not found' }, 404);

  const profile = await getBrandProfile(post.client_id, env);
  if (!profile) return json({ error: 'Brand profile not found' }, 404);

  const type = post_type || post.post_category || 'general';

  const sheetContext = await fetchSheetContext(profile, type, env);
  const systemPrompt = buildCaptionPrompt(profile, type, manual_prompt, sheetContext, featured_product);

  const recentApproved = await getRecentApproved(post.client_id, env, 8);
  const recentRejected = await getRecentRejected(post.client_id, env, 10);
  const messages = buildMessages(recentApproved, recentRejected);

  const caption = await callClaude(messages, env, systemPrompt);

  // Use per-generation color palette if provided, else fall back to brand profile
  const effectivePalette = color_palette !== null ? color_palette : (profile.color_palette || null);
  const imagePrompt = await buildImagePromptViaClaude(caption, profile, type, env, [], '', include_logo, effectivePalette);

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
  const { post_id, image_feedback, caption_feedback, notes, post_type, include_logo = true, color_palette = null, featured_product = null } = await request.json();
  if (!post_id) return json({ error: 'Missing post_id' }, 400);

  const post = await getPost(post_id, env);
  if (!post) return json({ error: 'Post not found' }, 404);

  const profile = await getBrandProfile(post.client_id, env);
  if (!profile) return json({ error: 'Brand profile not found' }, 404);

  const type = post_type || post.post_category || 'general';

  const sheetContext = await fetchSheetContext(profile, type, env);
  const systemPrompt = buildCaptionPrompt(profile, type, null, sheetContext, featured_product);

  const recentApproved = await getRecentApproved(post.client_id, env, 8);
  const recentRejected = await getRecentRejected(post.client_id, env, 10);
  const feedbackNote = buildFeedbackNote(caption_feedback, notes);
  const messages = buildMessages(recentApproved, recentRejected, feedbackNote);

  const caption = await callClaude(messages, env, systemPrompt);

  const effectivePalette = color_palette !== null ? color_palette : (profile.color_palette || null);
  const imagePrompt = await buildImagePromptViaClaude(caption, profile, type, env, image_feedback, notes, include_logo, effectivePalette);

  await supabase(env, 'PATCH', `/rest/v1/posts?id=eq.${post_id}`, {
    caption,
    image_prompt: imagePrompt,
    status: 'pending',
  });

  return json({ success: true, caption, image_prompt: imagePrompt });
}

// ─── Stage 2: Image Prompt Generation ────────────────────────────────────────

async function buildImagePromptViaClaude(caption, profile, postType, env, imageFeedback = [], notes = '', includeLogo = true, colorPalette = null) {
  // colorPalette is either null (no colors) or { key: hex } object of selected colors
  const colorEntries = colorPalette && Object.keys(colorPalette).length
    ? Object.entries(colorPalette).map(([k, v]) => `${k}: ${v}`).join(', ')
    : null;

  const feedbackSection = imageFeedback?.length
    ? `\nPREVIOUS IMAGE REJECTION — the client rejected the last image for these specific reasons. Every point is a hard rule for this generation:\n${imageFeedback.map(f => `- ${f}`).join('\n')}`
    : '';

  const notesSection = notes
    ? `\nCLIENT DIRECTION — incorporate all of the following into the image concept. These are directives, not suggestions:\n${notes}`
    : '';

  const logoInstruction = includeLogo
    ? `- The business logo must appear EXACTLY ONCE in the image — no more. Place it naturally in the scene (e.g. on signage, embossed on a surface, as a watermark in one corner). Never duplicate or repeat the logo anywhere else in the image.`
    : `- Do NOT include the business logo anywhere in the image.`;

  const colorInstruction = colorEntries
    ? `- If brand colors are provided, describe how they should appear dominantly in the scene — not as decoration but as the actual color palette of the environment, objects, and lighting`
    : `- Use natural, complementary colors appropriate to the scene. Do not force any specific brand palette.`;

  const systemPrompt = `You are an expert AI image prompt engineer specializing in social media visuals for local businesses. Your job is to write a single, detailed image generation prompt that will produce a high-quality Facebook post image.

Your prompt must follow these rules:
- One paragraph, maximum 150 words
- Describe a specific, concrete visual scene or composition — not vague concepts
${logoInstruction}
${colorInstruction}
- The mood, lighting, and energy of the image must match the caption's tone precisely
- Square 1:1 composition optimized for Facebook
- Photorealistic or high-quality illustration style unless the brand voice suggests otherwise
- No text, words, letters, or numbers anywhere in the image — the caption handles all text
- No generic stock photo feel — the image should look specific to this business

Output only the image prompt. No preamble, no explanation, no label.`;

  const userMessage = `BUSINESS: ${profile.business_name}
INDUSTRY: ${profile.industry}
LOCATION: ${profile.location}
BRAND VOICE: ${profile.brand_voice || 'professional and approachable'}
${colorEntries ? `BRAND COLORS — use these as the dominant palette of the image, not as accents:\n${colorEntries}` : ''}

POST TYPE: ${postType}

CAPTION — the image must complement and elevate this specific caption. Study the tone, subject matter, and energy before deciding on the visual:
"${caption}"
${feedbackSection}${notesSection}

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

function buildCaptionPrompt(profile, type, manualPrompt, sheetContext = null, featuredProduct = null) {
  const typeInstructions = {
    general:           `Write a natural, on-brand post that showcases the business personality and value. No hard sell — let the voice do the work. The goal is to feel like a real person wrote this, not a marketing department.${sheetContext ? ' If a product or service from the offerings list feels natural to reference, do so — but only if it flows with the voice.' : ''}`,
    event:             `Write a post announcing or building anticipation for an upcoming event, special, or happening at the business. Create genuine excitement — give people a reason to show up or pay attention.`,
    cta:               `Write a direct, energetic call-to-action post that motivates customers to visit, call, or buy right now. The urgency should feel real and exciting, never desperate or pushy.${sheetContext ? ' Pick ONE specific product, service, or deal from the offerings list and make it the focus of the CTA. Name it specifically, mention the price if it reinforces urgency. End with a clear next step.' : ' End with a clear next step.'}`,
    joke:              `Write a post built around a clever joke or pun that is specifically tied to this business, its industry, or its products/services.${sheetContext ? ' Use a real product or service name from the offerings list as the punchline setup or subject of the joke.' : ''} The humor should feel natural and shareable — not forced.`,
    product_spotlight: `Write a post that puts ONE specific product or service in the spotlight. This post lives or dies by how well it makes one thing sound irresistible. Name it. Describe what makes it special. Mention the price naturally if it fits. The entire post is about this one thing — do not dilute it with other offerings or generic brand messaging.`,
  };

  const typeInstruction = typeInstructions[type] || typeInstructions.general;

  const goalsStr = Array.isArray(profile.posting_goals)
    ? profile.posting_goals.join(', ')
    : (profile.posting_goals || '');

  const colorStr = profile.color_palette && Object.keys(profile.color_palette).length
    ? Object.entries(profile.color_palette).map(([k, v]) => `${k}: ${v}`).join(', ')
    : null;

  // Build example posts section
  let exampleSection = '';
  if (profile.example_posts && profile.example_posts.trim()) {
    exampleSection = `
EXAMPLE POSTS BY TYPE — use these to calibrate voice, rhythm, and style. Do not repeat them verbatim. Study the sentence structure, tone, and personality and apply that same feel to the new post:
${profile.example_posts}`;
  }

  // Build sheet section with type-aware instructions
  const sheetSection = sheetContext ? buildSheetSection(type, sheetContext, featuredProduct) : '';

  return `You are a social media copywriter working for a local business. Your job is to write ONE Facebook post caption that sounds exactly like this specific business — not a generic small business, not a template, this one.

━━ WHO THIS BUSINESS IS ━━
Business name: ${profile.business_name}
Industry: ${profile.industry}
Location: ${profile.location}
What they do: ${profile.business_description}
${colorStr ? `Brand colors: ${colorStr} — reference these for visual consistency if relevant` : ''}
Website: ${profile.website || 'Not provided'}

━━ THEIR AUDIENCE ━━
Write as if speaking directly to this specific group of people — use their vocabulary, speak to their concerns, and give them a reason to care:
${profile.target_audience}

━━ BRAND VOICE ━━
Apply this voice consistently — not just in word choice but in sentence rhythm, punctuation style, energy level, and how ideas are sequenced. This is the personality of every post:
${profile.brand_voice}

━━ WHAT POSTS SHOULD ACCOMPLISH ━━
Every post must serve at least one of these goals. Do not write a post that doesn't connect to any of them:
${goalsStr}

━━ HARD RULES — NEVER VIOLATE THESE ━━
Regardless of post type, client notes, or any other instruction — never include any of the following:
${profile.off_limits || 'None specified'}

━━ EXTRA CONTEXT ━━
This is background knowledge that should inform the writing without necessarily appearing in every post. Use it to make the content feel specific and real:
${profile.extra_context || 'None provided'}
${exampleSection}${sheetSection}

━━ THIS POST ━━
Post type: ${type.toUpperCase()}
What this post needs to do: ${typeInstruction}
${manualPrompt ? `\nCLIENT DIRECTION FOR THIS POST — incorporate all of the following naturally. These are directives, not suggestions. Do not ignore any part of this:\n${manualPrompt}` : ''}

━━ OUTPUT RULES ━━
- Write only the caption text — no preamble, no explanation, no "Here is your caption:"
- 2–4 sentences
- No hashtag blocks
- Natural, human tone — reads like a real person wrote it
- May include 1–3 relevant emojis only if they fit the brand voice naturally
${profile.website ? `- End the post with the business website URL on its own line: ${profile.website}` : ''}`;
}

function buildSheetSection(type, sheetContext, featuredProduct = null) {
  // Event posts don't benefit from product data
  if (type === 'event') return '';

  const instructions = {
    product_spotlight: featuredProduct
      ? `━━ FEATURED PRODUCT / SERVICE ━━
The client has specifically chosen this item to spotlight. The entire post must be about THIS ONE item. Name it. Describe what makes it worth caring about. Mention the price naturally if it fits the voice. Do not reference other products.

FEATURED ITEM:
${featuredProduct}

FULL OFFERINGS LIST (for context only — do not feature other items):
${sheetContext}`
      : `━━ PRODUCTS & OFFERINGS — PICK ONE TO SPOTLIGHT ━━
Select ONE item from this list that would make the most compelling post right now — something that sounds interesting, unique, or seasonal. The entire post must be built around that single item. Name it specifically. Describe what makes it worth trying or buying. Mention the price naturally if it supports the post. Do not reference multiple items.

${sheetContext}`,

    cta: featuredProduct
      ? `━━ FEATURED ITEM FOR THIS CTA ━━
The client wants to drive action around this specific item. Build the CTA around it — name it, create urgency, end with a next step.

FEATURED ITEM:
${featuredProduct}

FULL OFFERINGS (for supporting context):
${sheetContext}`
      : `━━ PRODUCTS & OFFERINGS — PICK ONE FOR YOUR CTA ━━
Choose ONE item from this list to make the focus of your call-to-action. Pick something that would motivate people to act — a good deal, a popular item, or something seasonal. Name it specifically and build urgency around it.

${sheetContext}`,

    joke: `━━ PRODUCTS & OFFERINGS — USE FOR JOKE MATERIAL ━━
These are real products and services at this business. Use a specific item name, price, or category as the subject or punchline of your joke. The funnier and more specific to the actual business the better.
${featuredProduct ? `\nThe client suggests using this item: ${featuredProduct}\n` : ''}
${sheetContext}`,

    general: `━━ PRODUCTS & OFFERINGS — OPTIONAL REFERENCE ━━
If it feels natural and unforced, you may reference a specific product, service, or price point from this list to make the post feel more real and specific. Do not force it — only use it if it strengthens the post.
${featuredProduct ? `\nThe client suggests referencing: ${featuredProduct}\n` : ''}
${sheetContext}`,
  };

  return '\n\n' + (instructions[type] || instructions.general);
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
    userContent += `\n\nRECENTLY APPROVED CAPTIONS — the client liked these. Do not repeat them, but use them to understand what resonates:\n${recentApproved.map(p => `- "${p.caption}"`).join('\n')}`;
  }

  if (recentRejected.length) {
    const rejectedSummary = recentRejected
      .filter(p => p.caption_feedback?.length || p.rejection_notes)
      .map(p => `- Rejected for: ${[...(p.caption_feedback || []), p.rejection_notes].filter(Boolean).join(', ')}`)
      .join('\n');
    if (rejectedSummary) userContent += `\n\nRECENT REJECTION PATTERNS — the client explicitly did not like these things. Treat them as hard rules for this generation:\n${rejectedSummary}`;
  }

  if (feedbackNote) {
    userContent += `\n\nCLIENT FEEDBACK ON THE PREVIOUS ATTEMPT — the client reviewed the last generation and specifically requested these changes. Treat every point as a directive:\n${feedbackNote}`;
  }

  return [{ role: 'user', content: userContent }];
}

// ─── Sheet Context ────────────────────────────────────────────────────────────

// Sheet types and which post types benefit from product context
const SHEET_RELEVANT_TYPES = ['general', 'cta', 'event', 'joke'];

const SHEET_CONFIGS = {
  restaurant: {
    label: 'Restaurant / Café / Bar',
    columns: ['Category', 'Item', 'Description', 'Price', 'Notes'],
    prompt: 'Menu items, specials, and pricing',
  },
  retail: {
    label: 'Retail Shop',
    columns: ['Category', 'Product', 'Description', 'Price', 'Sale Price'],
    prompt: 'Products and pricing',
  },
  salon: {
    label: 'Salon / Spa / Barber',
    columns: ['Service', 'Description', 'Duration', 'Price', 'Add-ons'],
    prompt: 'Services and pricing',
  },
  fitness: {
    label: 'Fitness / Gym / Studio',
    columns: ['Offering', 'Description', 'Price', 'Schedule', 'Notes'],
    prompt: 'Memberships, classes, and pricing',
  },
  auto: {
    label: 'Auto Service',
    columns: ['Service', 'Description', 'Starting Price', 'Duration', 'Notes'],
    prompt: 'Services and pricing',
  },
  contractor: {
    label: 'Contractor / Trade',
    columns: ['Service', 'Description', 'Starting Rate', 'Notes'],
    prompt: 'Services and rates',
  },
  professional: {
    label: 'Professional Services',
    columns: ['Service', 'Description', 'Rate / Package', 'Notes'],
    prompt: 'Services and rates',
  },
};

async function fetchSheetContext(profile, postType, env) {
  if (!profile.sheet_url) return null;

  let csvUrl;
  try {
    const match = profile.sheet_url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!match) return null;
    const sheetId = match[1];
    // Extract gid if present (identifies which tab)
    const gidMatch = profile.sheet_url.match(/[#&?]gid=(\d+)/);
    const gid = gidMatch ? gidMatch[1] : '0';
    csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  } catch(e) {
    console.warn('Could not parse sheet URL:', e.message);
    return null;
  }

  try {
    const res = await fetch(csvUrl, {
      headers: { 'User-Agent': 'DPS-Autopilot/1.0' },
      redirect: 'follow',
    });
    if (!res.ok) {
      console.warn('Sheet fetch failed:', res.status);
      return null;
    }
    const csv = await res.text();
    return parseSheetToContext(csv, profile.sheet_type);
  } catch(e) {
    console.warn('Sheet fetch error:', e.message);
    return null;
  }
}

function parseSheetToContext(csv, sheetType) {
  const lines = csv.split('\n').filter(l => l.trim());
  if (lines.length < 2) return null;

  // Parse CSV rows (handle quoted fields)
  const parseRow = line => {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    result.push(current.trim());
    return result;
  };

  const headers = parseRow(lines[0]);
  const rows = lines.slice(1).map(parseRow).filter(r => r.some(c => c));

  if (!rows.length) return null;

  // Format as readable context — limit to 30 items to keep tokens reasonable
  const config = SHEET_CONFIGS[sheetType];
  const label = config ? config.label : 'Products & Services';

  const formatted = rows.slice(0, 30).map(row => {
    return headers.map((h, i) => {
      const val = row[i] || '';
      return val ? `${h}: ${val}` : null;
    }).filter(Boolean).join(' | ');
  }).filter(Boolean).join('\n');

  if (!formatted) return null;

  return `[${label}]\n${formatted}`;
}

// ─── Claude API ───────────────────────────────────────────────────────────────

async function callClaude(messages, env, systemPrompt, maxTokens = 300) {
  const body = {
    model: 'claude-haiku-4-5-20251001',
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
