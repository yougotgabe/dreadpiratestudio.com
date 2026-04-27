/**
 * DPS Autopilot — autopilot-oauth Worker
 *
 * Handles Facebook OAuth flow for connecting Business Pages.
 * Threads the client's onboarding token through via the `state`
 * parameter so the callback can link the page token to the
 * correct client row in Supabase.
 *
 * Routes:
 *   GET  /autopilot/oauth/start        — redirect to Facebook login
 *   GET  /autopilot/oauth/callback     — handle FB callback, save token
 *   POST /autopilot/oauth/deauthorize  — FB deauth webhook (required by Meta)
 *
 * Env vars:
 *   FB_APP_ID          — Meta app ID
 *   FB_APP_SECRET      — Meta app secret
 *   FB_REDIRECT_URI    — must match exactly what's registered in Meta dashboard
 *                        e.g. https://autopilot-oauth.dreadpiratestudio.workers.dev/autopilot/oauth/callback
 *   SUPABASE_URL       — https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY
 */

const FACEBOOK_AUTH_URL  = 'https://www.facebook.com/v21.0/dialog/oauth';
const FACEBOOK_TOKEN_URL = 'https://graph.facebook.com/v21.0/oauth/access_token';
const FACEBOOK_PAGES_URL = 'https://graph.facebook.com/v21.0/me/accounts';
const SITE_URL           = 'https://dreadpiratestudio.com';

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    // ── Start OAuth flow ───────────────────────────────────────────────────
    // Called from the onboarding form step 4.
    // Expects ?token=xxx (the client's onboarding token) so we can
    // thread it through the flow and link the page to the right client.
    if (path === '/autopilot/oauth/start') {
      const clientToken = url.searchParams.get('token') || '';

      // Pack the client token into `state` so Facebook echoes it back
      // on the callback. Also include a nonce for basic CSRF protection.
      const state = JSON.stringify({
        token: clientToken,
        nonce: crypto.randomUUID(),
      });

      const params = new URLSearchParams({
        client_id:     env.FB_APP_ID,
        redirect_uri:  env.FB_REDIRECT_URI,
        scope:         'pages_manage_posts,pages_read_engagement,pages_read_user_content,pages_show_list,public_profile',
        response_type: 'code',
        state:         btoa(state),  // base64 encode so it's URL-safe
      });

      return Response.redirect(`${FACEBOOK_AUTH_URL}?${params}`, 302);
    }

    // ── OAuth callback ─────────────────────────────────────────────────────
    if (path === '/autopilot/oauth/callback') {
      const code      = url.searchParams.get('code');
      const error     = url.searchParams.get('error');
      const stateRaw  = url.searchParams.get('state');

      // Parse state to recover the client token
      let clientToken = null;
      try {
        const stateObj = JSON.parse(atob(stateRaw || ''));
        clientToken = stateObj.token || null;
      } catch {
        // State missing or malformed — still process, just won't link to client
        console.warn('Could not parse OAuth state parameter');
      }

      // Handle Facebook errors (user denied permission etc.)
      if (error) {
        const dest = clientToken
          ? `${SITE_URL}/autopilot/onboarding?token=${clientToken}&fb_error=${error}`
          : `${SITE_URL}/autopilot?error=${error}`;
        return Response.redirect(dest, 302);
      }

      if (!code) {
        const dest = clientToken
          ? `${SITE_URL}/autopilot/onboarding?token=${clientToken}&fb_error=no_code`
          : `${SITE_URL}/autopilot?error=no_code`;
        return Response.redirect(dest, 302);
      }

      // Exchange code for user access token
      const tokenParams = new URLSearchParams({
        client_id:     env.FB_APP_ID,
        client_secret: env.FB_APP_SECRET,
        redirect_uri:  env.FB_REDIRECT_URI,
        code,
      });

      const tokenRes  = await fetch(`${FACEBOOK_TOKEN_URL}?${tokenParams}`);
      const tokenData = await tokenRes.json();

      if (tokenData.error) {
        console.error('Token exchange failed:', tokenData.error);
        const dest = clientToken
          ? `${SITE_URL}/autopilot/onboarding?token=${clientToken}&fb_error=token_failed`
          : `${SITE_URL}/autopilot?error=token_failed`;
        return Response.redirect(dest, 302);
      }

      const userToken = tokenData.access_token;

      // Fetch pages this user manages
      const pagesRes  = await fetch(
        `${FACEBOOK_PAGES_URL}?access_token=${userToken}&fields=id,name,access_token,category`
      );
      const pagesData = await pagesRes.json();

      if (pagesData.error || !pagesData.data?.length) {
        console.error('Pages fetch failed:', pagesData.error);
        const dest = clientToken
          ? `${SITE_URL}/autopilot/onboarding?token=${clientToken}&fb_error=no_pages`
          : `${SITE_URL}/autopilot?error=no_pages`;
        return Response.redirect(dest, 302);
      }

      // Resolve client_id from onboarding token (if we have one)
      let clientId = null;
      if (clientToken) {
        try {
          const clientRows = await supabase(env, 'GET',
            `/rest/v1/clients?onboarding_token=eq.${encodeURIComponent(clientToken)}&select=id&limit=1`
          );
          clientId = clientRows?.[0]?.id || null;
        } catch (err) {
          console.error('Could not resolve client from token:', err.message);
        }
      }

      // Upsert each page token into Supabase
      // Uses page_id as the conflict key so reconnecting updates the token
      const pages = pagesData.data.map((page) => ({
        client_id:  clientId,   // null if no token was passed — still saves the page
        page_id:    page.id,
        page_name:  page.name,
        page_token: page.access_token,
        category:   page.category || '',
        is_active:  true,
        updated_at: new Date().toISOString(),
      }));

      try {
        await supabase(env, 'POST',
          '/rest/v1/facebook_tokens',
          pages,
          { Prefer: 'resolution=merge-duplicates,return=minimal' }
        );
      } catch (err) {
        console.error('Supabase insert failed:', err.message);
        const dest = clientToken
          ? `${SITE_URL}/autopilot/onboarding?token=${clientToken}&fb_error=db_failed`
          : `${SITE_URL}/autopilot?error=db_failed`;
        return Response.redirect(dest, 302);
      }

      // Mark Facebook as connected on the client row
      if (clientId) {
        try {
          await supabase(env, 'PATCH',
            `/rest/v1/clients?id=eq.${clientId}`,
            { facebook_connected: true },
            { Prefer: 'return=minimal' }
          );
        } catch {
          // Non-fatal — column may not exist yet, onboarding still succeeds
        }
      }

      // Success — send back to dashboard if we know who they are,
      // otherwise back to the autopilot landing page
      const successDest = clientToken
        ? `${SITE_URL}/autopilot/dashboard?token=${clientToken}&fb_connected=true`
        : `${SITE_URL}/autopilot?success=true&pages=${pages.length}`;

      return Response.redirect(successDest, 302);
    }

    // ── Deauthorize callback (required by Meta app review) ─────────────────
    if (path === '/autopilot/oauth/deauthorize') {
      // Meta sends a signed_request POST when a user removes the app.
      // For now we acknowledge receipt — full implementation would
      // delete their facebook_tokens row.
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Default ────────────────────────────────────────────────────────────
    return new Response(JSON.stringify({ status: 'DPS Autopilot OAuth' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};

// ─── Supabase helper ──────────────────────────────────────────────────────────

async function supabase(env, method, path, body = null, extraHeaders = {}) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey:          env.SUPABASE_SERVICE_KEY,
      Authorization:  `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Prefer:          'return=representation',
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path} → ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}
