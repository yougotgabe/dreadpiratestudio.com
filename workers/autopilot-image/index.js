/**
 * DPS Autopilot — autopilot-image Worker
 *
 * Generates branded scene images using OpenAI's gpt-image-2 model.
 * Takes a post_id, fetches the brand profile + assigned asset,
 * builds a cinematic scene prompt, sends the logo as a reference
 * image via the edits endpoint, uploads the result to Supabase
 * Storage, and updates the post row with the image URL.
 *
 * Routes:
 *   POST /generate   — generate image for a post_id
 *   POST /regenerate — regenerate with image feedback injected
 *
 * Env vars:
 *   OPENAI_API_KEY         — sk-...
 *   SUPABASE_URL           — https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY   — service_role key
 *   SUPABASE_IMAGE_BUCKET  — "generated-images"
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Post category → scene generation guidance
const CATEGORY_SCENES = {
  promotional: {
    mood: 'bold, eye-catching, energetic',
    scene: 'a vibrant storefront or product display with warm inviting lighting',
    lighting: 'bright, high-contrast, punchy',
  },
  seasonal: {
    mood: 'warm, festive, timely',
    scene: 'a cozy seasonal setting with appropriate holiday or seasonal atmosphere',
    lighting: 'warm golden tones, soft and inviting',
  },
  behind_the_scenes: {
    mood: 'authentic, candid, human',
    scene: 'a real working environment — kitchen, workshop, or storefront in action',
    lighting: 'natural, candid, slightly imperfect — real not staged',
  },
  product_feature: {
    mood: 'clean, appetizing, focused',
    scene: 'a hero product shot with beautiful styling and a complementary background',
    lighting: 'soft studio lighting, product is the clear focal point',
  },
  community: {
    mood: 'warm, inclusive, neighborly',
    scene: 'a welcoming local scene — main street, community gathering, or friendly interaction',
    lighting: 'golden hour or soft daylight, warm and approachable',
  },
  event: {
    mood: 'exciting, anticipatory, celebratory',
    scene: 'a festive event atmosphere with energy and excitement',
    lighting: 'dynamic, celebratory, could include string lights or evening ambiance',
  },
  lifestyle: {
    mood: 'aspirational, relaxed, authentic',
    scene: 'a lifestyle moment that embodies the brand — relaxed, real, and relatable',
    lighting: 'natural light, airy, candid feel',
  },
  testimonial: {
    mood: 'genuine, warm, trustworthy',
    scene: 'a satisfied customer moment — warm interaction or a happy scene related to the business',
    lighting: 'soft, natural, approachable',
  },
  manual: {
    mood: 'versatile, on-brand',
    scene: 'a clean branded scene appropriate for the business',
    lighting: 'balanced, professional',
  },
};

// Image feedback keys → prompt adjustments
const IMAGE_FEEDBACK_ADJUSTMENTS = {
  wrong_mood:    'Create a completely different mood and atmosphere from the previous attempt.',
  wrong_colors:  'Use a different color palette that better suits the brand.',
  logo_issue:    'Ensure the logo area is clean and unobstructed.',
  too_busy:      'Simplify the composition — less elements, more breathing room.',
  too_plain:     'Add more visual interest, texture, and depth to the scene.',
  wrong_setting: 'Use a completely different location or setting for the scene.',
  other:         'Take a fresh creative direction different from the previous attempt.',
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
      console.error('Image worker error:', err);
      return json({ error: 'Internal server error', detail: err.message }, 500);
    }
  },
};

// ─── Core handler ─────────────────────────────────────────────────────────────

async function handleGenerate(request, env, isRegeneration) {
  const body = await request.json();
  const { post_id, image_feedback } = body;

  if (!post_id) return json({ error: 'Missing required field: post_id' }, 400);

  // ── Load post + brand data ────────────────────────────────────────────────

  const postRows = await supabase(env, 'GET',
    `/rest/v1/posts?id=eq.${post_id}&select=id,client_id,post_category,caption,asset_used_id,attempt_number,max_attempts,status&limit=1`
  );

  if (!postRows?.length) return json({ error: 'Post not found' }, 404);
  const post = postRows[0];

  if (post.status === 'published') {
    return json({ error: 'Post already published — cannot regenerate image' }, 400);
  }

  const [profileRows, assetRows, feedbackHistory] = await Promise.all([
    supabase(env, 'GET',
      `/rest/v1/brand_profiles?client_id=eq.${post.client_id}&select=business_name,industry,location,brand_voice,color_palette&limit=1`
    ),
    getAssetForPost(env, post.client_id, post.post_category, post.asset_used_id),
    getImageFeedbackHistory(env, post.client_id),
  ]);

  if (!profileRows?.length) {
    return json({ error: 'Brand profile not found' }, 400);
  }

  const profile = profileRows[0];
  const asset   = assetRows;

  // ── Build scene prompt ────────────────────────────────────────────────────

  const scenePrompt = buildScenePrompt({
    profile,
    post_category: post.post_category,
    caption: post.caption,
    isRegeneration,
    image_feedback,
    feedbackHistory,
  });

  console.log(`Generating image for post ${post_id}, category: ${post.post_category}`);
  console.log('Prompt:', scenePrompt.slice(0, 200) + '...');

  // ── Call OpenAI Image API ─────────────────────────────────────────────────

  let imageBase64;
  let imagePromptUsed = scenePrompt;

  try {
    if (asset?.public_url) {
      // Use edits endpoint with logo as reference image
      ({ imageBase64, imagePromptUsed } = await generateWithReference(
        env, scenePrompt, asset.public_url
      ));
    } else {
      // No asset — use generations endpoint with text prompt only
      ({ imageBase64, imagePromptUsed } = await generateFromText(
        env, scenePrompt
      ));
    }
  } catch (err) {
    console.error('OpenAI API error:', err);
    return json({ error: 'Image generation failed', detail: err.message }, 502);
  }

  // ── Upload to Supabase Storage ────────────────────────────────────────────

  const bucket    = env.SUPABASE_IMAGE_BUCKET || 'generated-images';
  const fileName  = `${post.client_id}/${post_id}-${Date.now()}.png`;
  const imageBytes = Uint8Array.from(atob(imageBase64), c => c.charCodeAt(0));

  const uploadRes = await fetch(
    `${env.SUPABASE_URL}/storage/v1/object/${bucket}/${fileName}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        apikey: env.SUPABASE_SERVICE_KEY,
        'Content-Type': 'image/png',
        'x-upsert': 'true',
      },
      body: imageBytes,
    }
  );

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    console.error('Storage upload failed:', err);
    return json({ error: 'Image upload to storage failed', detail: err }, 500);
  }

  const publicUrl = `${env.SUPABASE_URL}/storage/v1/object/public/${bucket}/${fileName}`;

  // ── Update post row with image URL ────────────────────────────────────────

  await supabase(env, 'PATCH',
    `/rest/v1/posts?id=eq.${post_id}`,
    {
      image_url:          publicUrl,
      image_storage_path: fileName,
      image_prompt:       imagePromptUsed,
      asset_used_id:      asset?.id || null,
      status:             'pending',
      updated_at:         new Date().toISOString(),
    },
    { Prefer: 'return=minimal' }
  );

  // ── Save to rolling generated_images library ──────────────────────────────

  const fileSizeKb = Math.round(imageBytes.length / 1024);

  await supabase(env, 'POST', '/rest/v1/generated_images', {
    client_id:     post.client_id,
    post_id:       post_id,
    storage_path:  fileName,
    public_url:    publicUrl,
    file_size_kb:  fileSizeKb,
    post_category: post.post_category,
    asset_used_id: asset?.id || null,
    image_prompt:  imagePromptUsed,
  });
  // The rolling 5-image trigger fires automatically in Supabase

  console.log(`Image generated and saved for post ${post_id}: ${publicUrl}`);

  return json({
    success:       true,
    post_id,
    image_url:     publicUrl,
    asset_used:    asset ? { id: asset.id, label: asset.asset_label } : null,
    prompt_used:   imagePromptUsed,
    file_size_kb:  fileSizeKb,
  });
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildScenePrompt({ profile, post_category, caption, isRegeneration, image_feedback, feedbackHistory }) {
  const category = CATEGORY_SCENES[post_category] || CATEGORY_SCENES.manual;
  const colors   = profile.color_palette
    ? (() => {
        try {
          const p = typeof profile.color_palette === 'string'
            ? JSON.parse(profile.color_palette)
            : profile.color_palette;
          return [p.primary, p.secondary, p.accent].filter(Boolean).join(', ');
        } catch { return ''; }
      })()
    : '';

  // Build feedback adjustments for regeneration
  let feedbackAdjustments = '';
  if (isRegeneration && image_feedback?.length) {
    const adjustments = image_feedback
      .map(key => IMAGE_FEEDBACK_ADJUSTMENTS[key])
      .filter(Boolean)
      .join(' ');
    feedbackAdjustments = `\n\nIMPORTANT CHANGES FROM PREVIOUS ATTEMPT: ${adjustments}`;
  }

  // Build historical pattern avoidance
  const pastImageFeedback = feedbackHistory
    .flatMap(f => f.image_feedback || [])
    .filter(Boolean);
  const avoidPatterns = [...new Set(pastImageFeedback)]
    .map(key => IMAGE_FEEDBACK_ADJUSTMENTS[key])
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');

  const historyNote = avoidPatterns
    ? `\nAvoid these patterns that have not worked well previously: ${avoidPatterns}`
    : '';

  return `Create a cinematic, photorealistic social media image for ${profile.business_name}, a ${profile.industry} business in ${profile.location || 'the Midwest'}.

Scene: ${category.scene}
Mood: ${category.mood}
Lighting: ${category.lighting}
${colors ? `Brand colors to incorporate subtly: ${colors}` : ''}

The image should visually complement this post caption: "${caption?.slice(0, 150) || ''}"

Composition rules:
- Leave the bottom third of the image with a clean area where text could overlay
- No text, words, or logos in the generated scene itself
- Cinematic quality, warm and inviting, feels authentic not stock-photo
- Square format, 1:1 ratio
- Avoid clichéd stock photography aesthetics
${historyNote}${feedbackAdjustments}

The final image will have the business logo composited on top separately — do not attempt to include or represent any logo in the scene.`.trim();
}

// ─── OpenAI API calls ─────────────────────────────────────────────────────────

async function generateWithReference(env, prompt, logoUrl) {
  // Fetch the logo image to send as reference
  const logoRes = await fetch(logoUrl);
  if (!logoRes.ok) {
    console.warn('Could not fetch logo, falling back to text-only generation');
    return generateFromText(env, prompt);
  }

  const logoBytes  = await logoRes.arrayBuffer();
  const logoType   = logoRes.headers.get('content-type') || 'image/png';
  const ext        = logoType.includes('png') ? 'png'
                   : logoType.includes('webp') ? 'webp'
                   : 'jpeg';

  // Build multipart form for the edits endpoint
  // gpt-image-2 edits: send the logo as the reference image + mask optional
  const formData = new FormData();
  formData.append('model', 'gpt-image-2');
  formData.append('prompt', prompt);
  formData.append('size', '1024x1024');
  formData.append('quality', 'high');
  formData.append('n', '1');
  formData.append('image',
    new Blob([logoBytes], { type: logoType }),
    `logo.${ext}`
  );

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('OpenAI edits error:', err);
    // Fall back to text-only if edits fails (e.g. logo format unsupported)
    console.warn('Falling back to text-only generation');
    return generateFromText(env, prompt);
  }

  const data = await res.json();
  const imageBase64 = data.data?.[0]?.b64_json;
  if (!imageBase64) throw new Error('No image data returned from OpenAI edits endpoint');

  return { imageBase64, imagePromptUsed: prompt };
}

async function generateFromText(env, prompt) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model:   'gpt-image-2',
      prompt,
      size:    '1024x1024',
      quality: 'high',
      n:       1,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI generations error: ${err}`);
  }

  const data = await res.json();
  const imageBase64 = data.data?.[0]?.b64_json;
  if (!imageBase64) throw new Error('No image data returned from OpenAI generations endpoint');

  return { imageBase64, imagePromptUsed: prompt };
}

// ─── Asset selection ──────────────────────────────────────────────────────────

async function getAssetForPost(env, client_id, post_category, preferred_asset_id) {
  // If a specific asset was already assigned, use it
  if (preferred_asset_id) {
    const rows = await supabase(env, 'GET',
      `/rest/v1/brand_assets?id=eq.${preferred_asset_id}&is_active=eq.true&select=id,public_url,asset_label,asset_type&limit=1`
    );
    if (rows?.length) return rows[0];
  }

  // Otherwise find the best asset for this post category
  // First try: asset assigned to this category
  const assigned = await supabase(env, 'GET',
    `/rest/v1/brand_assets?client_id=eq.${client_id}&is_active=eq.true&select=id,public_url,asset_label,asset_type,assigned_post_categories&order=sort_order.asc`
  );

  if (assigned?.length) {
    // Find one assigned to this category
    const match = assigned.find(a => {
      try {
        const cats = typeof a.assigned_post_categories === 'string'
          ? JSON.parse(a.assigned_post_categories)
          : (a.assigned_post_categories || []);
        return cats.includes(post_category);
      } catch { return false; }
    });
    if (match) return match;

    // Fall back to primary logo
    const primary = assigned.find(a => a.asset_type === 'logo_primary');
    if (primary) return primary;

    // Fall back to first active asset
    return assigned[0];
  }

  return null;
}

async function getImageFeedbackHistory(env, client_id) {
  try {
    return await supabase(env, 'GET',
      `/rest/v1/feedback_log?client_id=eq.${client_id}&event_type=eq.rejected&select=image_feedback&order=created_at.desc&limit=10`
    ) || [];
  } catch { return []; }
}

// ─── Supabase helper ──────────────────────────────────────────────────────────

async function supabase(env, method, path, body = null, extraHeaders = {}) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey:          env.SUPABASE_SERVICE_KEY,
      Authorization:  `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Prefer:          'return=representation',
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
