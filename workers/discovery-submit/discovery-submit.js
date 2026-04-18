/**
 * discovery-submit — Cloudflare Worker
 * Receives POST requests from the discovery form at /discovery/*.html
 * and saves them to the DPS Supabase project (biz schema) + emails Gabe.
 *
 * Deploy to: dreadpiratestudio.com/api/discovery  (route via Cloudflare dashboard)
 *
 * Secret env vars to set via `wrangler secret put ...`:
 *   SUPABASE_URL          - https://efylfnnshmaauhiwqaxj.supabase.co
 *   SUPABASE_SERVICE_KEY  - service_role key (NOT the publishable key)
 *   RESEND_API_KEY        - re_...
 *   NOTIFY_EMAIL          - where to send notifications (e.g., gabe@dreadpiratestudio.com)
 *   NOTIFY_FROM           - verified Resend sender (e.g., discovery@dreadpiratestudio.com)
 */

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Same origin check pattern as yt-proxy.js
    var origin = request.headers.get('Origin') || '';
    var referer = request.headers.get('Referer') || '';
    var allowed = origin.includes('dreadpiratestudio.com') || referer.includes('dreadpiratestudio.com');
    if (!allowed && (origin.includes('localhost') || referer.includes('localhost'))) {
      allowed = true;
    }
    if (!allowed) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      var payload = await request.json();

      // Basic validation
      if (!payload.contact_name || !payload.contact_email) {
        return json({ error: 'Missing required fields' }, 400, request);
      }

      // Reject obvious bot submissions
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.contact_email)) {
        return json({ error: 'Invalid email' }, 400, request);
      }

      // Save to Supabase (biz schema)
      var record = await saveToSupabase(payload, env);

      // Send notification email — but don't fail the request if email errors
      try {
        await sendNotificationEmail(payload, record, env);
      } catch (err) {
        console.error('Email notification failed:', err.message);
      }

      return json({ ok: true, id: record.id }, 200, request);

    } catch (err) {
      console.error('Submission error:', err.message, err.stack);
      return json({ error: 'Internal error' }, 500, request);
    }
  }
};

// ── Helpers ──────────────────────────────────────────────────

function corsHeaders(request) {
  var origin = request.headers.get('Origin') || '';
  var allowOrigin = origin.includes('dreadpiratestudio.com')
    ? origin
    : 'https://dreadpiratestudio.com';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      corsHeaders(request)
    )
  });
}

async function saveToSupabase(payload, env) {
  var url = env.SUPABASE_URL + '/rest/v1/discovery_submissions';

  var res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      // Route the request to the `biz` schema instead of `public`
      'Content-Profile': 'biz',
      'Accept-Profile': 'biz'
    },
    body: JSON.stringify({
      form_type: payload._form_type || 'airbnb_rental',
      contact_name: payload.contact_name,
      business_name: payload.business_name || null,
      contact_email: payload.contact_email,
      contact_phone: payload.contact_phone || null,
      payload: payload,
      user_agent: payload._user_agent || null,
      submitted_at: payload._submitted_at || new Date().toISOString(),
      status: 'new'
    })
  });

  if (!res.ok) {
    var errText = await res.text();
    throw new Error('Supabase save failed: ' + res.status + ' ' + errText);
  }

  var data = await res.json();
  return Array.isArray(data) ? data[0] : data;
}

async function sendNotificationEmail(payload, record, env) {
  var subject = 'New discovery: ' + payload.contact_name
    + (payload.business_name ? ' — ' + payload.business_name : '');

  var res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: env.NOTIFY_FROM,
      to: env.NOTIFY_EMAIL,
      reply_to: payload.contact_email,
      subject: subject,
      html: buildEmailHtml(payload, record),
      text: buildEmailText(payload)
    })
  });

  if (!res.ok) {
    var errText = await res.text();
    throw new Error('Resend failed: ' + res.status + ' ' + errText);
  }
}

// ── Label mappings ───────────────────────────────────────────

