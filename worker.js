// Cloudflare Worker: HLS-aware proxy + remote-control relay for the IPTV player.
//
// Two independent jobs live in this one Worker:
//
// 1. /proxy?url=... — fixes two problems that block playing plain http://
//    IPTV streams from an https:// page: mixed-content blocking (browsers
//    refuse http subresources on an https page) and missing CORS headers on
//    the origin stream server. It re-fetches the target URL server-side and
//    streams it back over https with permissive CORS headers. For .m3u8/.m3u
//    playlists specifically, it rewrites every segment/sub-playlist URI
//    (including URI="..." attributes like #EXT-X-KEY / #EXT-X-MEDIA) to also
//    go through this same proxy, so the whole playback chain stays on https.
//
// 2. /remote/:room/state and /remote/:room/commands — a tiny KV-backed
//    mailbox pairing the desktop app with the web remote control page. The
//    desktop app PUTs its current channel list/favorites/now-playing to
//    /state and short-polls /commands; the remote page GETs /state to render
//    itself and POSTs to /commands to request a channel change. The room
//    code is a shared secret/pairing code, not a hardened auth scheme — fine
//    for personal use, not for anything sensitive.
//
// Deploy: paste this file's contents into a new Worker in the Cloudflare
// dashboard (Workers & Pages -> Create -> paste code -> Deploy), bind a KV
// namespace to it as REMOTE_KV, or via `wrangler deploy`. Then set the
// resulting *.workers.dev URL as the "Playback proxy" in the player's
// settings (and it's already the desktop app's built-in remote relay).

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function handleRemote(request, env, reqUrl, pathParts) {
  const room = pathParts[1];
  const resource = pathParts[2];
  if (!room || !/^[A-Za-z0-9_-]{1,64}$/.test(room)) {
    return jsonResponse({ error: 'Invalid room code' }, 400);
  }
  if (!env.REMOTE_KV) {
    return jsonResponse({ error: 'Remote control storage is not configured on this Worker (missing REMOTE_KV binding).' }, 500);
  }

  if (resource === 'state') {
    if (request.method === 'GET') {
      const raw = await env.REMOTE_KV.get(`state:${room}`);
      return jsonResponse(raw ? JSON.parse(raw) : null);
    }
    if (request.method === 'PUT') {
      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
      await env.REMOTE_KV.put(`state:${room}`, JSON.stringify(body), { expirationTtl: 60 * 60 * 24 * 30 });
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  if (resource === 'commands') {
    if (request.method === 'GET') {
      const after = parseInt(reqUrl.searchParams.get('after') || '0', 10) || 0;
      const raw = await env.REMOTE_KV.get(`cmds:${room}`);
      const all = raw ? JSON.parse(raw) : [];
      return jsonResponse({ commands: all.filter((c) => c.id > after) });
    }
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
      if (!body || typeof body.type !== 'string') return jsonResponse({ error: 'Missing "type"' }, 400);
      const raw = await env.REMOTE_KV.get(`cmds:${room}`);
      const all = raw ? JSON.parse(raw) : [];
      const nextId = (all.length ? all[all.length - 1].id : 0) + 1;
      const entry = { id: nextId, ts: Date.now(), type: body.type, payload: body.payload || null };
      all.push(entry);
      while (all.length > 30) all.shift();
      await env.REMOTE_KV.put(`cmds:${room}`, JSON.stringify(all), { expirationTtl: 60 * 60 * 24 });
      return jsonResponse({ ok: true, id: nextId });
    }
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const reqUrl = new URL(request.url);

    if (reqUrl.pathname.startsWith('/remote/')) {
      return handleRemote(request, env, reqUrl, reqUrl.pathname.split('/').filter(Boolean));
    }

    if (reqUrl.pathname !== '/proxy') {
      return new Response(
        'IPTV proxy + remote relay is running.\nUse /proxy?url=<encoded target url>\nor /remote/:room/state, /remote/:room/commands',
        { status: 200, headers: CORS_HEADERS }
      );
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
