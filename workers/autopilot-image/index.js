/**
 * DPS Autopilot — autopilot-image Worker
 *
 * Routes:
 *   POST /generate    — generate an image for a post
 *   POST /regenerate  — regenerate with feedback
 *
 * Env:
 *   OPENAI_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   SUPABASE_IMAGE_BUCKET   (default: "generated-images")
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
      console.error('Image worker error:', err);
      return json({ error: err.message }, 500);
    }
  }
};

// ─── Generate ─────────────────────────────────────────────────────────────────

async function handleGenerate(request, env) {
  const { post_id, ref_image_b64 } = await request.json();
  if (!post_id) return json({ error: 'Missing post_id' }, 400);

  const post = await getPost(post_id, env);
  if (!post) return json({ error: 'Post not found' }, 404);

  const profile = await getBrandProfile(post.client_id, env);
  const logo    = await getLogo(post.client_id, env);

  // Use AI-generated image prompt if available, otherwise fall back to builder
  const imagePrompt = post.image_prompt || buildFallbackImagePrompt(profile, post);

  const imageUrl = await generateImage(imagePrompt, logo, ref_image_b64, env);

  await supabase(env, 'PATCH', `/rest/v1/posts?id=eq.${post_id}`, { image_url: imageUrl });

  await supabase(env, 'POST', '/rest/v1/generated_images', {
    client_id:     post.client_id,
    post_id:       post_id,
    public_url:    imageUrl,
    post_category: post.post_category,
  });

  return json({ success: true, image_url: imageUrl });
}

// ─── Regenerate ───────────────────────────────────────────────────────────────

async function handleRegenerate(request, env) {
  const { post_id, image_feedback, notes, ref_image_b64 } = await request.json();
  if (!post_id) return json({ error: 'Missing post_id' }, 400);

  const post = await getPost(post_id, env);
  if (!post) return json({ error: 'Post not found' }, 404);

  const profile = await getBrandProfile(post.client_id, env);
  const logo    = await getLogo(post.client_id, env);

  // On regen: caption worker has already written a fresh image_prompt to the new post row.
  // Use it. If somehow missing, fall back to builder with feedback baked in.
  const imagePrompt = post.image_prompt
    || buildFallbackImagePrompt(profile, post, image_feedback, notes);

  const imageUrl = await generateImage(imagePrompt, logo, ref_image_b64, env);

  await supabase(env, 'PATCH', `/rest/v1/posts?id=eq.${post_id}`, { image_url: imageUrl });

  await supabase(env, 'POST', '/rest/v1/generated_images', {
    client_id:     post.client_id,
    post_id:       post_id,
    public_url:    imageUrl,
    post_category: post.post_category,
  });

  return json({ success: true, image_url: imageUrl });
}

// ─── Fallback Prompt Builder (used if caption worker didn't run first) ─────────

function buildFallbackImagePrompt(profile, post, feedback = [], notes = '') {
  const base      = `Professional social media image for ${profile.business_name}, a ${profile.industry} business in ${profile.location}.`;
  const voice     = profile.brand_voice ? ` Visual style: ${profile.brand_voice}.` : '';
  const colors    = profile.color_palette && Object.values(profile.color_palette).length
    ? ` Brand colors: ${Object.values(profile.color_palette).join(', ')}.`
    : '';
  const category  = post.post_category ? ` Post type: ${post.post_category}.` : '';
  const caption   = post.caption ? ` Complement this caption: "${post.caption.slice(0, 120)}"` : '';
  const fbNote    = feedback?.length ? ` Avoid: ${feedback.join(', ')}.` : '';
  const notesNote = notes ? ` Additional notes: ${notes}.` : '';

  return `${base}${voice}${colors}${category}${caption}${fbNote}${notesNote} Include the business logo prominently. Square 1:1 format. High quality, suitable for Facebook. No text overlays.`;
}

// ─── Image Generation ─────────────────────────────────────────────────────────

async function generateImage(prompt, logo, refImageB64, env) {
  const bucket = env.SUPABASE_IMAGE_BUCKET || 'generated-images';

  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('prompt', prompt);
  form.append('n', '1');
  form.append('size', '1024x1024');

  // Add logo as reference image
  if (logo?.public_url) {
    try {
      const logoRes = await fetch(logo.public_url);
      if (logoRes.ok) {
        const logoBlob = await logoRes.blob();
        form.append('image[]', logoBlob, 'logo.png');
      }
    } catch (e) {
      console.warn('Logo fetch failed, skipping:', e.message);
    }
  }

  // Add client reference image if provided
  if (refImageB64) {
    try {
      const refBytes = Uint8Array.from(atob(refImageB64), c => c.charCodeAt(0));
      const refBlob  = new Blob([refBytes], { type: 'image/png' });
      form.append('image[]', refBlob, 'reference.png');
    } catch (e) {
      console.warn('Ref image decode failed, skipping:', e.message);
    }
  }

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI image error: ${err}`);
  }

  const data  = await res.json();
  const b64   = data.data[0].b64_json;

  // Upload to Supabase Storage
  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
  const imgBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

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
      body: imgBytes,
    }
  );

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Storage upload failed: ${err}`);
  }

  return `${env.SUPABASE_URL}/storage/v1/object/public/${bucket}/${fileName}`;
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

async function getLogo(clientId, env) {
  const rows = await supabase(env, 'GET',
    `/rest/v1/brand_assets?client_id=eq.${clientId}&asset_type=eq.logo_primary&is_active=eq.true&limit=1`
  );
  return Array.isArray(rows) ? rows[0] : null;
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
