'use strict';
/* Main window controller. */
(function () {
  const { el, icon, fmtBytes, fmtSpeed, fmtEta, fmtSizePair, pct, catIcon, toast, splitUrls } = DM;
  const $ = (id) => document.getElementById(id);

  const state = {
    items: new Map(), // id -> snapshot
    view: 'all',
    query: '',
    selected: null,
    settings: null,
    queueRunning: false,
  };
  const rows = new Map(); // id -> { row, divider, parts }

  // ------------------------------------------------------------ boot
  async function init() {
    const [info, settings, list, q, pending] = await Promise.all([
      api.invoke('app:info'),
      api.invoke('settings:get'),
      api.invoke('downloads:list'),
      api.invoke('queue:state'),
      api.invoke('power:state'),
    ]);
    $('version').textContent = `Version ${info.version}`;
    DM.appInfo = info;
    state.settings = settings;
    state.queueRunning = q.running;
    for (const d of list) state.items.set(d.id, d);
    renderConnection();
    renderAll();
    renderQueuePanel();
    if (pending) showPower(pending);
    SettingsView.mount($('view-settings'), settings, info);
  }

  api.on('downloads:added', (d) => {
    state.items.set(d.id, d);
    renderAll();
  });
  api.on('downloads:changed', (d) => {
    const prev = state.items.get(d.id);
    state.items.set(d.id, d);
    const reshuffle = !prev || prev.status !== d.status || prev.queued !== d.queued || prev.queueOrder !== d.queueOrder || prev.filename !== d.filename;
    if (reshuffle) renderAll();
    else updateRow(d);
  });
  api.on('downloads:removed', (id) => {
    state.items.delete(id);
    if (state.selected === id) state.selected = null;
    renderAll();
  });
  api.on('downloads:progress', (list) => {
    let speed = 0;
    for (const d of list) {
      state.items.set(d.id, d);
      updateRow(d);
      speed += d.speed;
    }
    setTotalSpeed(speed, list.length);
  });
  api.on('queue:state', (q) => {
    state.queueRunning = q.running;
    renderQueuePanel();
  });
  api.on('settings:changed', (s) => {
    state.settings = s;
    renderConnection();
    renderQueuePanel();
    SettingsView.update(s);
  });
  api.on('power:pending', showPower);
  api.on('ui:command', (c) => c === 'search' && openSearch());

  let speedTimer;
  function setTotalSpeed(speed, n) {
    const t = $('totalSpeed');
    t.hidden = !n;
    t.textContent = `↓ ${fmtSpeed(speed).replace('/sec', '/s')}`;
    clearTimeout(speedTimer);
    speedTimer = setTimeout(() => (t.hidden = true), 1500);
  }

  // ------------------------------------------------------------ list rendering
  function visibleItems() {
    const q = state.query.toLowerCase();
    let arr = [...state.items.values()];
    if (state.view === 'completed') arr = arr.filter((d) => d.status === 'completed');
    if (state.view === 'scheduled') arr = arr.filter((d) => d.queued && d.status !== 'completed');
    if (q) arr = arr.filter((d) => d.filename.toLowerCase().includes(q) || d.url.toLowerCase().includes(q));
    if (state.view === 'scheduled') arr.sort((a, b) => a.queueOrder - b.queueOrder);
    else arr.sort((a, b) => b.createdAt - a.createdAt);
    return arr;
  }

  function renderAll() {
    const all = [...state.items.values()];
    const active = all.filter((d) => ['downloading', 'connecting'].includes(d.status)).length;
    $('badgeAll').textContent = active ? String(active) : '';
    const waiting = all.filter((d) => d.queued && d.status !== 'completed').length;
    $('badgeQueue').textContent = waiting ? String(waiting) : '';

    if (state.view === 'settings') return;
    const listEl = state.view === 'scheduled' ? $('qlist') : $('list');
    const items = visibleItems();
    // Re-use existing row elements so hover/selection survive updates.
    const frag = document.createDocumentFragment();
    const keep = new Set();
    items.forEach((d, i) => {
      let r = rows.get(d.id);
      if (!r || r.list !== listEl) {
        if (r) {
          r.row.remove();
          r.divider.remove();
        }
        r = buildRow(d);
        r.list = listEl;
        rows.set(d.id, r);
      }
      keep.add(d.id);
      fillRow(r, d);
      frag.append(r.row);
      if (i < items.length - 1) frag.append(r.divider);
      else r.divider.remove();
    });
    for (const [id, r] of rows) {
      if (!keep.has(id)) {
        r.row.remove();
        r.divider.remove();
        rows.delete(id);
      }
    }
    listEl.replaceChildren(frag);

    if (state.view === 'scheduled') {
      $('qempty').hidden = items.length > 0;
      updateQueueStatus();
    } else {
      const empty = $('empty');
      empty.hidden = items.length > 0;
      if (!items.length) {
        if (state.query) {
          $('emptyTitle').textContent = 'Nothing found';
          $('emptySub').textContent = `No downloads match “${state.query}”.`;
        } else if (state.view === 'completed') {
          $('emptyTitle').textContent = 'No completed downloads';
          $('emptySub').textContent = 'Finished files will show up here.';
        } else {
          $('emptyTitle').textContent = 'No downloads yet';
          $('emptySub').textContent = 'Click “Add Link”, paste a link (Ctrl+V) or drop one here.';
        }
      }
    }
  }

  function buildRow(d) {
    const cat = el('img', { class: 'cat', alt: '' });
    const shield = el('img', { class: 'shield-mini', src: 'assets/icons/shield-on.svg', alt: '', title: 'Secure connection' });
    const nameText = el('span');
    const name = el('div', { class: 'name' }, shield, nameText);
    const toggleImg = el('img', { alt: '' });
    const toggle = el('button', { class: 'toggle', title: 'Pause' }, toggleImg);
    const x = el('button', { class: 'x', title: 'Cancel' }, icon('row-x'));
    const acts = el('div', { class: 'acts' }, toggle, x);
    const fill = el('div', { class: 'fill' });
    const bar = el('div', { class: 'bar' }, fill);
    const speed = el('span', { class: 'speed' });
    const eta = el('span', { class: 'eta' });
    const size = el('span', { class: 'size' });
    const meta = el('div', { class: 'meta' }, speed, eta, size);
    const doneMeta = el('div', { class: 'done-meta' });
    const row = el('div', { class: 'row', tabindex: '-1' }, cat, name, acts, bar, meta, doneMeta);
    const divider = el('div', { class: 'divider' });
    const id = d.id;
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      api.invoke('downloads:action', { id, action: 'toggle' });
    });
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      api.invoke('downloads:action', { id, action: 'cancel' });
    });
    row.addEventListener('click', () => select(id));
    row.addEventListener('dblclick', () => api.invoke('downloads:action', { id, action: 'open' }));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      select(id);
      api.invoke('downloads:contextMenu', id);
    });
    return { row, divider, parts: { cat, shield, nameText, name, toggle, toggleImg, x, bar, fill, speed, eta, size, doneMeta }, key: '' };
  }

  function fillRow(r, d) {
    const p = r.parts;
    const done = d.status === 'completed';
    const cls = `row ${done ? 'done' : d.status}${state.selected === d.id ? ' selected' : ''}`;
    if (r.row.className !== cls) r.row.className = cls;
    const catSrc = catIcon(d.category, 'min');
    if (p.cat.getAttribute('src') !== catSrc) p.cat.src = catSrc;
    p.shield.hidden = !d.secure || done;
    if (p.nameText.textContent !== d.filename) p.nameText.textContent = d.filename;
    p.name.title = d.filename;
    if (done) {
      p.doneMeta.textContent = `${fmtBytes(d.size)}${d.completedAt ? ' · ' + new Date(d.completedAt).toLocaleDateString() : ''}`;
      return;
    }
    const running = d.status === 'downloading' || d.status === 'connecting';
    const toggleSrc = running ? 'assets/icons/row-pause.svg' : 'assets/icons/row-play.svg';
    if (p.toggleImg.getAttribute('src') !== toggleSrc) p.toggleImg.src = toggleSrc;
    p.toggle.title = running ? 'Pause' : d.status === 'error' ? 'Retry' : 'Resume';
    p.x.title = d.status === 'canceled' ? 'Remove from list' : 'Cancel';
    p.bar.className = `bar ${running ? '' : d.status}${running && !(d.size > 0) ? ' indeterminate' : ''}`;
    p.fill.style.width = `${pct(d)}%`;
    let left = '';
    let mid = '';
    if (d.status === 'downloading') {
      left = fmtSpeed(d.speed);
      mid = fmtEta(d.eta);
    } else if (d.status === 'connecting') left = 'Connecting…';
    else if (d.status === 'queued') {
      left = 'Queued';
      mid = d.size > 0 ? `${Math.floor(pct(d))}%` : '';
    } else if (d.status === 'paused') mid = d.size > 0 ? `${Math.floor(pct(d))}%` : 'Paused';
    else if (d.status === 'canceled') {
      left = 'Canceled';
      mid = d.size > 0 && d.downloaded > 0 ? `${Math.floor(pct(d))}%` : '';
    }
    else if (d.status === 'error') left = d.error || 'Error';
    p.speed.textContent = left;
    p.speed.title = d.status === 'error' ? left : '';
    p.eta.textContent = mid;
    p.size.textContent = fmtSizePair(d);
  }

  function updateRow(d) {
    const r = rows.get(d.id);
    if (r) fillRow(r, d);
  }

  function select(id) {
    state.selected = id;
    for (const [rid, r] of rows) r.row.classList.toggle('selected', rid === id);
  }

  // ------------------------------------------------------------ navigation
  $('nav').addEventListener('click', (e) => {
    const b = e.target.closest('.nav-item');
    if (!b) return;
    setView(b.dataset.view);
  });

  function setView(v) {
    state.view = v;
    for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('active', b.dataset.view === v);
    $('view-list').hidden = !(v === 'all' || v === 'completed');
    $('view-scheduled').hidden = v !== 'scheduled';
    $('view-settings').hidden = v !== 'settings';
    renderAll();
  }

  // ------------------------------------------------------------ add link / drop / paste
  const openAdd = (url = '') => api.invoke('dialog:open', { mode: 'add', url });
  $('addLink').addEventListener('click', () => openAdd());

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (++dragDepth === 1) $('dropHint').hidden = false;
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      $('dropHint').hidden = true;
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropHint').hidden = true;
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    const urls = splitUrls(text);
    if (urls.length) openAdd(urls.join('\n'));
  });

  document.addEventListener('paste', (e) => {
    if (e.target.closest('input, textarea')) return;
    const urls = splitUrls(e.clipboardData.getData('text'));
    if (urls.length) openAdd(urls.join('\n'));
  });

  // ------------------------------------------------------------ search
  const search = $('search');
  const input = $('searchInput');
  function openSearch() {
    search.classList.add('open');
    setTimeout(() => input.focus(), 60);
  }
  $('searchBtn').addEventListener('click', () => (search.classList.contains('open') ? input.focus() : openSearch()));
  $('searchClear').addEventListener('click', () => {
    input.value = '';
    state.query = '';
    renderAll();
    search.classList.remove('open');
  });
  input.addEventListener('input', () => {
    state.query = input.value.trim();
    renderAll();
  });
  input.addEventListener('blur', () => {
    if (!input.value) search.classList.remove('open');
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      state.query = '';
      renderAll();
      input.blur();
    }
  });

  // ------------------------------------------------------------ connection (Normal / Secure)
  const conn = $('conn');
  function renderConnection() {
    const s = state.settings;
    if (!s) return;
    const secure = s.connectionMode === 'secure';
    $('connLabel').textContent = secure ? 'Secure Connection' : 'Normal Connection';
    const sh = $('connShield');
    sh.replaceChildren();
    if (secure) sh.append(icon('shield-on'));
    else sh.append(DM.themedIcon('shield-off'));
    for (const o of document.querySelectorAll('.conn-opt')) o.classList.toggle('current', o.dataset.mode === s.connectionMode);
    const p = s.proxy;
    $('proxyAddr').textContent = `${p.type === 'http' ? 'HTTP' : 'SOCKS5'} ${p.host}:${p.port}`;
  }
  $('connBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = $('connMenu').hidden;
    $('connMenu').hidden = !open;
    conn.classList.toggle('open', open);
  });
  document.addEventListener('click', (e) => {
    if (!conn.contains(e.target)) {
      $('connMenu').hidden = true;
      conn.classList.remove('open');
    }
  });
  for (const o of document.querySelectorAll('.conn-opt')) {
    o.addEventListener('click', async () => {
      await api.invoke('connection:set', o.dataset.mode);
      $('connMenu').hidden = true;
      conn.classList.remove('open');
      if (o.dataset.mode === 'secure') testProxy(true);
    });
  }
  async function testProxy(quiet) {
    const btn = $('connBtn');
    btn.querySelector('.dot')?.remove();
    if (!quiet) toast('Testing secure connection…');
    const r = await api.invoke('connection:test');
    const dot = el('span', { class: `dot ${r.ok ? 'ok' : 'bad'}`, title: r.ok ? `Proxy OK · ${r.ms} ms` : r.error });
    btn.append(dot);
    setTimeout(() => dot.remove(), 8000);
    if (r.ok) toast(`Secure connection works · ${r.ms} ms`);
    else toast(r.error || 'Secure connection failed', 4500);
  }
  $('proxyTest').addEventListener('click', (e) => {
    e.stopPropagation();
    testProxy(false);
  });
  $('proxyEdit').addEventListener('click', () => {
    $('connMenu').hidden = true;
    conn.classList.remove('open');
    setView('settings');
    SettingsView.focus('proxy');
  });

  // ------------------------------------------------------------ scheduled / queue panel
  const DAY = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const maxSel = $('schMax');
  for (let i = 1; i <= 10; i++) maxSel.append(el('option', { value: String(i), text: String(i) }));

  function renderQueuePanel() {
    const s = state.settings;
    if (!s) return;
    const sch = s.schedule;
    $('queueStart').hidden = state.queueRunning;
    $('queueStop').hidden = !state.queueRunning;
    $('schEnabled').checked = sch.enabled;
    $('schStart').value = sch.startTime;
    $('schStopEnabled').checked = sch.stopEnabled;
    $('schStop').value = sch.stopTime;
    $('schMax').value = String(s.maxConcurrent);
    $('schAfter').value = sch.afterDone;
    const days = $('schDays');
    days.replaceChildren(
      ...DAY.map((d, i) =>
        el('button', {
          class: `day${sch.days.includes(i) ? ' on' : ''}`,
          text: d,
          title: DAY_FULL[i],
          onclick: () => {
            const set = new Set(state.settings.schedule.days);
            set.has(i) ? set.delete(i) : set.add(i);
            saveSchedule({ days: [...set].sort() });
          },
        })
      )
    );
    updateQueueStatus();
  }

  function updateQueueStatus() {
    const q = [...state.items.values()].filter((d) => d.queued && d.status !== 'completed');
    const running = q.filter((d) => ['downloading', 'connecting'].includes(d.status)).length;
    const sch = state.settings?.schedule;
    let text;
    if (state.queueRunning) text = `Running · ${running} active, ${q.length - running} waiting`;
    else if (!q.length) text = 'Queue is empty';
    else text = `${q.length} waiting`;
    if (!state.queueRunning && sch?.enabled) text += ` · starts at ${sch.startTime}`;
    $('queueStatus').textContent = text;
  }

  const saveSchedule = (patch) => api.invoke('settings:set', { schedule: patch });
  $('queueStart').addEventListener('click', () => api.invoke('queue:start'));
  $('queueStop').addEventListener('click', () => api.invoke('queue:stop'));
  $('schEnabled').addEventListener('change', (e) => saveSchedule({ enabled: e.target.checked }));
  $('schStopEnabled').addEventListener('change', (e) => saveSchedule({ stopEnabled: e.target.checked }));
  $('schStart').addEventListener('change', (e) => e.target.value && saveSchedule({ startTime: e.target.value }));
  $('schStop').addEventListener('change', (e) => e.target.value && saveSchedule({ stopTime: e.target.value }));
  $('schAfter').addEventListener('change', (e) => saveSchedule({ afterDone: e.target.value }));
  $('schMax').addEventListener('change', (e) => api.invoke('settings:set', { maxConcurrent: Number(e.target.value) }));

  // ------------------------------------------------------------ power banner
  function showPower(p) {
    const b = $('powerBanner');
    if (!p) return (b.hidden = true);
    b.hidden = false;
    $('powerText').textContent = p.seconds != null ? `Queue finished — ${p.label} in ${p.seconds}s` : `Queue finished — ${p.action} pending`;
  }
  $('powerCancel').addEventListener('click', () => api.invoke('power:cancel'));

  // ------------------------------------------------------------ keyboard
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select')) return;
    const id = state.selected;
    if (e.ctrlKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      openAdd();
    } else if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      openSearch();
    } else if (!id) {
      return;
    } else if (e.key === 'Delete') {
      api.invoke('downloads:action', { id, action: 'cancel' });
    } else if (e.key === 'Enter') {
      api.invoke('downloads:action', { id, action: 'open' });
    } else if (e.key === ' ') {
      e.preventDefault();
      api.invoke('downloads:action', { id, action: 'toggle' });
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const ids = visibleItems().map((d) => d.id);
      const i = ids.indexOf(id) + (e.key === 'ArrowDown' ? 1 : -1);
      if (ids[i]) {
        select(ids[i]);
        rows.get(ids[i])?.row.scrollIntoView({ block: 'nearest' });
      }
    }
  });

  window.MainUI = { setView };
  init();
})();
