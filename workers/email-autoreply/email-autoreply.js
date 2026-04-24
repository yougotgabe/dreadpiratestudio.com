/**
 * DPS Inbound Email Auto-Reply Worker
 *
 * Handles inbound emails to gabe@dreadpiratestudio.com
 * Sends a styled auto-reply via Resend if the email passes all checks
 *
 * Secrets (set via `wrangler secret put`):
 *   RESEND_API_KEY  — re_...
 *   NOTIFY_FROM     — discovery@dreadpiratestudio.com
 *   NOTIFY_EMAIL    — gabe@dreadpiratestudio.com (your actual inbox forward)
 *
 * wrangler.toml needs:
 *   [email]
 *   receiving = [{matchers = [{type = "literal", value = "gabe@dreadpiratestudio.com"}]}]
 */

// ── Your own addresses — never auto-reply to these ────────────
var OWN_ADDRESSES = [
  'gabe@dreadpiratestudio.com',
  'dreadpiratestudio@gmail.com',
  'yougotgabe@gmail.com',
  'discovery@dreadpiratestudio.com'
];

// ── Sender prefixes that indicate automated senders ───────────
var AUTOMATED_PREFIXES = [
  'no-reply',
  'noreply',
  'donotreply',
  'do-not-reply',
  'mailer-daemon',
  'postmaster',
  'bounce',
  'bounces',
  'notifications',
  'notification',
  'alerts',
  'alert'
];

// ── Subject prefixes that indicate replies/forwards ───────────
var REPLY_SUBJECT_PREFIXES = [
  're:',
  'fwd:',
  'fw:',
  'automatic reply:',
  'auto:',
  'out of office:',
  'ooo:'
];

export default {
  async email(message, env, ctx) {
    var from    = (message.from || '').toLowerCase().trim();
    var subject = (message.headers.get('subject') || '').toLowerCase().trim();

    // ── Check 1: Own addresses ────────────────────────────────
    for (var i = 0; i < OWN_ADDRESSES.length; i++) {
      if (from === OWN_ADDRESSES[i].toLowerCase()) {
        console.log('Skipping auto-reply: own address', from);
        await message.forward(env.NOTIFY_EMAIL);
        return;
      }
    }

    // ── Check 2: Reply / forward subject prefixes ─────────────
    for (var j = 0; j < REPLY_SUBJECT_PREFIXES.length; j++) {
      if (subject.startsWith(REPLY_SUBJECT_PREFIXES[j])) {
        console.log('Skipping auto-reply: reply/forward subject', subject);
        await message.forward(env.NOTIFY_EMAIL);
        return;
      }
    }

    // ── Check 3: Automated sender prefixes ───────────────────
    var localPart = from.split('@')[0] || '';
    for (var k = 0; k < AUTOMATED_PREFIXES.length; k++) {
      if (localPart.startsWith(AUTOMATED_PREFIXES[k])) {
        console.log('Skipping auto-reply: automated sender prefix', from);
        await message.forward(env.NOTIFY_EMAIL);
        return;
      }
    }

    // ── Check 4: Auto-Submitted header ───────────────────────
    var autoSubmitted = (message.headers.get('auto-submitted') || 'no').toLowerCase();
    if (autoSubmitted !== 'no') {
      console.log('Skipping auto-reply: Auto-Submitted header', autoSubmitted);
      await message.forward(env.NOTIFY_EMAIL);
      return;
    }

    // ── Check 5: List-Unsubscribe header (mailing list) ──────
    var listUnsub = message.headers.get('list-unsubscribe');
    if (listUnsub) {
      console.log('Skipping auto-reply: List-Unsubscribe header present');
      await message.forward(env.NOTIFY_EMAIL);
      return;
    }

    // ── Check 6: Precedence header (bulk/list mail) ───────────
    var precedence = (message.headers.get('precedence') || '').toLowerCase();
    if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') {
      console.log('Skipping auto-reply: Precedence header', precedence);
      await message.forward(env.NOTIFY_EMAIL);
      return;
    }

    // ── All checks passed — send auto-reply ──────────────────
    console.log('Sending auto-reply to', from);

    // Forward to your inbox first so you always get the original
    await message.forward(env.NOTIFY_EMAIL);

    // Then send the styled auto-reply
    try {
      await sendAutoReply(from, message.headers.get('subject') || 'Your inquiry', env);
      console.log('Auto-reply sent successfully to', from);
    } catch (err) {
      console.error('Auto-reply failed:', err.message);
    }
  }
};

