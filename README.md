# IPTV Player

A local, browser-based IPTV player. Upload/paste/link an M3U or M3U8 playlist and watch channels directly — no server or install required.

## How to run it

Just open `index.html` in a modern browser (Chrome, Edge, Firefox):

- Double-click `index.html` in File Explorer, **or**
- Right-click → Open with → your browser

That's it — everything runs client-side. Because it's a real page in your own browser (not a sandboxed embed), it can connect straight to your IPTV provider's stream URLs and play them live via [hls.js](https://github.com/video-dev/hls.js).

Optional: for the smoothest experience (and to avoid any `file://` quirks in some browsers), serve the folder locally instead:

```
# with Node
npx serve .

# or with Python
python -m http.server 8080
```

Then visit the printed `http://localhost:...` URL.

## Using it

1. Click **+ Playlist** (top left).
2. Choose how to add your list:
   - **Upload file** — drag & drop or browse to an `.m3u` / `.m3u8` file.
   - **From URL** — paste a link to a hosted playlist (the server must allow CORS — see below).
   - **Paste text** — paste raw M3U content directly.
3. Your playlist is saved in the browser (`localStorage`) and reloads automatically next time you open the app. Add multiple playlists and switch between them with the dropdown.
4. Use the search box and group filter to find a channel, then click it to start playing.

## About CORS (why a stream might not play)

Because playback happens directly in your browser, the streaming server itself must allow your browser to fetch it (via CORS headers) for playback to succeed — this is a restriction imposed by browsers, not by this app. Most dedicated IPTV/HLS providers already allow this. If a channel fails to load, it usually means:

- the stream is offline, or
- the provider blocks cross-origin playback from browsers, or
- the URL requires a different protocol player (e.g. plain RTMP, which browsers can't play natively).

For "From URL" playlist loading specifically, the same CORS rule applies to fetching the `.m3u` file itself — if it fails, download the file and use "Upload file" or "Paste text" instead.

## Notes

- Playlists are stored in your browser's `localStorage`, scoped to this folder/origin — clearing browser data will remove them.
- Very large playlists (roughly >4MB of text) loaded via URL are not cached locally; they're re-fetched each time you select them.
