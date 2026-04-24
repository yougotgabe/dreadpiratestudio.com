/**
 * DPS Discovery Form Submission Handler — v2
 *
 * Receives POST from any DPS discovery form at /api/discovery
 * - Validates payload
 * - Saves to Supabase biz.discovery_submissions
 * - Sends YOU a notification email (Gabe's inbox)
 * - Sends the SUBMITTER a confirmation email
 *
 * Secrets (set via `wrangler secret put`):
 *   SUPABASE_URL         — https://xxxxx.supabase.co
 *   SUPABASE_SERVICE_KEY — service_role key (NOT anon key)
 *   RESEND_API_KEY       — re_...
 *   NOTIFY_EMAIL         — gabe@dreadpiratestudio.com
 *   NOTIFY_FROM          — discovery@dreadpiratestudio.com
 *   ALLOWED_ORIGIN       — https://dreadpiratestudio.com
 */

// ── Human-readable labels for each form type ─────────────────
var FORM_LABELS = {
  airbnb_rental:           'Direct Booking Site — Vacation Rental',
  storefront_hospitality:  'Storefront & Hospitality',
  experience_rental:       'Experience & Rental',
  trade_service:           'Trade & Service',
  creative_maker:          'Creative & Maker',
  professional_consultant: 'Professional & Consultant',
  general:                 'General Discovery'
};

export default {
  async fetch(request, env) {
    var url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request, env) });
    }

    if (url.pathname !== '/api/discovery') {
      return new Response('Not found', { status: 404 });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      var payload = await request.json();

      // Basic validation
      if (!payload.contact_name || !payload.contact_email) {
        return json({ error: 'Missing required fields' }, 400, request, env);
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.contact_email)) {
        return json({ error: 'Invalid email' }, 400, request, env);
      }

      // Save to Supabase first — if this fails, we want to know
      var record = await saveToSupabase(payload, env);

      // Send both emails — errors here don't fail the request
      try {
        await Promise.all([
          sendNotificationEmail(payload, record, env),
          sendConfirmationEmail(payload, env)
        ]);
      } catch (err) {
        console.error('Email send failed:', err.message);
      }

      return json({ ok: true, id: record.id }, 200, request, env);

    } catch (err) {
      console.error('Submission error:', err.message, err.stack);
      return json({ error: 'Internal error' }, 500, request, env);
    }
  }
};

// ── Supabase ──────────────────────────────────────────────────

async function saveToSupabase(payload, env) {
  var res = await fetch(env.SUPABASE_URL + '/rest/v1/discovery_submissions', {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      'Content-Profile': 'biz',
      'Accept-Profile': 'biz'
    },
    body: JSON.stringify({
      form_type:     payload._form_type || 'general',
      contact_name:  payload.contact_name,
      business_name: payload.business_name || null,
      contact_email: payload.contact_email,
      contact_phone: payload.contact_phone || null,
      payload:       payload,
      user_agent:    payload._user_agent || null,
      submitted_at:  payload._submitted_at || new Date().toISOString(),
      status:        'new'
    })
  });

  if (!res.ok) {
    var err = await res.text();
    throw new Error('Supabase error: ' + res.status + ' ' + err);
  }

  var data = await res.json();
  return Array.isArray(data) ? data[0] : data;
}

// ── Notification email to Gabe ────────────────────────────────