// ── Send styled auto-reply via Resend ────────────────────────

async function sendAutoReply(toAddress, originalSubject, env) {
  var html = buildEmailHtml();

  var res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from:     env.NOTIFY_FROM,
      to:       [toAddress],
      reply_to: env.NOTIFY_EMAIL,
      subject:  'Thanks for reaching out — Dread Pirate Studio',
      headers: {
        'Auto-Submitted': 'auto-replied',
        'X-Auto-Response-Suppress': 'All'
      },
      html: html
    })
  });

  if (!res.ok) {
    var err = await res.text();
    throw new Error('Resend error: ' + res.status + ' ' + err);
  }

  return res.json();
}

// ── Build the styled HTML email ───────────────────────────────

function buildEmailHtml() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="X-UA-Compatible" content="IE=edge"><title>Thanks for reaching out — Dread Pirate Studio</title>'
    + '<style>'
    + '@import url(\'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;700;900&family=Crimson+Pro:ital,wght@0,300;0,400;1,300;1,400&display=swap\');'
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
    + '<div style="font-family:\'Cinzel\',serif;font-size:9px;letter-spacing:0.4em;color:#c9a84c;text-transform:uppercase;margin-bottom:16px;">Message Received</div>'
    + '<div style="font-family:\'Cinzel\',serif;font-size:26px;font-weight:700;color:#f0e8d8;line-height:1.3;margin-bottom:20px;">Your voyage begins<br><span style="color:#e8c96d;">here.</span></div>'
    + '<div style="display:flex;align-items:center;gap:12px;margin:0 auto;width:80%;">'
    + '<div style="flex:1;height:1px;background:linear-gradient(90deg,transparent,#2a2a4a);"></div>'
    + '<div style="width:6px;height:6px;background:#c9a84c;transform:rotate(45deg);"></div>'
    + '<div style="flex:1;height:1px;background:linear-gradient(90deg,#2a2a4a,transparent);"></div>'
    + '</div>'
    + '</div>'

    // Body
    + '<div style="padding:40px 48px;background:#0d0d14;">'
    + '<p style="font-size:17px;line-height:1.8;color:#c8c0b0;margin-bottom:20px;font-weight:300;">Thank you for reaching out to <strong style="color:#e8e0d0;font-weight:400;">Dread Pirate Studio</strong>. Your message has landed safely in port and I\'ll be reviewing it shortly.</p>'
    + '<p style="font-size:17px;line-height:1.8;color:#c8c0b0;margin-bottom:20px;font-weight:300;">Whether you\'re looking to <em style="color:#c9a84c;">launch a new website</em>, build out your brand, automate your social presence, or capture your story on video — you\'ve found the right crew for the job.</p>'

    // Promise box
    + '<div style="margin:32px 0;border:1px solid #2a2a4a;border-left:3px solid #c9a84c;background:linear-gradient(135deg,#111120 0%,#13131f 100%);padding:24px 28px;">'
    + '<div style="font-family:\'Cinzel\',serif;font-size:9px;letter-spacing:0.35em;color:#c9a84c;text-transform:uppercase;margin-bottom:12px;">What happens next</div>'
    + '<ul style="list-style:none;padding:0;">'
    + listItem('I personally review every inquiry — no automated gatekeeping')
    + listItem('You\'ll hear back within <strong style="color:#e8e0d0;font-weight:400;">1 business day</strong>, usually sooner')
    + listItem('We\'ll find a time to talk through your project at no charge')
    + listItem('No pressure, no sales script — just an honest conversation')
    + '</ul>'
    + '</div>'

    + '<p style="font-size:17px;line-height:1.8;color:#c8c0b0;margin-bottom:20px;font-weight:300;">Want to get the ball rolling even faster? Fill out the <em style="color:#c9a84c;">project intake form</em> — it helps me understand your goals, budget, and vision so I can put together an accurate estimate before we even get on a call.</p>'
    + '<p style="font-size:17px;line-height:1.8;color:#c8c0b0;margin-bottom:0;font-weight:300;">In the meantime, feel free to explore the work at <a href="https://dreadpiratestudio.com" style="color:#c9a84c;text-decoration:none;">dreadpiratestudio.com</a> or reach out directly if anything is time-sensitive.</p>'
    + '</div>'

    // CTAs
    + '<div style="display:flex;gap:16px;justify-content:center;flex-wrap:wrap;padding:8px 40px 32px;">'
    + '<a href="https://dreadpiratestudio.com/discovery/start.html" style="background:linear-gradient(135deg,#c9a84c,#e8c96d,#c9a84c);color:#0a0a0f;font-family:\'Cinzel\',serif;font-size:11px;font-weight:700;letter-spacing:0.25em;text-transform:uppercase;text-decoration:none;padding:14px 32px;display:inline-block;">Start Your Project</a>'
    + '<a href="https://dreadpiratestudio.com" style="background:transparent;color:#c9a84c;font-family:\'Cinzel\',serif;font-size:11px;font-weight:700;letter-spacing:0.25em;text-transform:uppercase;text-decoration:none;padding:13px 32px;display:inline-block;border:1px solid #c9a84c;">View the Work</a>'
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

    // Services strip
    + '<div style="background:#080810;border-top:1px solid #1e1e3a;border-bottom:1px solid #1e1e3a;padding:20px 40px;text-align:center;">'
    + '<div style="font-family:\'Cinzel\',serif;font-size:8px;letter-spacing:0.4em;color:#4a4a6a;text-transform:uppercase;margin-bottom:12px;">What we do</div>'
    + '<div style="font-family:\'Cinzel\',serif;font-size:9px;letter-spacing:0.2em;color:#5a5a7a;text-transform:uppercase;line-height:2;">'
    + 'Web Design &nbsp;·&nbsp; Brand Identity &nbsp;·&nbsp; Social Automation<br>'
    + 'Video Production &nbsp;·&nbsp; Graphic Design &nbsp;·&nbsp; Merch &amp; Digital Products'
    + '</div>'
    + '</div>'

    // Footer
    + '<div style="background:#080810;padding:28px 40px;text-align:center;">'
    + '<div style="width:40%;margin:0 auto 20px;height:1px;background:linear-gradient(90deg,transparent,#2a2a4a,transparent);"></div>'
    + '<div style="font-size:12px;color:#3a3a5a;line-height:1.8;font-weight:300;">'
    + 'You\'re receiving this because you contacted Dread Pirate Studio.<br>'
    + '<a href="https://dreadpiratestudio.com" style="color:#5a5a7a;text-decoration:none;">dreadpiratestudio.com</a>'
    + ' &nbsp;·&nbsp; Willmar, MN 56201'
    + '</div>'
    + '<div style="width:100%;height:2px;background:linear-gradient(90deg,transparent,rgba(201,168,76,0.27),#c9a84c,rgba(201,168,76,0.27),transparent);margin-top:24px;"></div>'
    + '</div>'

    + '</div>'
    + '</body></html>';
}

// ── List item helper ──────────────────────────────────────────

function listItem(text) {
  return '<li style="font-size:15px;color:#b0a898;line-height:1.7;padding:6px 0 6px 20px;position:relative;font-weight:300;">'
    + '<span style="position:absolute;left:0;top:9px;font-size:11px;color:#c9a84c;">⚓</span>'
    + text
    + '</li>';
}
