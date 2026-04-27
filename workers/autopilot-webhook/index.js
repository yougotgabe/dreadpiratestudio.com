/**
 * DPS Autopilot — autopilot-webhook Worker
 * Listens for Stripe webhook events and provisions clients in Supabase.
 *
 * Env vars:
 *   STRIPE_WEBHOOK_SECRET   — whsec_...  (from Stripe dashboard → Webhooks)
 *   SUPABASE_URL            — https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY    — service_role key (NOT the anon key)
 *
 * Stripe events handled:
 *   checkout.session.completed      → create client + brand_profile rows
 *   customer.subscription.updated   → update plan tier
 *   customer.subscription.deleted   → mark client inactive
 */

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get("stripe-signature");

    // Verify Stripe webhook signature
    const isValid = await verifyStripeSignature(
      rawBody,
      signature,
      env.STRIPE_WEBHOOK_SECRET
    );

    if (!isValid) {
      console.error("Webhook signature verification failed");
      return new Response("Unauthorized", { status: 401 });
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    console.log(`Received Stripe event: ${event.type}`);

    try {
      switch (event.type) {
        case "checkout.session.completed":
          await handleCheckoutComplete(event.data.object, env);
          break;

        case "customer.subscription.updated":
          await handleSubscriptionUpdated(event.data.object, env);
          break;

        case "customer.subscription.deleted":
          await handleSubscriptionDeleted(event.data.object, env);
          break;

        default:
          console.log(`Unhandled event type: ${event.type}`);
      }
    } catch (err) {
      console.error(`Handler error for ${event.type}:`, err);
      // Return 200 anyway — Stripe retries on non-2xx, which could cause duplicates
      return new Response(JSON.stringify({ error: err.message }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
};

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handleCheckoutComplete(session, env) {
  const stripeCustomerId = session.customer;
  const stripeSubscriptionId = session.subscription;
  const email = session.customer_details?.email || session.customer_email;
  const name = session.customer_details?.name || null;

  if (!email) {
    throw new Error("No email on checkout session");
  }

  // Fetch subscription to get plan metadata + price ID
  const sub = await fetchStripe(
    `https://api.stripe.com/v1/subscriptions/${stripeSubscriptionId}`,
    env.STRIPE_SECRET_KEY
  );

  const plan = sub.metadata?.plan || inferPlanFromAmount(sub.items?.data?.[0]?.price?.unit_amount);
  const stripePriceId = sub.items?.data?.[0]?.price?.id || null;

  // Upsert client row
  const clientRes = await supabaseRequest(env, "POST", "/rest/v1/clients", {
    email,
    name,
    plan,
    status: "active",
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubscriptionId,
    stripe_price_id: stripePriceId,
    onboarding_complete: false,
  });

  // Get the new client's ID
  const clients = await supabaseRequest(env, "GET", `/rest/v1/clients?email=eq.${encodeURIComponent(email)}&select=id`);
  const clientId = Array.isArray(clients) && clients[0]?.id;

  if (!clientId) {
    throw new Error(`Could not retrieve client ID for ${email}`);
  }

  // Create an empty brand_profile row so onboarding has a target to fill
  await supabaseRequest(env, "POST", "/rest/v1/brand_profiles", {
    client_id: clientId,
    business_name: name || "",
    industry: "",
    brand_voice: "",
    target_audience: "",
    posting_goals: "",
    logo_url: null,
    color_palette: null,
    approved_count: 0,
    rejected_count: 0,
  });

  console.log(`Provisioned client: ${email} (${plan}), client_id: ${clientId}`);
}

async function handleSubscriptionUpdated(subscription, env) {
  const stripeSubscriptionId = subscription.id;
  const plan = subscription.metadata?.plan || inferPlanFromAmount(
    subscription.items?.data?.[0]?.price?.unit_amount
  );
  const status = subscription.status === "active" ? "active" : "inactive";

  await supabaseRequest(env, "PATCH",
    `/rest/v1/clients?stripe_subscription_id=eq.${stripeSubscriptionId}`,
    { plan, status }
  );

  console.log(`Updated subscription ${stripeSubscriptionId}: plan=${plan}, status=${status}`);
}

async function handleSubscriptionDeleted(subscription, env) {
  const stripeSubscriptionId = subscription.id;

  await supabaseRequest(env, "PATCH",
    `/rest/v1/clients?stripe_subscription_id=eq.${stripeSubscriptionId}`,
    { status: "cancelled" }
  );

  console.log(`Cancelled subscription ${stripeSubscriptionId}`);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function inferPlanFromAmount(unitAmount) {
  if (!unitAmount) return "starter";
  if (unitAmount <= 2000) return "starter";  // $20
  if (unitAmount <= 5000) return "growth";   // $50
  return "daily";                             // $80
}

async function fetchStripe(url, secretKey) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Stripe fetch error: ${err?.error?.message}`);
  }
  return res.json();
}

async function supabaseRequest(env, method, path, body = null) {
  const url = `${env.SUPABASE_URL}${path}`;
  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      // Return the inserted row(s)
      Prefer: method === "POST" ? "return=representation" : "return=minimal",
    },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Supabase error ${res.status} on ${method} ${path}: ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ─── Stripe Signature Verification (HMAC-SHA256, no npm needed) ──────────────

async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return false;

  // Parse the Stripe-Signature header
  const parts = Object.fromEntries(
    sigHeader.split(",").map((p) => p.split("="))
  );
  const timestamp = parts.t;
  const expectedSig = parts.v1;

  if (!timestamp || !expectedSig) return false;

  // Reject events older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
    console.error("Stripe event timestamp too old");
    return false;
  }

  const signedPayload = `${timestamp}.${payload}`;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));
  const hexSig = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return hexSig === expectedSig;
}