async function sendNotificationEmail(payload, record, env) {
  var formLabel = FORM_LABELS[payload._form_type] || payload._form_type || 'Unknown Form';
  var name      = payload.contact_name || 'Unknown';
  var biz       = payload.business_name ? ' — ' + payload.business_name : '';
  var email     = payload.contact_email;
  var phone     = payload.contact_phone || 'Not provided';
  var location  = payload.location || 'Not provided';
  var budget    = payload.budget_build || 'Not specified';
  var timeline  = payload.timeline || 'Not specified';
  var id        = record ? record.id : 'N/A';

  // Build a plain-text summary of ALL payload fields for easy scanning
  var fieldRows = Object.entries(payload)
    .filter(function(e) { return !e[0].startsWith('_'); })
    .map(function(e) {
      var val = Array.isArray(e[1]) ? e[1].join(', ') : (e[1] || '—');
      return '<tr><td style="padding:4px 12px 4px 0;color:#9a9aaa;font-size:13px;vertical-align:top;white-space:nowrap;">'
        + e[0].replace(/_/g,' ')
        + '</td><td style="padding:4px 0;font-size:13px;color:#e8e0d0;">'
        + val
        + '</td></tr>';
    })
    .join('');

  var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="background:#0a0a0f;color:#e8e0d0;font-family:Georgia,serif;padding:32px;">'
    + '<div style="max-width:640px;margin:0 auto;background:#0d0d14;border:1px solid rgba(201,168,76,0.2);padding:32px;">'
    + '<div style="border-left:3px solid #c9a84c;padding-left:16px;margin-bottom:28px;">'
    + '<p style="font-size:11px;letter-spacing:0.3em;text-transform:uppercase;color:#c9a84c;margin:0 0 6px;">New Discovery Submission</p>'
    + '<h1 style="font-size:22px;color:#e8c96d;margin:0 0 4px;">' + name + biz + '</h1>'
    + '<p style="font-size:13px;color:#7a7a9a;margin:0;">' + formLabel + ' &nbsp;·&nbsp; ID: ' + id + '</p>'
    + '</div>'
    + '<table style="margin-bottom:24px;"><tr><td style="padding:4px 12px 4px 0;color:#9a9aaa;font-size:13px;white-space:nowrap;">Email</td><td style="font-size:13px;"><a href="mailto:' + email + '" style="color:#c9a84c;">' + email + '</a></td></tr>'
    + '<tr><td style="padding:4px 12px 4px 0;color:#9a9aaa;font-size:13px;white-space:nowrap;">Phone</td><td style="font-size:13px;color:#e8e0d0;">' + phone + '</td></tr>'
    + '<tr><td style="padding:4px 12px 4px 0;color:#9a9aaa;font-size:13px;white-space:nowrap;">Location</td><td style="font-size:13px;color:#e8e0d0;">' + location + '</td></tr>'
    + '<tr><td style="padding:4px 12px 4px 0;color:#9a9aaa;font-size:13px;white-space:nowrap;">Build budget</td><td style="font-size:13px;color:#e8e0d0;">' + budget + '</td></tr>'
    + '<tr><td style="padding:4px 12px 4px 0;color:#9a9aaa;font-size:13px;white-space:nowrap;">Timeline</td><td style="font-size:13px;color:#e8e0d0;">' + timeline + '</td></tr>'
    + '</table>'
    + '<hr style="border:none;border-top:1px solid rgba(201,168,76,0.1);margin:24px 0;">'
    + '<p style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#5a5a7a;margin-bottom:12px;">All fields</p>'
    + '<table style="width:100%;">' + fieldRows + '</table>'
    + '</div></body></html>';

  return sendViaResend({
    from:    env.NOTIFY_FROM,
    to:      env.NOTIFY_EMAIL,
    subject: '🏴‍☠️ New discovery: ' + name + biz + ' [' + formLabel + ']',
    html:    html
  }, env);
}

// ── Confirmation email to the submitter ───────────────────────

