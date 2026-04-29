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
 *   SUPABASE_STORAGE_BUCKET  — e.g. "logos"
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
      if (path === '/save-slots' && request.method === 'POST') {
        return handleSaveSlots(request, env);
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

  const fileBytes = await file.arrayBuffer();
  const fileSizeKb = Math.round(fileBytes.byteLength / 1024);

  // Delete any existing primary logo asset for this client before inserting
  await supabase(env, 'DELETE',
    `/rest/v1/brand_assets?client_id=eq.${clientId}&asset_type=eq.logo_primary`,
    null, { Prefer: 'return=minimal' }
  );

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
      body: fileBytes,
    }
  );

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    console.error('Storage upload failed:', err);
    return json({ error: 'Logo upload failed', detail: err }, 500);
  }

  const publicUrl = `${env.SUPABASE_URL}/storage/v1/object/public/${bucket}/${fileName}`;

  // Upsert into brand_assets table
  await supabase(env, 'POST', '/rest/v1/brand_assets', {
    client_id:    clientId,
    storage_path: fileName,
    public_url:   publicUrl,
    file_name:    file.name,
    file_type:    file.type || 'image/png',
    file_size_kb: fileSizeKb,
    asset_type:   'logo_primary',
    asset_label:  'Primary Logo',
    is_active:    true,
    sort_order:   0,
  }, { Prefer: 'resolution=merge-duplicates,return=minimal' });

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

  // Build profile — no logo_url, that lives in brand_assets
  const profile = {
    client_id:            clientId,
    business_name:        data.business_name || '',
    industry:             data.industry || '',
    location:             data.location || '',
    business_description: data.business_description || '',
    target_audience:      data.target_audience || '',
    brand_voice:          data.brand_voice || '',
    posting_goals:        data.posting_goals || [],
    off_limits:           data.off_limits || '',
    extra_context:        data.extra_context || '',
    example_posts:        data.example_posts || '',
    color_palette:        data.color_palette || {},
    website:              data.website || '',
    updated_at:           new Date().toISOString(),
  };

  // Upsert on client_id conflict
  await supabase(env, 'POST', '/rest/v1/brand_profiles?on_conflict=client_id', profile,
    { Prefer: 'resolution=merge-duplicates,return=minimal' }
  );

  // Mark onboarding complete
  await supabase(env, 'PATCH',
    `/rest/v1/clients?id=eq.${clientId}`,
    { onboarding_complete: true },
    { Prefer: 'return=minimal' }
  );

  console.log(`Onboarding complete for client ${clientId}`);
  return json({ success: true });
}

// ─── Save Slots ───────────────────────────────────────────────────────────────

async function handleSaveSlots(request, env) {
  const { token, slots } = await request.json();

  if (!token) return json({ error: 'Missing token' }, 400);
  if (!Array.isArray(slots) || slots.length === 0) {
    return json({ error: 'No slots provided' }, 400);
  }

  // Resolve client from token
  const rows = await supabase(env, 'GET',
    `/rest/v1/clients?onboarding_token=eq.${encodeURIComponent(token)}&select=id,plan&limit=1`
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    return json({ error: 'Invalid token' }, 401);
  }

  const { id: clientId, plan } = rows[0];

  // Enforce slot limit per plan
  const SLOT_LIMITS = { starter: 2, growth: 4, daily: 7 };
  const limit = SLOT_LIMITS[plan] || 2;

  if (slots.length > limit) {
    return json({
      error: `Plan "${plan}" allows ${limit} slot(s). Received ${slots.length}.`
    }, 400);
  }

  // Validate each slot shape
  for (const slot of slots) {
    const dow = slot.day_of_week;
    if (typeof dow !== 'number' || dow < 0 || dow > 6) {
      return json({ error: `Invalid day_of_week: ${dow}` }, 400);
    }
    if (!slot.post_time || !/^\d{2}:\d{2}(:\d{2})?$/.test(slot.post_time)) {
      return json({ error: `Invalid post_time: ${slot.post_time}` }, 400);
    }
    if (!slot.timezone) {
      return json({ error: 'Missing timezone' }, 400);
    }
  }

  // Delete all existing slots for this client, then insert fresh
  await supabase(env, 'DELETE',
    `/rest/v1/scheduled_slots?client_id=eq.${clientId}`,
    null,
    { Prefer: 'return=minimal' }
  );

  // Build slot rows with slot_number (1-based, sorted by day then time)
  const sorted = [...slots].sort((a, b) => {
    if (a.day_of_week !== b.day_of_week) return a.day_of_week - b.day_of_week;
    return a.post_time.localeCompare(b.post_time);
  });

  const rows_to_insert = sorted.map((slot, i) => ({
    client_id:    clientId,
    slot_number:  i + 1,
    day_of_week:  slot.day_of_week,
    post_time:    slot.post_time.length === 5 ? slot.post_time + ':00' : slot.post_time,
    timezone:     slot.timezone,
    post_type:    slot.post_type || 'general',
    is_active:    true,
  }));

  await supabase(env, 'POST', '/rest/v1/scheduled_slots', rows_to_insert,
    { Prefer: 'return=minimal' }
  );

  console.log(`Saved ${rows_to_insert.length} slot(s) for client ${clientId}`);
  return json({ success: true, slots_saved: rows_to_insert.length });
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