var LABELS = {
  pms: {
    hospitable: 'Hospitable', hostaway: 'Hostaway', guesty: 'Guesty',
    lodgify: 'Lodgify', ownerrez: 'OwnerRez', igms: 'iGMS',
    none: 'None (manual)', other: 'Other'
  },
  payment_timing: {
    full: 'Full payment up front',
    deposit: 'Deposit at booking, balance before check-in',
    split: '50/50 split',
    unsure: 'Undecided / wants recommendation'
  },
  timeline: {
    asap: 'ASAP',
    '1_2_months': '1–2 months',
    '3_6_months': '3–6 months',
    no_rush: 'No rush'
  },
  budget_build: {
    under_2k: 'Under $2,000',
    '2k_4k': '$2,000–$4,000',
    '4k_7_5k': '$4,000–$7,500',
    '7_5k_plus': '$7,500+',
    retainer_only: 'Retainer-only preferred'
  },
  budget_monthly: {
    under_100: 'Under $100/mo',
    '100_250': '$100–$250/mo',
    '250_500': '$250–$500/mo',
    value_based: 'Value-based'
  },
  priorities: {
    save_fees: 'Saving money on Airbnb fees',
    own_relationship: 'Owning the guest relationship',
    design: 'Beautiful on-brand site',
    save_time: 'Saving time on operations',
    scale: 'Ability to scale',
    seo: 'Better SEO / Google findability'
  }
};

function label(category, value) {
  return (LABELS[category] && LABELS[category][value]) || value || '';
}