async function sendConfirmationEmail(payload, env) {
  var formLabel = FORM_LABELS[payload._form_type] || 'Discovery Questionnaire';
  var firstName = (payload.contact_name || 'there').split(' ')[0];

  var html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">'
    + '<style>@import url(\'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;700;900&family=Crimson+Pro:ital,wght@0,300;0,400;1,300;1,400&display=swap\');'
    + '*{margin:0;padding:0;box-sizing:border-box;}'
    + 'body{background-color:#0a0a0f;font-family:\'Crimson Pro\',Georgia,serif;color:#e8e0d0;-webkit-font-smoothing:antialiased;}'
    + '</style></head><body>'
    + '<div style="max-width:620px;margin:0 auto;background:#0d0d14;">'

    // Header
    + '<div style="background:linear-gradient(160deg,#0a0a0f 0%,#111128 50%,#0a0a0f 100%);padding:48px 40px 36px;text-align:center;border-bottom:1px solid #2a2a4a;">'
    + '<div style="width:100%;height:3px;background:linear-gradient(90deg,transparent,#c9a84c,#e8c96d,#c9a84c,transparent);margin-bottom:36px;"></div>'
    + '<div style="font-size:48px;line-height:1;margin-bottom:16px;filter:drop-shadow(0 0 12px rgba(201,168,76,0.4));">☠</div>'
    + '<div style="font-family:\'Cinzel\',serif;font-size:28px;font-weight:900;letter-spacing:0.12em;color:#e8c96d;text-transform:uppercase;line-height:1;margin-bottom:4px;">Dread Pirate Studio</div>'
    + '<div style="font-family:\'Cinzel\',serif;font-size:10px;letter-spacing:0.35em;color:#7a7a9a;text-transform:uppercase;margin-bottom:28px;">Creative Services &nbsp;·&nbsp; Willmar, MN</div>'
    + '<div style="width:60%;margin:0 auto;height:1px;background:linear-gradient(90deg,transparent,#2a2a4a,transparent);"></div>'
    + '</div>'

    // Hero band
    + '<div style="background:linear-gradient(135deg,#141428 0%,#1a1a38 50%,#141428 100%);padding:40px 40px 36px;text-align:center;border-bottom:1px solid #1e1e3a;">'
    + '<div style="font-family:\'Cinzel\',serif;font-size:9px;letter-spacing:0.4em;color:#c9a84c;text-transform:uppercase;margin-bottom:16px;">Discovery Received</div>'
    + '<div style="font-family:\'Cinzel\',serif;font-size:26px;font-weight:700;color:#f0e8d8;line-height:1.3;margin-bottom:20px;">Your questionnaire<br>has <span style="color:#e8c96d;">landed safely.</span></div>'
    + '<div style="display:flex;align-items:center;gap:12px;margin:0 auto;width:80%;">'
    + '<div style="flex:1;height:1px;background:linear-gradient(90deg,transparent,#2a2a4a);"></div>'
    + '<div style="width:6px;height:6px;background:#c9a84c;transform:rotate(45deg);"></div>'
    + '<div style="flex:1;height:1px;background:linear-gradient(90deg,#2a2a4a,transparent);"></div>'
    + '</div>'
    + '</div>'

    // Body
    + '<div style="padding:40px 48px;background:#0d0d14;">'
    + '<div style="text-align:center;margin-bottom:28px;">'
    + '<span style="display:inline-block;background:rgba(201,168,76,0.1);border:1px solid rgba(201,168,76,0.3);padding:6px 16px;font-family:\'Cinzel\',serif;font-size:9px;letter-spacing:0.3em;text-transform:uppercase;color:#c9a84c;">' + formLabel + '</span>'
    + '</div>'
    + '<p style="font-size:17px;line-height:1.8;color:#c8c0b0;margin-bottom:20px;font-weight:300;">Thank you for taking the time to fill that out, <strong style="color:#e8e0d0;font-weight:400;">' + firstName + '</strong> — seriously. The detail you provided makes a real difference. Instead of starting our conversation from scratch, Gabe can walk in already understanding your business, your goals, and what success looks like for you.</p>'
    + '<p style="font-size:17px;line-height:1.8;color:#c8c0b0;margin-bottom:20px;font-weight:300;">Your responses are in. Here\'s what happens next:</p>'

    // Timeline box
    + '<div style="margin:32px 0;border:1px solid #2a2a4a;border-left:3px solid #c9a84c;background:linear-gradient(135deg,#111120 0%,#13131f 100%);padding:24px 28px;">'
    + '<div style="font-family:\'Cinzel\',serif;font-size:9px;letter-spacing:0.35em;color:#c9a84c;text-transform:uppercase;margin-bottom:16px;">What to expect</div>'
    + '<ol style="list-style:none;padding:0;">'
    + timelineItem('1', '<strong style="color:#e8e0d0;font-weight:400;">Gabe reviews your responses</strong> — usually within a few hours, always within 1 business day.')
    + timelineItem('2', '<strong style="color:#e8e0d0;font-weight:400;">You\'ll receive a written summary</strong> — scope, timeline, and investment options tailored to what you described.')
    + timelineItem('3', '<strong style="color:#e8e0d0;font-weight:400;">We schedule a call if you want one</strong> — only if it would help. Some projects are clear enough to move forward without one.')
    + timelineItem('4', '<strong style="color:#e8e0d0;font-weight:400;">No pressure, ever</strong> — if the proposal isn\'t a fit, that\'s okay. No hard feelings and no follow-up harassment.')
    + '</ol>'
    + '</div>'

    + '<p style="font-size:17px;line-height:1.8;color:#c8c0b0;margin-bottom:20px;font-weight:300;">In the meantime, if anything changes or you think of something you forgot to mention, just reply to this email. It goes straight to Gabe.</p>'
    + '<p style="font-size:17px;line-height:1.8;color:#c8c0b0;margin-bottom:0;font-weight:300;">Looking forward to seeing what we can build together.</p>'
    + '</div>'

    // Signature
    + '<div style="padding:0 48px 40px;">'
    + '<div style="height:1px;background:linear-gradient(90deg,#2a2a4a,transparent);margin-bottom:28px;"></div>'
    + '<div style="font-family:\'Cinzel\',serif;font-size:16px;font-weight:700;color:#e8c96d;margin-bottom:2px;">Gabe Nelson</div>'
    + '<div style="font-family:\'Cinzel\',serif;font-size:9px;letter-spacing:0.3em;color:#7a7a9a;text-transform:uppercase;margin-bottom:14px;">Founder &nbsp;·&nbsp; Dread Pirate Studio</div>'
    + '<div style="font-size:14px;color:#7a7a9a;line-height:1.9;font-weight:300;">'
    + '<a href="mailto:gabe@dreadpiratestudio.com" style="color:#c9a84c;text-decoration:none;">gabe@dreadpiratestudio.com</a><br>'
    + '<a href="https://dreadpiratestudio.com" style="color:#c9a84c;text-decoration:none;">dreadpiratestudio.com</a><br>'
    + 'Willmar, MN'
    + '</div>'
    + '</div>'

    // Reassurance strip
    + '<div style="background:#080810;border-top:1px solid #1e1e3a;border-bottom:1px solid #1e1e3a;padding:20px 40px;text-align:center;">'
    + '<div style="font-family:\'Cinzel\',serif;font-size:8px;letter-spacing:0.4em;color:#4a4a6a;text-transform:uppercase;margin-bottom:10px;">A note on your information</div>'
    + '<p style="font-size:14px;color:#5a5a7a;line-height:1.7;font-weight:300;font-style:italic;">Everything you shared is kept strictly between you and Gabe. Your responses are never shared, sold, or used for anything other than putting together your proposal. Questions? <a href="mailto:gabe@dreadpiratestudio.com" style="color:#7a6a3a;text-decoration:none;">Just ask.</a></p>'
    + '</div>'

    // Footer
    + '<div style="background:#080810;padding:28px 40px;text-align:center;">'
    + '<div style="width:40%;margin:0 auto 20px;height:1px;background:linear-gradient(90deg,transparent,#2a2a4a,transparent);"></div>'
    + '<div style="font-size:12px;color:#3a3a5a;line-height:1.8;font-weight:300;">You\'re receiving this because you submitted a discovery questionnaire to Dread Pirate Studio.<br>'
    + '<a href="https://dreadpiratestudio.com" style="color:#5a5a7a;text-decoration:none;">dreadpiratestudio.com</a>'
    + ' &nbsp;·&nbsp; Willmar, MN 56201</div>'
    + '<div style="width:100%;height:2px;background:linear-gradient(90deg,transparent,rgba(201,168,76,0.27),#c9a84c,rgba(201,168,76,0.27),transparent);margin-top:24px;"></div>'
    + '</div>'

    + '</div>'
    + '</body></html>';

  return sendViaResend({
    from:    env.NOTIFY_FROM,
    to:      payload.contact_email,
    replyTo: env.NOTIFY_EMAIL,
    subject: 'Your discovery questionnaire is in — Dread Pirate Studio',
    html:    html
  }, env);
}

