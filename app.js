(() => {
  'use strict';

  const STORAGE_KEY = 'iptv_player_playlists_v1';
  const LAST_PLAYLIST_KEY = 'iptv_player_last_playlist_v1';
  const MAX_STORED_CONTENT_LENGTH = 4 * 1024 * 1024; // 4MB safety cap for localStorage

  /** @type {{id:string,name:string,sourceType:'file'|'url'|'paste',url?:string,content?:string,addedAt:number}[]} */
  let playlists = [];
  let currentPlaylistId = null;
  let currentChannels = [];
  let activeChannelIndex = -1;
  let hls = null;

  // ---------- Elements ----------
  const els = {
    playlistSelect: document.getElementById('playlistSelect'),
    removePlaylistBtn: document.getElementById('removePlaylistBtn'),
    searchInput: document.getElementById('searchInput'),
    groupSelect: document.getElementById('groupSelect'),
    channelCount: document.getElementById('channelCount'),
    channelList: document.getElementById('channelList'),
    video: document.getElementById('video'),
    playerOverlay: document.getElementById('playerOverlay'),
    npLogo: document.getElementById('npLogo'),
    npName: document.getElementById('npName'),
    npStatus: document.getElementById('npStatus'),

    addPlaylistBtn: document.getElementById('addPlaylistBtn'),
    modalBackdrop: document.getElementById('modalBackdrop'),
    modalClose: document.getElementById('modalClose'),
    modalError: document.getElementById('modalError'),
    playlistNameInput: document.getElementById('playlistNameInput'),

    dropzone: document.getElementById('dropzone'),
    dropzoneText: document.getElementById('dropzoneText'),
    fileInput: document.getElementById('fileInput'),

    urlInput: document.getElementById('urlInput'),
    loadUrlBtn: document.getElementById('loadUrlBtn'),

    pasteInput: document.getElementById('pasteInput'),
    loadPasteBtn: document.getElementById('loadPasteBtn'),
  };

  // ---------- M3U Parsing ----------
  function parseM3U(text) {
    const lines = text.split(/\r?\n/);
    const channels = [];
    let pending = null;

    for (let rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith('#EXTM3U')) continue;

      if (line.startsWith('#EXTINF')) {
        const match = line.match(/^#EXTINF:\s*(-?\d+(?:\.\d+)?)\s*(.*?),(.*)$/s);
        let attrsStr = '', name = '';
        if (match) {
          attrsStr = match[2];
          name = match[3].trim();
        } else {
          const idx = line.indexOf(',');
          name = idx >= 0 ? line.slice(idx + 1).trim() : '';
        }
        const attrs = {};
        const attrRegex = /([a-zA-Z0-9\-]+)="([^"]*)"/g;
        let m;
        while ((m = attrRegex.exec(attrsStr))) {
          attrs[m[1].toLowerCase()] = m[2];
        }
        pending = {
          name: name || attrs['tvg-name'] || 'Unnamed channel',
          logo: attrs['tvg-logo'] || '',
          group: attrs['group-title'] || 'Uncategorized',
          tvgId: attrs['tvg-id'] || '',
        };
      } else if (line.startsWith('#EXTGRP')) {
        if (pending) {
          const g = line.split(':')[1];
          if (g && g.trim()) pending.group = g.trim();
        }
      } else if (line.startsWith('#EXTVLCOPT') || line.startsWith('#')) {
        // ignore other directives
        continue;
      } else {
        // this is a URL line
        if (pending) {
          pending.url = line;
          channels.push(pending);
          pending = null;
        } else {
          channels.push({
            name: line.split('/').pop() || line,
            url: line,
            group: 'Uncategorized',
            logo: '',
          });
        }
      }
    }
    return channels;
  }

  // ---------- Storage ----------
  function loadPlaylistsFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      playlists = raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.warn('Failed to read stored playlists', e);
      playlists = [];
    }
  }

  function savePlaylistsToStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(playlists));
    } catch (e) {
      console.warn('Failed to persist playlists (storage may be full)', e);
    }
  }

  function setLastPlaylistId(id) {
    try { localStorage.setItem(LAST_PLAYLIST_KEY, id || ''); } catch (e) { /* ignore */ }
  }

  function getLastPlaylistId() {
    try { return localStorage.getItem(LAST_PLAYLIST_KEY) || null; } catch (e) { return null; }
  }

  function makeId() {
    return 'pl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  // ---------- Playlist management ----------
  function addPlaylist({ name, sourceType, url, content }) {
    const id = makeId();
    const entry = {
      id,
      name: name || defaultNameFor(sourceType, url),
      sourceType,
      url: url || undefined,
      content: content.length <= MAX_STORED_CONTENT_LENGTH ? content : undefined,
      addedAt: Date.now(),
    };
    playlists.push(entry);
    savePlaylistsToStorage();
    renderPlaylistSelect();
    selectPlaylist(id, content);
  }

  function defaultNameFor(sourceType, url) {
    if (sourceType === 'url' && url) {
      try {
        const u = new URL(url);
        return u.hostname + u.pathname.split('/').pop();
      } catch (e) {
        return 'Playlist from URL';
      }
    }
    if (sourceType === 'file') return 'Uploaded playlist';
    return 'Pasted playlist';
  }

  function removeCurrentPlaylist() {
    if (!currentPlaylistId) return;
    if (!confirm('Remove this playlist from your saved list?')) return;
    playlists = playlists.filter(p => p.id !== currentPlaylistId);
    savePlaylistsToStorage();
    currentPlaylistId = null;
    currentChannels = [];
    setLastPlaylistId(null);
    renderPlaylistSelect();
    if (playlists.length > 0) {
      loadPlaylistById(playlists[0].id);
    } else {
      renderChannelList();
      updateChannelCount();
      stopPlayback();
    }
  }

  async function selectPlaylist(id, contentOverride) {
    const entry = playlists.find(p => p.id === id);
    if (!entry) return;
    currentPlaylistId = id;
    setLastPlaylistId(id);

    let text = contentOverride;
    if (text == null) {
      if (entry.sourceType === 'url' && entry.url) {
        try {
          const res = await fetch(entry.url);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          text = await res.text();
        } catch (e) {
          if (entry.content) {
            text = entry.content;
            showTransientMessage(`Could not refresh "${entry.name}" from its URL (using cached copy).`);
          } else {
            showTransientMessage(`Failed to load "${entry.name}" from its URL: ${e.message}`);
            currentChannels = [];
            renderChannelList();
            updateChannelCount();
            return;
          }
        }
      } else {
        text = entry.content || '';
      }
    }

    currentChannels = parseM3U(text);
    activeChannelIndex = -1;
    renderGroupOptions();
    renderChannelList();
    updateChannelCount();
    els.playlistSelect.value = id;
  }

  function loadPlaylistById(id) {
    selectPlaylist(id);
  }

  function renderPlaylistSelect() {
    els.playlistSelect.innerHTML = '';
    if (playlists.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = 'No playlists yet';
      opt.value = '';
      els.playlistSelect.appendChild(opt);
      els.playlistSelect.disabled = true;
      els.removePlaylistBtn.disabled = true;
      return;
    }
    els.playlistSelect.disabled = false;
    els.removePlaylistBtn.disabled = false;
    for (const p of playlists) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      els.playlistSelect.appendChild(opt);
    }
    if (currentPlaylistId) els.playlistSelect.value = currentPlaylistId;
  }

  // ---------- Channel list rendering ----------
  function renderGroupOptions() {
    const groups = Array.from(new Set(currentChannels.map(c => c.group || 'Uncategorized'))).sort((a, b) => a.localeCompare(b));
    const prevValue = els.groupSelect.value;
    els.groupSelect.innerHTML = '<option value="">All groups</option>';
    for (const g of groups) {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g;
      els.groupSelect.appendChild(opt);
    }
    if (groups.includes(prevValue)) els.groupSelect.value = prevValue;
  }

  function getFilteredChannels() {
    const q = els.searchInput.value.trim().toLowerCase();
    const g = els.groupSelect.value;
    return currentChannels
      .map((c, idx) => ({ ...c, idx }))
      .filter(c => (!g || c.group === g) && (!q || c.name.toLowerCase().includes(q)));
  }

  function renderChannelList() {
    const list = els.channelList;
    list.innerHTML = '';

    if (currentChannels.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = playlists.length === 0
        ? 'Add an M3U playlist to get started.'
        : 'This playlist has no channels, or none match your filters.';
      list.appendChild(empty);
      return;
    }

    const filtered = getFilteredChannels();
    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No channels match your search.';
      list.appendChild(empty);
      return;
    }

    let lastGroup = null;
    const frag = document.createDocumentFragment();
    for (const c of filtered) {
      if (c.group !== lastGroup) {
        const header = document.createElement('div');
        header.className = 'group-header';
        header.textContent = c.group || 'Uncategorized';
        frag.appendChild(header);
        lastGroup = c.group;
      }
      frag.appendChild(renderChannelItem(c, c.idx));
    }
    list.appendChild(frag);
  }

  function renderChannelItem(channel, idx) {
    const item = document.createElement('div');
    item.className = 'channel-item' + (idx === activeChannelIndex ? ' active' : '');
    item.setAttribute('role', 'button');
    item.tabIndex = 0;

    if (channel.logo) {
      const img = document.createElement('img');
      img.className = 'channel-logo';
      img.src = channel.logo;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => { img.style.visibility = 'hidden'; };
      item.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'channel-logo placeholder';
      ph.textContent = 'TV';
      item.appendChild(ph);
    }

    const name = document.createElement('div');
    name.className = 'channel-name';
    name.textContent = channel.name;
    item.appendChild(name);

    const play = () => playChannelAt(idx);
    item.addEventListener('click', play);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(); }
    });

    return item;
  }

  function updateChannelCount() {
    if (currentChannels.length === 0) {
      els.channelCount.textContent = playlists.length === 0 ? 'No playlist loaded' : '0 channels';
      return;
    }
    const filtered = getFilteredChannels().length;
    els.channelCount.textContent = filtered === currentChannels.length
      ? `${currentChannels.length} channels`
      : `${filtered} of ${currentChannels.length} channels`;
  }

  // ---------- Playback ----------
  function playChannelAt(idx) {
    const channel = currentChannels[idx];
    if (!channel || !channel.url) return;
    activeChannelIndex = idx;
    renderChannelList();
    playUrl(channel.url, channel);
  }

  function stopPlayback() {
    if (hls) { hls.destroy(); hls = null; }
    els.video.removeAttribute('src');
    els.video.load();
    setOverlay('Add a playlist and pick a channel to start watching.', false);
    els.npName.textContent = 'No channel selected';
    els.npStatus.textContent = '';
    els.npLogo.hidden = true;
  }

  function setOverlay(message, isError, hide) {
    if (hide) {
      els.playerOverlay.classList.add('hidden');
      return;
    }
    els.playerOverlay.classList.remove('hidden');
    const content = els.playerOverlay.querySelector('.overlay-content');
    content.textContent = message;
    content.classList.toggle('error', !!isError);
  }

  function playUrl(url, channel) {
    if (hls) { hls.destroy(); hls = null; }

    els.npName.textContent = channel.name;
    if (channel.logo) {
      els.npLogo.src = channel.logo;
      els.npLogo.hidden = false;
      els.npLogo.onerror = () => { els.npLogo.hidden = true; };
    } else {
      els.npLogo.hidden = true;
    }
    els.npStatus.textContent = 'Connecting…';
    setOverlay('Loading stream…', false);

    const video = els.video;
    const looksLikeHls = /\.m3u8?(\?.*)?$/i.test(url) || /\.m3u(\?.*)?$/i.test(url);

    if (looksLikeHls && window.Hls && window.Hls.isSupported()) {
      hls = new Hls({ enableWorker: true });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setOverlay('', false, true);
        els.npStatus.textContent = 'Playing';
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              els.npStatus.textContent = 'Network error, retrying…';
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              els.npStatus.textContent = 'Media error, recovering…';
              hls.recoverMediaError();
              break;
            default:
              setOverlay('Unable to play this stream (' + (data.details || 'unknown error') + ').', true);
              els.npStatus.textContent = 'Error';
              hls.destroy();
              hls = null;
              break;
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      video.addEventListener('loadedmetadata', () => {
        setOverlay('', false, true);
        els.npStatus.textContent = 'Playing';
      }, { once: true });
      video.play().catch(() => {});
    } else {
      video.src = url;
      video.play().then(() => {
        setOverlay('', false, true);
        els.npStatus.textContent = 'Playing';
      }).catch((e) => {
        setOverlay('Unable to play this stream: ' + e.message, true);
        els.npStatus.textContent = 'Error';
      });
    }

    video.onerror = () => {
      if (!hls) {
        setOverlay('Unable to play this stream. It may be offline or blocked by CORS.', true);
        els.npStatus.textContent = 'Error';
      }
    };
  }

  function showTransientMessage(msg) {
    setOverlay(msg, true);
    setTimeout(() => {
      if (els.playerOverlay.querySelector('.overlay-content').textContent === msg) {
        setOverlay('Add a playlist and pick a channel to start watching.', false);
      }
    }, 5000);
  }

  // ---------- Modal ----------
  function openModal() {
    els.modalBackdrop.hidden = false;
    els.modalError.hidden = true;
    els.playlistNameInput.value = '';
  }

  function closeModal() {
    els.modalBackdrop.hidden = true;
    els.urlInput.value = '';
    els.pasteInput.value = '';
    els.fileInput.value = '';
    els.dropzoneText.textContent = 'Drag & drop an .m3u / .m3u8 file here, or click to browse';
  }

  function showModalError(msg) {
    els.modalError.hidden = false;
    els.modalError.textContent = msg;
  }

  function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
    document.querySelectorAll('.tab-panel').forEach(p => { p.hidden = p.dataset.panel !== tabName; });
    els.modalError.hidden = true;
  }

  function handleFile(file) {
    if (!file) return;
    els.dropzoneText.textContent = file.name;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      if (!text.includes('#EXT')) {
        showModalError('This file does not look like a valid M3U playlist.');
        return;
      }
      const name = els.playlistNameInput.value.trim() || file.name;
      addPlaylist({ name, sourceType: 'file', content: text });
      closeModal();
    };
    reader.onerror = () => showModalError('Failed to read the file.');
    reader.readAsText(file);
  }

  async function handleLoadUrl() {
    const url = els.urlInput.value.trim();
    if (!url) { showModalError('Please enter a URL.'); return; }
    els.loadUrlBtn.disabled = true;
    els.loadUrlBtn.textContent = 'Loading…';
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (!text.includes('#EXT')) {
        showModalError('The fetched content does not look like a valid M3U playlist.');
        return;
      }
      const name = els.playlistNameInput.value.trim() || undefined;
      addPlaylist({ name, sourceType: 'url', url, content: text });
      closeModal();
    } catch (e) {
      showModalError('Could not load playlist from URL: ' + e.message + '. The server may not allow cross-origin requests (CORS).');
    } finally {
      els.loadUrlBtn.disabled = false;
      els.loadUrlBtn.textContent = 'Load from URL';
    }
  }

  function handleLoadPaste() {
    const text = els.pasteInput.value.trim();
    if (!text) { showModalError('Please paste some M3U content.'); return; }
    if (!text.includes('#EXT')) {
      showModalError('This does not look like valid M3U content.');
      return;
    }
    const name = els.playlistNameInput.value.trim() || undefined;
    addPlaylist({ name, sourceType: 'paste', content: text });
    closeModal();
  }

  // ---------- Wiring ----------
  function init() {
    loadPlaylistsFromStorage();
    renderPlaylistSelect();

    const lastId = getLastPlaylistId();
    if (playlists.length > 0) {
      const idToLoad = (lastId && playlists.some(p => p.id === lastId)) ? lastId : playlists[0].id;
      selectPlaylist(idToLoad);
    } else {
      updateChannelCount();
    }

    els.playlistSelect.addEventListener('change', (e) => selectPlaylist(e.target.value));
    els.removePlaylistBtn.addEventListener('click', removeCurrentPlaylist);

    els.searchInput.addEventListener('input', () => { renderChannelList(); updateChannelCount(); });
    els.groupSelect.addEventListener('change', () => { renderChannelList(); updateChannelCount(); });

    els.addPlaylistBtn.addEventListener('click', openModal);
    els.modalClose.addEventListener('click', closeModal);
    els.modalBackdrop.addEventListener('click', (e) => { if (e.target === els.modalBackdrop) closeModal(); });

    document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

    els.fileInput.addEventListener('change', () => handleFile(els.fileInput.files[0]));
    els.dropzone.addEventListener('dragover', (e) => { e.preventDefault(); els.dropzone.classList.add('dragover'); });
    els.dropzone.addEventListener('dragleave', () => els.dropzone.classList.remove('dragover'));
    els.dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      els.dropzone.classList.remove('dragover');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) handleFile(file);
    });

    els.loadUrlBtn.addEventListener('click', handleLoadUrl);
    els.loadPasteBtn.addEventListener('click', handleLoadPaste);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !els.modalBackdrop.hidden) closeModal();
    });
  }

  init();
})();
