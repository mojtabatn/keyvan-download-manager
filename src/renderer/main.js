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
    listView: 'cards', // 'cards' (large icons) | 'compact' (list without icons)
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
    $('version').textContent = `Version ${String(info.version).replace(/\.0$/, '')}`;
    DM.appInfo = info;
    state.settings = settings;
    state.listView = settings.listView || 'cards';
    state.queueRunning = q.running;
    for (const d of list) state.items.set(d.id, d);
    renderViewSwitch();
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
    updateActions();
  });
  api.on('settings:changed', (s) => {
    state.settings = s;
    if ((s.listView || 'cards') !== state.listView) {
      state.listView = s.listView || 'cards';
      renderViewSwitch();
      renderAll();
    }
    renderQueuePanel();
    SettingsView.update(s);
  });
  api.on('power:pending', showPower);
  api.on('ui:command', (c) => c === 'search' && focusSearch());

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

    if (state.view === 'settings') return updateActions();
    const listEl = state.view === 'scheduled' ? $('qlist') : $('list');
    const items = visibleItems();
    listEl.classList.toggle('compact', state.listView === 'compact');
    if (state.selected && !items.some((d) => d.id === state.selected)) state.selected = null;
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
    updateActions();
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
    const cSize = el('div', { class: 'c-size' });
    const cStat = el('div', { class: 'c-stat' });
    const row = el('div', { class: 'row', tabindex: '-1' }, cat, name, acts, bar, meta, doneMeta, cSize, cStat);
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
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      select(id);
    });
    row.addEventListener('dblclick', () => api.invoke('downloads:action', { id, action: 'open' }));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      select(id);
      api.invoke('downloads:contextMenu', id);
    });
    return { row, divider, parts: { cat, shield, nameText, name, toggle, toggleImg, x, bar, fill, speed, eta, size, doneMeta, cSize, cStat }, key: '' };
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
    // compact-list cells
    p.cSize.textContent = d.size > 0 ? fmtBytes(d.size) : d.downloaded > 0 ? fmtBytes(d.downloaded) : '—';
    p.cStat.textContent = compactStatus(d);
    p.cStat.className = `c-stat ${d.status}`;
    p.cStat.title = d.status === 'error' ? d.error || '' : '';
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

  function compactStatus(d) {
    const p = d.size > 0 ? `${Math.floor(pct(d))}%` : '';
    switch (d.status) {
      case 'completed': return 'Completed';
      case 'downloading': return [p, fmtSpeed(d.speed)].filter(Boolean).join(' · ');
      case 'connecting': return 'Connecting…';
      case 'paused': return ['Paused', p].filter(Boolean).join(' · ');
      case 'queued': return 'Queued';
      case 'canceled': return 'Canceled';
      case 'error': return 'Error';
      default: return '';
    }
  }

  function updateRow(d) {
    const r = rows.get(d.id);
    if (r) fillRow(r, d);
    if (d.id === state.selected) updateActions();
  }

  function select(id) {
    state.selected = id;
    for (const [rid, r] of rows) r.row.classList.toggle('selected', rid === id);
    updateActions();
  }

  // ------------------------------------------------------------ actions toolbar
  const isRunning = (d) => d && (d.status === 'downloading' || d.status === 'connecting');
  function updateActions() {
    const d = state.selected ? state.items.get(state.selected) : null;
    const resume = $('actResume');
    resume.disabled = !(d && ['paused', 'error', 'canceled', 'queued'].includes(d.status));
    resume.dataset.tip = d && d.status === 'error' ? 'Retry' : 'Resume';
    $('actPause').disabled = !(d && (isRunning(d) || d.status === 'queued'));
    $('actStop').disabled = ![...state.items.values()].some((x) => isRunning(x) || (x.status === 'queued' && state.queueRunning));
    $('actDelete').disabled = !d;
  }
  $('actResume').addEventListener('click', () => state.selected && api.invoke('downloads:action', { id: state.selected, action: 'start' }));
  $('actPause').addEventListener('click', () => state.selected && api.invoke('downloads:action', { id: state.selected, action: 'pause' }));
  $('actStop').addEventListener('click', () => api.invoke('downloads:pauseAll'));
  $('actDelete').addEventListener('click', () => state.selected && api.invoke('downloads:action', { id: state.selected, action: 'delete' }));
  // clicking empty space in a list clears the selection
  for (const id of ['list', 'qlist']) $(id).addEventListener('click', () => select(null));

  // ------------------------------------------------------------ view switch (large icons / compact list)
  function renderViewSwitch() {
    for (const b of document.querySelectorAll('[data-view-mode]')) b.classList.toggle('on', b.dataset.viewMode === state.listView);
  }
  for (const b of document.querySelectorAll('[data-view-mode]')) {
    b.addEventListener('click', () => {
      if (state.listView === b.dataset.viewMode) return;
      state.listView = b.dataset.viewMode;
      renderViewSwitch();
      renderAll();
      api.invoke('settings:set', { listView: state.listView });
    });
  }

  // ------------------------------------------------------------ footer
  $('github').addEventListener('click', async () => {
    const ok = await api.invoke('shell:openProject');
    if (!ok) toast('Project link will be added soon');
  });

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

  // ------------------------------------------------------------ search (always open)
  const search = $('search');
  const input = $('searchInput');
  function focusSearch() {
    input.focus();
    input.select();
  }
  function setQuery(v) {
    state.query = v.trim();
    search.classList.toggle('has-text', !!input.value);
    renderAll();
  }
  input.addEventListener('input', () => setQuery(input.value));
  $('searchClear').addEventListener('click', () => {
    input.value = '';
    setQuery('');
    input.focus();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      setQuery('');
      input.blur();
    }
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
      focusSearch();
    } else if (!id) {
      return;
    } else if (e.key === 'Escape') {
      select(null);
    } else if (e.key === 'Delete') {
      api.invoke('downloads:action', { id, action: 'delete' });
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
