// Cloudflare Worker: HLS-aware proxy for the IPTV player.
//
// Fixes two problems that block playing plain http:// IPTV streams from an
// https:// page: mixed-content blocking (browsers refuse http subresources
// on an https page) and missing CORS headers on the origin stream server.
//
// It re-fetches the target URL server-side and streams it back over https
// with permissive CORS headers. For .m3u8/.m3u playlists specifically, it
// rewrites every segment/sub-playlist URI (including URI="..." attributes
// like #EXT-X-KEY / #EXT-X-MEDIA) to also go through this same proxy, so
// the whole playback chain stays on https.
//
// Deploy: paste this file's contents into a new Worker in the Cloudflare
// dashboard (Workers & Pages -> Create -> paste code -> Deploy), or via
// `wrangler deploy`. Then set the resulting *.workers.dev URL as the
// "Playback proxy" in the player's settings.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const reqUrl = new URL(request.url);
    if (reqUrl.pathname !== '/proxy') {
      return new Response('IPTV proxy is running. Use /proxy?url=<encoded target url>', {
        status: 200,
        headers: CORS_HEADERS,
      });
    }

    const target = reqUrl.searchParams.get('url');
    if (!target) {
      return new Response('Missing "url" parameter', { status: 400, headers: CORS_HEADERS });
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch (e) {
      return new Response('Invalid "url" parameter', { status: 400, headers: CORS_HEADERS });
    }
    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
      return new Response('Unsupported protocol', { status: 400, headers: CORS_HEADERS });
    }

    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        headers: {
          'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0',
          'Range': request.headers.get('Range') || undefined,
        },
      });
    } catch (e) {
      return new Response('Upstream fetch failed: ' + e.message, { status: 502, headers: CORS_HEADERS });
    }

    const contentType = upstream.headers.get('content-type') || '';
    const looksLikePlaylist =
      /mpegurl/i.test(contentType) || /\.m3u8?(\?|$)/i.test(targetUrl.pathname);

    if (looksLikePlaylist) {
      const text = await upstream.text();
      const selfBase = `${reqUrl.origin}${reqUrl.pathname}`;
      const proxify = (absoluteUrl) => `${selfBase}?url=${encodeURIComponent(absoluteUrl)}`;

      const rewritten = text
        .split(/\r?\n/)
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;
          if (trimmed.startsWith('#')) {
            return trimmed.replace(/URI="([^"]+)"/i, (m, uri) => {
              try {
                return `URI="${proxify(new URL(uri, targetUrl).toString())}"`;
              } catch (e) {
                return m;
              }
            });
          }
          try {
            return proxify(new URL(trimmed, targetUrl).toString());
          } catch (e) {
            return trimmed;
          }
        })
        .join('\n');

      return new Response(rewritten, {
        status: upstream.status,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-store',
        },
      });
    }

    const headers = new Headers(CORS_HEADERS);
    for (const h of ['content-type', 'content-length', 'cache-control', 'accept-ranges', 'content-range']) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }

    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
