(() => {
  'use strict';

  const RELAY_BASE = 'https://iptv-proxy.soleral-com.workers.dev';
  const ROOM_STORAGE_KEY = 'iptv_remote_room_v1';
  const STATE_POLL_MS = 3000;

  let room = '';
  let state = { channels: [], favorites: [], nowPlaying: null };
  let currentView = 'channels';
  let statePollTimer = null;

  const els = {
    pairView: document.getElementById('pairView'),
    roomInput: document.getElementById('roomInput'),
    connectBtn: document.getElementById('connectBtn'),
    pairError: document.getElementById('pairError'),

    remoteView: document.getElementById('remoteView'),
    connInfo: document.getElementById('connInfo'),
    roomLabel: document.getElementById('roomLabel'),
    connStatus: document.getElementById('connStatus'),
    disconnectBtn: document.getElementById('disconnectBtn'),

    npLogo: document.getElementById('npLogo'),
    npName: document.getElementById('npName'),
    stopBtn: document.getElementById('stopBtn'),

    searchInput: document.getElementById('searchInput'),
    groupSelect: document.getElementById('groupSelect'),
    channelList: document.getElementById('channelList'),
  };

  function getRoomFromUrl() {
    const m = location.hash.match(/room=([A-Za-z0-9_-]+)/);
    return m ? m[1].toUpperCase() : '';
  }

  function connect(code) {
    room = code.trim().toUpperCase();
    if (!room) return;
    try { localStorage.setItem(ROOM_STORAGE_KEY, room); } catch (e) { /* ignore */ }
    els.pairView.hidden = true;
    els.remoteView.hidden = false;
    els.roomLabel.textContent = room;
    els.connStatus.textContent = 'Connecting…';
    els.connStatus.className = 'conn-status';
    pollState();
    if (statePollTimer) clearInterval(statePollTimer);
    statePollTimer = setInterval(pollState, STATE_POLL_MS);
  }

  function disconnect() {
    if (statePollTimer) clearInterval(statePollTimer);
    room = '';
    els.remoteView.hidden = true;
    els.pairView.hidden = false;
  }

  async function pollState() {
    try {
      const res = await fetch(`${RELAY_BASE}/remote/${encodeURIComponent(room)}/state`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      els.connStatus.textContent = 'Connected';
      els.connStatus.className = 'conn-status connected';
      els.connInfo.hidden = true; // once paired, the code/status text just takes up space
      if (data) {
        state = { channels: data.channels || [], favorites: data.favorites || [], nowPlaying: data.nowPlaying || null };
        renderNowPlaying();
        renderGroupOptions();
        renderChannelList();
      }
    } catch (e) {
      els.connInfo.hidden = false; // surface the problem again if the connection actually drops
      els.connStatus.textContent = 'Connection lost, retrying…';
      els.connStatus.className = 'conn-status error';
    }
  }

  function renderNowPlaying() {
    if (state.nowPlaying && state.nowPlaying.name) {
      els.npName.textContent = state.nowPlaying.name;
      if (state.nowPlaying.logo) { els.npLogo.src = state.nowPlaying.logo; els.npLogo.hidden = false; }
      else els.npLogo.hidden = true;
    } else {
      els.npName.textContent = 'Nothing playing';
      els.npLogo.hidden = true;
    }
  }

  function getSourceChannels() {
    if (currentView === 'favorites') {
      const byId = new Map(state.channels.map(c => [c.id, c]));
      return (state.favorites || []).map(id => byId.get(id)).filter(Boolean);
    }
    return state.channels;
  }

  function renderGroupOptions() {
    const groups = Array.from(new Set(getSourceChannels().map(c => c.group || 'Uncategorized'))).sort((a, b) => a.localeCompare(b));
    const prev = els.groupSelect.value;
    els.groupSelect.innerHTML = '<option value="">All groups</option>';
    for (const g of groups) {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g;
      els.groupSelect.appendChild(opt);
    }
    if (groups.includes(prev)) els.groupSelect.value = prev;
  }

  function getFilteredChannels() {
    const q = els.searchInput.value.trim().toLowerCase();
    const g = els.groupSelect.value;
    return getSourceChannels().filter(c => (!g || c.group === g) && (!q || c.name.toLowerCase().includes(q)));
  }

  function renderChannelList() {
    const list = els.channelList;
    list.innerHTML = '';
    const source = getSourceChannels();

    if (source.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = currentView === 'favorites'
        ? 'No favorites set in the desktop app yet.'
        : 'No channels yet — add a playlist in the desktop app.';
      list.appendChild(empty);
      return;
    }

    const filtered = getFilteredChannels();
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
      frag.appendChild(renderChannelItem(c));
    }
    list.appendChild(frag);
  }

  function renderChannelItem(channel) {
    const item = document.createElement('div');
    item.className = 'channel-item' + (state.nowPlaying && state.nowPlaying.id === channel.id ? ' active' : '');

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

    item.addEventListener('click', () => sendCommand('play', { id: channel.id, name: channel.name, url: channel.url, logo: channel.logo }));
    return item;
  }

  async function sendCommand(type, payload) {
    try {
      await fetch(`${RELAY_BASE}/remote/${encodeURIComponent(room)}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, payload }),
      });
      if (type === 'play') {
        state.nowPlaying = payload;
        renderNowPlaying();
        renderChannelList();
      } else if (type === 'stop') {
        state.nowPlaying = null;
        renderNowPlaying();
        renderChannelList();
      }
    } catch (e) {
      els.connStatus.textContent = 'Could not send command — check connection';
      els.connStatus.className = 'conn-status error';
    }
  }

  function init() {
    const urlRoom = getRoomFromUrl();
    let savedRoom = '';
    try { savedRoom = localStorage.getItem(ROOM_STORAGE_KEY) || ''; } catch (e) { /* ignore */ }

    els.roomInput.value = urlRoom || savedRoom || '';
    els.connectBtn.addEventListener('click', () => {
      if (!els.roomInput.value.trim()) { els.pairError.hidden = false; els.pairError.textContent = 'Enter a pairing code.'; return; }
      els.pairError.hidden = true;
      connect(els.roomInput.value);
    });
    els.roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.connectBtn.click(); });

    els.disconnectBtn.addEventListener('click', disconnect);
    els.stopBtn.addEventListener('click', () => sendCommand('stop', null));

    document.querySelectorAll('.view-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.view-tab').forEach(t => t.classList.toggle('active', t === tab));
        currentView = tab.dataset.view;
        renderGroupOptions();
        renderChannelList();
      });
    });
    els.searchInput.addEventListener('input', renderChannelList);
    els.groupSelect.addEventListener('change', renderChannelList);

    if (urlRoom) connect(urlRoom);
    else if (savedRoom) connect(savedRoom);
  }

  init();
})();
