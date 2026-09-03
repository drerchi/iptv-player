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

## Why a stream might not play: mixed content & CORS

Playback happens directly in your browser, so two browser security rules apply:

- **Mixed content**: if this page is loaded over `https://` (e.g. GitHub Pages) but a playlist/stream URL is plain `http://`, the browser silently blocks the request — no error is even sent, it just fails. This is extremely common with IPTV providers. Opening the app from a plain `http://` origin, or via `file://` (double-clicking `index.html`) is *not* subject to this rule, which is why it can work locally but fail once hosted on an https site.
- **CORS**: the streaming/playlist server must also allow cross-origin requests for your browser to read the response.

If a channel or playlist fails specifically on an https-hosted deployment, this is almost always the cause.

### Fix: use the included proxy (`worker.js`)

This repo includes `worker.js`, a small [Cloudflare Worker](https://workers.cloudflare.com/) that re-fetches playlists/streams server-side and re-serves them over https with CORS enabled — including rewriting every URL inside an `.m3u8` playlist (segments, sub-playlists, encryption keys) so the whole playback chain stays proxied.

**Deploy it (free, ~2 minutes, no CLI needed):**
1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → sign in / sign up free → **Workers & Pages** → **Create** → **Create Worker**.
2. Give it a name (e.g. `iptv-proxy`), click **Deploy** to create it, then **Edit code**.
3. Delete the placeholder code, paste in the contents of [`worker.js`](worker.js), click **Deploy**.
4. Copy the worker's URL (looks like `https://iptv-proxy.<your-subdomain>.workers.dev`).
5. In the IPTV player, open **+ Playlist**, expand **Playback proxy (optional)** at the bottom, and paste that URL in.

From then on, playlists and streams are fetched through your own proxy, avoiding both the mixed-content block and CORS issues. Leave the field blank to go back to loading streams directly (fine for `https://` playlists whose server allows CORS).

## Notes

- Playlists are stored in your browser's `localStorage`, scoped to this folder/origin — clearing browser data will remove them.
- Very large playlists (roughly >4MB of text) loaded via URL are not cached locally; they're re-fetched each time you select them.
