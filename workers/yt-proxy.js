/**
 * yt-proxy — Cloudflare Worker
 * Proxies YouTube Data API v3 calls so the API key never touches the browser.
 *
 * Deploy to: dreadpiratestudio.com/yt-proxy  (route via Cloudflare dashboard)
 * Secret env var to set in Worker settings: YT_API_KEY
 *
 * Supported query params from the client:
 *   ?type=live&channelId=UC...     → checks if channel is currently live
 *   ?type=videos&channelId=UC...   → returns up to 4 recent uploads
 */

export default {
  async fetch(request, env) {
    // Only allow GET
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Only allow requests from your own domain
    var origin = request.headers.get('Origin') || '';
    var referer = request.headers.get('Referer') || '';
    var allowed = origin.includes('dreadpiratestudio.com') || referer.includes('dreadpiratestudio.com');
    // Also allow localhost for local dev
    if (!allowed && (origin.includes('localhost') || referer.includes('localhost'))) {
      allowed = true;
    }
    if (!allowed) {
      return new Response('Forbidden', { status: 403 });
    }

    var url = new URL(request.url);
    var type = url.searchParams.get('type');
    var channelId = url.searchParams.get('channelId');

    if (!channelId) {
      return new Response(JSON.stringify({ error: 'channelId required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    var key = env.YT_API_KEY;
    if (!key) {
      return new Response(JSON.stringify({ error: 'API key not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    var ytUrl;
    if (type === 'live') {
      ytUrl = 'https://www.googleapis.com/youtube/v3/search'
        + '?part=snippet'
        + '&channelId=' + encodeURIComponent(channelId)
        + '&eventType=live'
        + '&type=video'
        + '&maxResults=1'
        + '&key=' + key;
    } else if (type === 'videos') {
      ytUrl = 'https://www.googleapis.com/youtube/v3/search'
        + '?part=snippet'
        + '&channelId=' + encodeURIComponent(channelId)
        + '&order=date'
        + '&type=video'
        + '&maxResults=4'
        + '&key=' + key;
    } else {
      return new Response(JSON.stringify({ error: 'type must be live or videos' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    try {
      var ytRes = await fetch(ytUrl);
      var data = await ytRes.json();
      return new Response(JSON.stringify(data), {
        status: ytRes.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': 'https://dreadpiratestudio.com',
          'Cache-Control': type === 'live' ? 'no-store' : 'public, max-age=300'
        }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'upstream fetch failed' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
