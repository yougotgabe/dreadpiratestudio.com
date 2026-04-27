/**
 * DPS Autopilot — autopilot-checkout Worker
 *
 * Creates a Stripe Checkout session for the selected plan.
 * Receives: POST { plan: "starter"|"growth"|"daily", email?: string }
 * Returns:  { url: "https://checkout.stripe.com/..." }
 *
 * Env vars:
 *   STRIPE_SECRET_KEY      — sk_live_... or sk_test_...
 *   SUCCESS_URL            — e.g. https://autopilot.dreadpiratestudio.com/onboarding.html
 *   CANCEL_URL             — e.g. https://autopilot.dreadpiratestudio.com/checkout.html
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Stripe Price IDs — replace with your actual IDs from Stripe Dashboard
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

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { plan, email } = body;

    if (!plan || !PRICE_IDS[plan]) {
      return json({ error: `Invalid plan: ${plan}` }, 400);
    }

    const priceId = PRICE_IDS[plan];

    // Build Stripe Checkout session payload
    const params = new URLSearchParams();
    params.set('mode', 'subscription');
    params.set('line_items[0][price]', priceId);
    params.set('line_items[0][quantity]', '1');
    params.set('success_url', env.SUCCESS_URL + '?session_id={CHECKOUT_SESSION_ID}');
    params.set('cancel_url', env.CANCEL_URL);
    params.set('allow_promotion_codes', 'true');

    if (email) {
      params.set('customer_email', email);
    }

    // Add plan metadata so webhook can read it
    params.set('metadata[plan]', plan);
    params.set('subscription_data[metadata][plan]', plan);

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const session = await stripeRes.json();

    if (!stripeRes.ok) {
      console.error('Stripe error:', session);
      return json({ error: session.error?.message || 'Stripe error' }, 502);
    }

    return json({ url: session.url });
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
