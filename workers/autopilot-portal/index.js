/**
 * DPS Autopilot — autopilot-portal Worker
 *
 * Routes:
 *   POST /portal    — create a Stripe Customer Portal session → returns { url }
 *   POST /upgrade   — create a Stripe Checkout session for plan upgrade → returns { url }
 *   POST /extend    — create a Stripe Checkout session for one additional month → returns { url }
 *
 * Env vars:
 *   STRIPE_SECRET_KEY  — sk_...
 *   SUPABASE_URL       — https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY
 *   PORTAL_RETURN_URL  — where to send clients after they leave the portal
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const PRICE_IDS = {
  starter: 'price_1TQsnDGeDuqsL2uIqAzGhKXX',
  growth:  'price_1TQsnvGeDuqsL2uIuOv7lS3F',
  daily:   'price_1TQspUGeDuqsL2uIDWl1AAA5',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/portal')  return handlePortal(request, env);
      if (path === '/upgrade') return handleUpgrade(request, env);
      if (path === '/extend')  return handleExtend(request, env);
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('Portal worker error:', err);
      return json({ error: err.message }, 500);
    }
  },
};

// ── Stripe Customer Portal ────────────────────────────────────────────────────

async function handlePortal(request, env) {
  const { token } = await request.json();
  if (!token) return json({ error: 'Missing token' }, 400);

  const client = await getClient(env, token);
  if (!client) return json({ error: 'Invalid token' }, 401);

  if (!client.stripe_customer_id) {
    return json({ error: 'No Stripe customer found for this account' }, 400);
  }

  const params = new URLSearchParams({
    customer:    client.stripe_customer_id,
    return_url:  env.PORTAL_RETURN_URL || 'https://dreadpiratestudio.com/autopilot/dashboard/dashboard.html',
  });

  const res  = await stripe(env, 'POST', '/v1/billing_portal/sessions', params);
  const data = await res.json();

  if (!res.ok) {
    console.error('Stripe portal error:', data);
    return json({ error: data.error?.message || 'Stripe error' }, 502);
  }

  return json({ url: data.url });
}

// ── Upgrade Checkout ──────────────────────────────────────────────────────────

async function handleUpgrade(request, env) {
  const { token, plan } = await request.json();
  if (!token || !plan) return json({ error: 'Missing token or plan' }, 400);

  const priceId = PRICE_IDS[plan];
  if (!priceId) return json({ error: `Invalid plan: ${plan}` }, 400);

  const client = await getClient(env, token);
  if (!client) return json({ error: 'Invalid token' }, 401);

  if (!client.stripe_subscription_id) {
    return json({ error: 'No active subscription found' }, 400);
  }

  const subRes  = await stripe(env, 'GET', `/v1/subscriptions/${client.stripe_subscription_id}`);
  const subData = await subRes.json();

  if (!subRes.ok) return json({ error: subData.error?.message || 'Stripe error' }, 502);

  const itemId = subData.items?.data?.[0]?.id;
  if (!itemId) return json({ error: 'Could not find subscription item' }, 400);

  const updateParams = new URLSearchParams();
  updateParams.set('items[0][id]', itemId);
  updateParams.set('items[0][price]', priceId);
  updateParams.set('metadata[plan]', plan);
  updateParams.set('proration_behavior', 'always_invoice');

  const updateRes  = await stripe(env, 'POST', `/v1/subscriptions/${client.stripe_subscription_id}`, updateParams);
  const updateData = await updateRes.json();

  if (!updateRes.ok) {
    console.error('Stripe upgrade error:', updateData);
    return json({ error: updateData.error?.message || 'Stripe error' }, 502);
  }

  await sb(env, 'PATCH', `/rest/v1/clients?id=eq.${client.id}`, { plan });

  return json({ success: true, plan });
}

// ── Extend (one additional month) ─────────────────────────────────────────────
// Creates a one-time Checkout session priced at the client's current monthly rate.
// On success, Stripe fires checkout.session.completed → webhook sets subscription_end += 1 month.

async function handleExtend(request, env) {
  const { token } = await request.json();
  if (!token) return json({ error: 'Missing token' }, 400);

  const client = await getClient(env, token);
  if (!client) return json({ error: 'Invalid token' }, 401);

  if (!client.stripe_customer_id || !client.stripe_subscription_id) {
    return json({ error: 'No active subscription found' }, 400);
  }

  // Get current subscription to determine the price amount
  const subRes  = await stripe(env, 'GET', `/v1/subscriptions/${client.stripe_subscription_id}`);
  const subData = await subRes.json();
  if (!subRes.ok) return json({ error: subData.error?.message || 'Stripe error' }, 502);

  const unitAmount = subData.items?.data?.[0]?.price?.unit_amount;
  const currency   = subData.items?.data?.[0]?.price?.currency || 'usd';
  const planLabel  = client.plan || 'Autopilot';

  if (!unitAmount) return json({ error: 'Could not determine subscription price' }, 400);

  // Build a one-time Checkout session
  const dashboardUrl = env.PORTAL_RETURN_URL || 'https://dreadpiratestudio.com/autopilot/dashboard/dashboard.html';

  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('customer', client.stripe_customer_id);
  params.set('success_url', `${dashboardUrl}?extended=1`);
  params.set('cancel_url', dashboardUrl);
  params.set('line_items[0][quantity]', '1');
  params.set('line_items[0][price_data][currency]', currency);
  params.set('line_items[0][price_data][unit_amount]', unitAmount.toString());
  params.set('line_items[0][price_data][product_data][name]', `Autopilot ${planLabel.charAt(0).toUpperCase() + planLabel.slice(1)} — Additional Month`);
  params.set('line_items[0][price_data][product_data][description]', 'Extends your Autopilot scheduling window by one month.');
  params.set('metadata[purpose]', 'extend');
  params.set('metadata[client_id]', client.id);

  const res  = await stripe(env, 'POST', '/v1/checkout/sessions', params);
  const data = await res.json();

  if (!res.ok) {
    console.error('Stripe extend checkout error:', data);
    return json({ error: data.error?.message || 'Stripe error' }, 502);
  }

  return json({ url: data.url });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getClient(env, token) {
  const rows = await sb(env, 'GET',
    `/rest/v1/clients?onboarding_token=eq.${encodeURIComponent(token)}&select=id,stripe_customer_id,stripe_subscription_id,plan,status,subscription_end&limit=1`
  );
  return rows?.[0] || null;
}

async function stripe(env, method, path, body = null) {
  return fetch(`https://api.stripe.com${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': body instanceof URLSearchParams
        ? 'application/x-www-form-urlencoded'
        : 'application/json',
    },
    body: body ? body.toString() : undefined,
  });
}

async function sb(env, method, path, body = null) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'apikey':         env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Prefer':         'return=representation',
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