function fmtList(value) {
  if (!value) return '—';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Email builders (DPS-branded) ─────────────────────────────

function buildEmailHtml(p, record) {
  var rankedPriorities = p.priorities_ranked
    ? p.priorities_ranked.split(',').map(function(v, i) {
        return (i + 1) + '. ' + label('priorities', v);
      }).join('<br>')
    : '—';

  function section(title, rows) {
    var rowHtml = rows.map(function(r) {
      return '<tr>'
        + '<td style="padding:10px 18px;border-bottom:1px solid rgba(201,168,76,0.1);color:#8a6f2e;font-family:Cinzel,serif;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;width:38%;vertical-align:top;">' + r[0] + '</td>'
        + '<td style="padding:10px 18px;border-bottom:1px solid rgba(201,168,76,0.1);color:#e8e0d0;font-family:Georgia,serif;font-size:14px;line-height:1.5;vertical-align:top;">' + (r[1] || '—') + '</td>'
        + '</tr>';
    }).join('');

    return '<tr><td colspan="2" style="background:#0d0f14;padding:14px 18px;border-top:1px solid rgba(201,168,76,0.2);">'
      + '<div style="font-family:Cinzel,serif;font-size:11px;letter-spacing:0.25em;text-transform:uppercase;color:#c9a84c;">' + title + '</div>'
      + '</td></tr>' + rowHtml;
  }

  return '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#080808;">'
    + '<div style="max-width:680px;margin:0 auto;background:#131620;">'
    + '<div style="background:#080808;padding:28px 24px;border-bottom:1px solid rgba(201,168,76,0.2);text-align:center;">'
    + '<div style="font-family:Cinzel,serif;font-size:10px;letter-spacing:0.4em;text-transform:uppercase;color:#8a6f2e;margin-bottom:6px;">Dread Pirate Studio</div>'
    + '<div style="font-family:Georgia,serif;font-size:22px;color:#e8e0d0;font-weight:normal;">New Discovery Submission</div>'
    + '</div>'
    + '<table style="width:100%;border-collapse:collapse;">'
    + section('Contact', [
        ['Name', esc(p.contact_name)],
        ['Business', esc(p.business_name)],
        ['Email', '<a href="mailto:' + esc(p.contact_email) + '" style="color:#c9a84c;">' + esc(p.contact_email) + '</a>'],
        ['Phone', esc(p.contact_phone)]
      ])
    + section('Portfolio', [
        ['Property count', esc(p.property_count)],
        ['Properties', esc(p.property_list).replace(/\n/g, '<br>')],
        ['Growth plans', esc(p.future_growth)],
        ['Types', fmtList(p.property_types)],
        ['Nightly rate', esc(p.nightly_rate)],
        ['Booking length', esc(p.booking_length)],
        ['Occupancy', esc(p.occupancy)]
      ])
    + section('Tech stack', [
        ['Current platforms', fmtList(p.platforms)],
        ['PMS', label('pms', p.pms) + (p.pms_other_text ? ' (' + esc(p.pms_other_text) + ')' : '')],
        ['PMS cost/happiness', esc(p.pms_cost)],
        ['Messaging', esc(p.messaging)],
        ['Guest access', fmtList(p.access)],
        ['Cleaning', esc(p.cleaning)],
        ['Existing site', esc(p.current_website)],
        ['Domain', esc(p.domain)]
      ])
    + section('Bookings &amp; payments', [
        ['Payment timing', label('payment_timing', p.payment_timing)],
        ['Stripe', esc(p.stripe)],
        ['Cancellation', esc(p.cancellation) + (p.cancellation_custom_text ? ': ' + esc(p.cancellation_custom_text) : '')],
        ['Direct-book discount', esc(p.discount)],
        ['Taxes', esc(p.taxes)],
        ['Fees', esc(p.fees)],
        ['Damage protection', esc(p.damage) + (p.damage_deposit_amount ? ' (' + esc(p.damage_deposit_amount) + ')' : '')]
      ])
    + section('Guest experience', [
        ['Differentiator', esc(p.differentiator)],
        ['Review themes', esc(p.review_themes)],
        ['Pre-arrival info', fmtList(p.pre_arrival)],
        ['Pre-arrival flow', esc(p.pre_arrival_timing)],
        ['Post-checkout', fmtList(p.post_checkout)],
        ['Past guests', esc(p.past_guests)]
      ])
    + section('Brand &amp; content', [
        ['Brand assets', fmtList(p.brand_assets)],
        ['Photos', esc(p.photos)],
        ['Video', esc(p.video)],
        ['Tone', fmtList(p.tone)],
        ['Inspiration', esc(p.inspiration).replace(/\n/g, '<br>')]
      ])
    + section('Marketing', [
        ['Traffic sources', fmtList(p.traffic)],
        ['Social handles', esc(p.social_handles).replace(/\n/g, '<br>')],
        ['Google Business Profile', esc(p.gbp)],
        ['Marketing interest', fmtList(p.marketing_interest)]
      ])
    + section('Operations', [
        ['Who manages', esc(p.manager)],
        ['Admin features', fmtList(p.admin_features)],
        ['Pain points', fmtList(p.pain_points)],
        ['Other pain', esc(p.pain_other)]
      ])
    + section('Budget &amp; priorities', [
        ['Timeline', label('timeline', p.timeline)],
        ['Build budget', label('budget_build', p.budget_build)],
        ['Monthly budget', label('budget_monthly', p.budget_monthly)],
        ['Priorities (ranked)', rankedPriorities],
        ['Must-haves', esc(p.must_have)],
        ['Anything else', esc(p.anything_else)]
      ])
    + '</table>'
    + '<div style="padding:16px 24px;color:#6b6355;font-family:Georgia,serif;font-size:11px;font-style:italic;border-top:1px solid rgba(201,168,76,0.15);background:#0d0f14;">'
    + 'Submission ID: ' + record.id + ' · ' + new Date(p._submitted_at || Date.now()).toLocaleString()
    + '</div>'
    + '</div></body></html>';
}

function buildEmailText(p) {
  return 'NEW DPS DISCOVERY SUBMISSION\n'
    + '============================\n\n'
    + 'Contact: ' + (p.contact_name || '') + (p.business_name ? ' — ' + p.business_name : '') + '\n'
    + 'Email: ' + (p.contact_email || '') + '\n'
    + 'Phone: ' + (p.contact_phone || '—') + '\n\n'
    + 'Property count: ' + (p.property_count || '—') + '\n'
    + 'Timeline: ' + label('timeline', p.timeline) + '\n'
    + 'Build budget: ' + label('budget_build', p.budget_build) + '\n'
    + 'Monthly budget: ' + label('budget_monthly', p.budget_monthly) + '\n'
    + 'Top priority: ' + (p.priorities_ranked ? label('priorities', p.priorities_ranked.split(',')[0]) : '—') + '\n\n'
    + 'View full submission in Supabase (biz.discovery_submissions), or reply to this email to reach the client.\n';
}
