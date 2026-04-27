/**
 * DPS Autopilot — autopilot-onboarding Worker
 *
 * Routes:
 *   POST /validate-token   — checks token against Supabase, returns client info
 *   POST /upload-logo      — receives file, uploads to Supabase Storage, returns public URL
 *   POST /save-profile     — saves brand_profile row, marks onboarding_complete
 *
 * Env vars (set via wrangler secret put):
 *   SUPABASE_URL             — https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY     — service_role key
 *   SUPABASE_STORAGE_BUCKET  — e.g. "logos" (create in Supabase dashboard → Storage)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const path = new URL(request.url).pathname;

    try {
      if (path === '/validate-token' && request.method === 'POST') {
        return handleValidateToken(request, env);
      }
      if (path === '/upload-logo' && request.method === 'POST') {
        return handleLogoUpload(request, env);
      }
      if (path === '/save-profile' && request.method === 'POST') {
        return handleSaveProfile(request, env);
      }
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('Worker error:', err);
      return json({ error: 'Internal server error', detail: err.message }, 500);
    }
  },
};

// ─── Validate Token ───────────────────────────────────────────────────────────

async function handleValidateToken(request, env) {
  const { token } = await request.json();
  if (!token) return json({ valid: false, error: 'No token provided' }, 400);

  const rows = await supabase(env, 'GET',
    `/rest/v1/clients?onboarding_token=eq.${encodeURIComponent(token)}&select=id,email,onboarding_complete,brand_profiles(business_name)&limit=1`
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    return json({ valid: false }, 200);
  }

  const client = rows[0];
  return json({
    valid: true,
    client_id: client.id,
    email: client.email,
    onboarding_complete: client.onboarding_complete,
    business_name: client.brand_profiles?.[0]?.business_name || '',
  });
}

// ─── Upload Logo ──────────────────────────────────────────────────────────────

async function handleLogoUpload(request, env) {
  const formData = await request.formData();
  const token = formData.get('token');
  const file = formData.get('logo');

  if (!token || !file) return json({ error: 'Missing token or file' }, 400);

  // Resolve client_id from token
  const rows = await supabase(env, 'GET',
    `/rest/v1/clients?onboarding_token=eq.${encodeURIComponent(token)}&select=id&limit=1`
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    return json({ error: 'Invalid token' }, 401);
  }

  const clientId = rows[0].id;
  const ext = (file.name.split('.').pop() || 'png').toLowerCase();
  const fileName = `${clientId}/logo.${ext}`;
  const bucket = env.SUPABASE_STORAGE_BUCKET || 'logos';

  const uploadRes = await fetch(
    `${env.SUPABASE_URL}/storage/v1/object/${bucket}/${fileName}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        apikey: env.SUPABASE_SERVICE_KEY,
        'Content-Type': file.type || 'image/png',
        'x-upsert': 'true',
      },
      body: await file.arrayBuffer(),
    }
  );

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    console.error('Storage upload failed:', err);
    return json({ error: 'Logo upload failed', detail: err }, 500);
  }

  const publicUrl = `${env.SUPABASE_URL}/storage/v1/object/public/${bucket}/${fileName}`;
  return json({ url: publicUrl });
}

// ─── Save Profile ─────────────────────────────────────────────────────────────

async function handleSaveProfile(request, env) {
  const body = await request.json();
  const { token, ...data } = body;

  if (!token) return json({ error: 'Missing token' }, 400);

  const rows = await supabase(env, 'GET',
    `/rest/v1/clients?onboarding_token=eq.${encodeURIComponent(token)}&select=id&limit=1`
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    return json({ error: 'Invalid token' }, 401);
  }

  const clientId = rows[0].id;

  const profile = {
    client_id: clientId,
    business_name: data.business_name || '',
    industry: data.industry || '',
    location: data.location || '',
    business_description: data.business_description || '',
    target_audience: data.target_audience || '',
    brand_voice: data.brand_voice || '',
    posting_goals: JSON.stringify(data.posting_goals || []),
    off_limits: data.off_limits || '',
    extra_context: data.extra_context || '',
    logo_url: data.logo_url || null,
    color_palette: JSON.stringify(data.color_palette || {}),
    website: data.website || '',
    updated_at: new Date().toISOString(),
  };

  // Upsert on client_id conflict
  await supabase(env, 'POST', '/rest/v1/brand_profiles', profile,
    { Prefer: 'resolution=merge-duplicates,return=minimal' }
  );

  // Mark onboarding complete on the client row
  await supabase(env, 'PATCH',
    `/rest/v1/clients?id=eq.${clientId}`,
    { onboarding_complete: true },
    { Prefer: 'return=minimal' }
  );

  console.log(`Onboarding complete for client ${clientId}`);
  return json({ success: true });
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