// ── Timeline item helper ──────────────────────────────────────

function timelineItem(num, text) {
  return '<li style="font-size:15px;color:#b0a898;line-height:1.7;padding:8px 0 8px 36px;position:relative;font-weight:300;border-bottom:1px solid rgba(201,168,76,0.06);">'
    + '<span style="position:absolute;left:0;top:10px;font-family:\'Cinzel\',serif;font-size:10px;font-weight:700;color:#c9a84c;width:20px;height:20px;border:1px solid #c9a84c;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;line-height:1;">' + num + '</span>'
    + text
    + '</li>';
}

// ── Resend API call ───────────────────────────────────────────

async function sendViaResend(opts, env) {
  var body = {
    from:    opts.from,
    to:      [opts.to],
    subject: opts.subject,
    html:    opts.html
  };
  if (opts.replyTo) body.reply_to = opts.replyTo;

  var res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    var err = await res.text();
    throw new Error('Resend error: ' + res.status + ' ' + err);
  }

  return res.json();
}

// ── CORS + JSON helpers ───────────────────────────────────────

function corsHeaders(request, env) {
  var origin = (request.headers.get('Origin') || '');
  var allow  = origin.includes('dreadpiratestudio.com')
    ? origin
    : (env.ALLOWED_ORIGIN || 'https://dreadpiratestudio.com');
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400'
  };
}

function json(body, status, request, env) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      corsHeaders(request, env)
    )
  });
}
