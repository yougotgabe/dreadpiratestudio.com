/**
 * DPS Autopilot — autopilot-webhook Worker
 * Listens for Stripe webhook events and provisions clients in Supabase.
 *
 * Env vars:
 *   STRIPE_WEBHOOK_SECRET   — whsec_...  (from Stripe dashboard → Webhooks)
 *   STRIPE_SECRET_KEY       — sk_...
 *   SUPABASE_URL            — https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY    — service_role key (NOT the anon key)
 *   RESEND_API_KEY          — re_...
 *
 * Stripe events handled:
 *   checkout.session.completed      → create client + brand_profile rows + send welcome email
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

  // Upsert client row (on_conflict=email handles re-subscriptions gracefully)
  await supabaseRequest(env, "POST", "/rest/v1/clients?on_conflict=email", {
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

  // Send welcome email with onboarding link
  await sendWelcomeEmail(env, email, plan, clientId);
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

// ─── Welcome Email ────────────────────────────────────────────────────────────

async function sendWelcomeEmail(env, email, plan, clientId) {
  // Generate a unique onboarding token and store it on the client row
  const token = generateToken();

  await fetch(`${env.SUPABASE_URL}/rest/v1/clients?id=eq.${clientId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ onboarding_token: token }),
  });

  const onboardingLink = `https://dreadpiratestudio.com/autopilot/onboarding/onboarding.html?token=${token}`;

  const PLAN_LABELS = {
    starter: 'Starter ($20/mo)',
    growth:  'Growth ($50/mo)',
    daily:   'Daily ($80/mo)',
  };

  const planName = PLAN_LABELS[plan] || plan;

  const emailHtml = WELCOME_EMAIL_HTML
    .replace(/\{\{ONBOARDING_LINK\}\}/g, onboardingLink)
    .replace(/\{\{PLAN_NAME\}\}/g, planName);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'DPS Autopilot <autopilot@dreadpiratestudio.com>',
      to: [email],
      subject: "You're aboard — set up your brand profile",
      html: emailHtml,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Resend error sending welcome email:', err);
    // Don't throw — failed email shouldn't break the webhook response
  } else {
    console.log(`Welcome email sent to ${email}`);
  }
}

function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── Welcome Email HTML Template ──────────────────────────────────────────────

const WELCOME_EMAIL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to DPS Autopilot</title>
</head>
<body style="margin:0;padding:0;background:#080808;font-family:Georgia,'Times New Roman',serif;">

  <div style="display:none;max-height:0;overflow:hidden;color:#080808;font-size:1px;">
    Your brand profile is ready to set up — one link, five minutes, and your first post is on its way.
  </div>

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#080808;min-height:100vh;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;background:#0d0f14;border:1px solid rgba(201,168,76,0.2);">

          <tr>
            <td style="height:3px;background:linear-gradient(to right,#8a6f2e,#c9a84c,#8a6f2e);font-size:0;line-height:0;">&nbsp;</td>
          </tr>

          <tr>
            <td align="center" style="padding:36px 40px 28px;">
              <p style="margin:0 0 6px;font-family:Georgia,serif;font-size:11px;letter-spacing:6px;text-transform:uppercase;color:#c9a84c;">
                Dread Pirate Studio
              </p>
              <h1 style="margin:0;font-family:Georgia,serif;font-size:28px;font-weight:400;letter-spacing:2px;color:#e8e0d0;line-height:1.25;">
                You're Aboard, Captain.
              </h1>
              <table width="80" cellpadding="0" cellspacing="0" border="0" style="margin:16px auto 0;">
                <tr><td style="height:1px;background:linear-gradient(to right,transparent,#c9a84c,transparent);font-size:0;">&nbsp;</td></tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:0 40px 32px;">
              <p style="margin:0 0 20px;font-size:17px;line-height:1.75;color:rgba(232,224,208,0.7);font-style:italic;">
                Your DPS Autopilot subscription is confirmed. Welcome to the crew — we're glad you're here.
              </p>
              <p style="margin:0 0 28px;font-size:17px;line-height:1.75;color:rgba(232,224,208,0.7);font-style:italic;">
                There's one thing standing between you and your first AI-generated post: your brand profile. It takes about five minutes and tells the AI everything it needs to write in your voice.
              </p>

              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" style="padding:8px 0 32px;">
                    <a href="{{ONBOARDING_LINK}}"
                       style="display:inline-block;padding:14px 36px;background:#c9a84c;color:#080808;font-family:Georgia,serif;font-size:12px;font-weight:600;letter-spacing:3px;text-transform:uppercase;text-decoration:none;">
                      ⚓ &nbsp;Set Up My Brand Profile
                    </a>
                  </td>
                </tr>
              </table>

              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#131620;border:1px solid rgba(201,168,76,0.1);">
                <tr>
                  <td style="padding:24px 28px;">
                    <p style="margin:0 0 16px;font-family:Georgia,serif;font-size:10px;letter-spacing:5px;text-transform:uppercase;color:#c9a84c;">
                      What happens next
                    </p>

                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
                      <tr>
                        <td width="32" valign="top" style="padding-right:14px;">
                          <div style="width:28px;height:28px;background:rgba(201,168,76,0.1);border:1px solid #8a6f2e;font-family:Georgia,serif;font-size:12px;color:#8a6f2e;text-align:center;line-height:28px;">✦</div>
                        </td>
                        <td valign="top">
                          <p style="margin:0;font-family:Georgia,serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#8a6f2e;">Payment Confirmed</p>
                          <p style="margin:4px 0 0;font-size:14px;color:rgba(232,224,208,0.4);font-style:italic;line-height:1.5;">Your subscription is live.</p>
                        </td>
                      </tr>
                    </table>

                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
                      <tr>
                        <td width="32" valign="top" style="padding-right:14px;">
                          <div style="width:28px;height:28px;background:rgba(201,168,76,0.12);border:1px solid #c9a84c;font-family:Georgia,serif;font-size:11px;color:#c9a84c;text-align:center;line-height:28px;">2</div>
                        </td>
                        <td valign="top">
                          <p style="margin:0;font-family:Georgia,serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#e8e0d0;">Complete Your Brand Profile</p>
                          <p style="margin:4px 0 0;font-size:14px;color:rgba(232,224,208,0.6);font-style:italic;line-height:1.5;">Tell the AI about your business, your customers, and your voice. Upload your logo.</p>
                        </td>
                      </tr>
                    </table>

                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
                      <tr>
                        <td width="32" valign="top" style="padding-right:14px;">
                          <div style="width:28px;height:28px;background:#131620;border:1px solid rgba(201,168,76,0.15);font-family:Georgia,serif;font-size:11px;color:#6b6355;text-align:center;line-height:28px;">3</div>
                        </td>
                        <td valign="top">
                          <p style="margin:0;font-family:Georgia,serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#6b6355;">Connect Your Facebook Page</p>
                          <p style="margin:4px 0 0;font-size:14px;color:rgba(232,224,208,0.35);font-style:italic;line-height:1.5;">Quick Facebook login. We only post — nothing else.</p>
                        </td>
                      </tr>
                    </table>

                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td width="32" valign="top" style="padding-right:14px;">
                          <div style="width:28px;height:28px;background:#131620;border:1px solid rgba(201,168,76,0.15);font-family:Georgia,serif;font-size:11px;color:#6b6355;text-align:center;line-height:28px;">4</div>
                        </td>
                        <td valign="top">
                          <p style="margin:0;font-family:Georgia,serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#6b6355;">First Post in Your Queue</p>
                          <p style="margin:4px 0 0;font-size:14px;color:rgba(232,224,208,0.35);font-style:italic;line-height:1.5;">Within 24 hours of setup, your first post will be ready for your approval.</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:0 40px 32px;">
              <p style="margin:0;font-size:14px;color:rgba(232,224,208,0.4);font-style:italic;line-height:1.6;">
                You're on the <strong style="color:rgba(232,224,208,0.65);font-style:normal;">{{PLAN_NAME}}</strong> plan.
                Questions? Reply to this email or reach us at
                <a href="mailto:dreadpiratestudio@gmail.com" style="color:#c9a84c;text-decoration:none;">dreadpiratestudio@gmail.com</a>.
              </p>
            </td>
          </tr>

          <tr>
            <td style="height:1px;background:linear-gradient(to right,transparent,rgba(201,168,76,0.2),transparent);font-size:0;">&nbsp;</td>
          </tr>

          <tr>
            <td align="center" style="padding:20px 40px 28px;">
              <p style="margin:0 0 8px;font-family:Georgia,serif;font-size:10px;letter-spacing:4px;text-transform:uppercase;color:#6b6355;">
                Dread Pirate Studio &nbsp;·&nbsp; Willmar, MN
              </p>
              <p style="margin:0;font-size:13px;color:#6b6355;">
                <a href="https://dreadpiratestudio.com/autopilot/privacy" style="color:#6b6355;text-decoration:none;">Privacy Policy</a>
                &nbsp;·&nbsp;
                <a href="https://dreadpiratestudio.com/autopilot/terms" style="color:#6b6355;text-decoration:none;">Terms of Service</a>
                &nbsp;·&nbsp;
                <a href="https://dreadpiratestudio.com" style="color:#6b6355;text-decoration:none;">dreadpiratestudio.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;

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
      Prefer: method === "POST" ? "return=representation,resolution=merge-duplicates" : "return=minimal",
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

// ─── Stripe Signature Verification ───────────────────────────────────────────

async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return false;

  const parts = Object.fromEntries(
    sigHeader.split(",").map((p) => p.split("="))
  );
  const timestamp = parts.t;
  const expectedSig = parts.v1;

  if (!timestamp || !expectedSig) return false;

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
