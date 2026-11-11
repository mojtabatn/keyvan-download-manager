'use strict';
/* Add Link (step 1) → Download File Info (step 2), plus "Refresh link" mode. */
(function () {
  const { params, fmtBytes, catIcon, splitUrls, MEDIA_EXT } = DM;
  const $ = (id) => document.getElementById(id);
  const mode = params.get('mode') || 'add';

  const ctx = {
    url: '',
    referrer: '',
    cookies: '',
    userAgent: '',
    batch: [],
    info: null, // probe result
    ext: '',
    dir: '',
    dirTouched: false,
    nameTouched: false,
    source: params.get('source') || 'manual',
  };

  const setTitle = (t) => {
    $('title').textContent = t;
    document.title = t;
  };
  const close = () => api.invoke('window:close');

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  // ------------------------------------------------------------ step 1
  const addr = $('address');
  const status = $('addStatus');
  const okBtn = $('addOk');

  function setStatus(text, kind = '') {
    status.className = `status at ${kind}`;
    status.replaceChildren();
    if (kind === 'busy') status.append(DM.el('span', { class: 'spinner dark' }));
    if (text) status.append(DM.el('span', { text }));
  }

  function setBatch(urls) {
    ctx.batch = urls;
    if (urls.length > 1) {
      addr.value = urls[0];
      setStatus(`+ ${urls.length - 1} more link${urls.length > 2 ? 's' : ''} — all will be added to the queue`);
    } else setStatus('');
  }

  addr.addEventListener('paste', (e) => {
    const urls = splitUrls(e.clipboardData.getData('text'));
    if (urls.length > 1) {
      e.preventDefault();
      setBatch(urls);
    }
  });
  addr.addEventListener('input', () => {
    if (ctx.batch.length > 1 && addr.value !== ctx.batch[0]) setBatch([]);
    if (status.classList.contains('error')) setStatus('');
  });
  $('addCancel').addEventListener('click', close);

  $('paneAdd').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (okBtn.disabled) return;
    if (mode === 'refresh') return submitRefresh();
    if (ctx.batch.length > 1) {
      for (const url of ctx.batch) await api.invoke('downloads:add', { url, mode: 'queue', source: ctx.source });
      await api.invoke('queue:start');
      return close();
    }
    const url = normalizeUrl(addr.value);
    if (!url) return setStatus('Please enter a valid http(s) link', 'error'), addr.focus();
    ctx.url = url;
    busy(true);
    setStatus('Connecting…', 'busy');
    const info = await api.invoke('downloads:probe', { url, referrer: ctx.referrer, cookies: ctx.cookies, userAgent: ctx.userAgent });
    busy(false);
    if (info.error) return setStatus(info.error, 'error');
    showInfo({ ...info, probed: true });
  });

  function busy(on) {
    okBtn.disabled = on;
    addr.disabled = on;
  }

  function normalizeUrl(v) {
    v = String(v || '').trim();
    if (!v) return '';
    if (!/^[a-z]+:\/\//i.test(v) && /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(v)) v = 'https://' + v;
    try {
      const u = new URL(v);
      return /^https?:$/.test(u.protocol) ? u.toString() : '';
    } catch {
      return '';
    }
  }

  // ------------------------------------------------------------ refresh mode
  async function submitRefresh() {
    const url = normalizeUrl(addr.value);
    if (!url) return setStatus('Please enter a valid http(s) link', 'error');
    busy(true);
    setStatus('Checking new link…', 'busy');
    const [info, detail] = await Promise.all([api.invoke('downloads:probe', { url }), api.invoke('downloads:detail', params.get('id'))]);
    busy(false);
    if (info.error) return setStatus(info.error, 'error');
    if (detail && detail.size > 0 && info.size > 0 && info.size !== detail.size) {
      return setStatus(`Different file size (${fmtBytes(info.size)} vs ${fmtBytes(detail.size)}) — not the same file`, 'error');
    }
    await api.invoke('downloads:action', { id: params.get('id'), action: 'refreshUrl', value: url });
    close();
  }

  // ------------------------------------------------------------ step 2
  const nameInput = $('infoName');

  function splitName(filename) {
    const m = /^(.*?)(\.[a-z0-9]{1,12})$/i.exec(filename || '');
    return m && m[1] ? { base: m[1], ext: m[2] } : { base: filename || 'download', ext: '' };
  }

  async function showInfo(info, { pending = false } = {}) {
    ctx.info = info;
    const { base, ext } = splitName(info.filename);
    ctx.ext = ext;
    if (!ctx.nameTouched) nameInput.value = base;
    nameInput.title = info.filename;
    $('infoCat').src = catIcon(info.category, 'max');
    $('infoSize').textContent = pending ? '…' : info.size > 0 ? fmtBytes(info.size) : 'Unknown';
    if (!ctx.dirTouched && info.dir) ctx.dir = info.dir;
    $('infoDir').textContent = ctx.dir;
    $('infoFolder').title = ctx.dir;
    $('infoWatch').hidden = !(MEDIA_EXT.test(info.filename) || /^(video|audio)\//.test(info.contentType || ''));
    const warn = $('infoWarn');
    warn.hidden = !(info.isWebPage || info.warning);
    warn.textContent = info.warning || (info.isWebPage ? 'This link points to a web page, not a file.' : '');
    if ($('paneInfo').hidden) {
      $('paneAdd').hidden = true;
      $('paneInfo').hidden = false;
      setTitle('Download File Info');
      api.invoke('window:resize', 265); // 233 content + 32 title bar
      setTimeout(() => $('infoDownload').focus(), 50);
    }
    updateAvailable();
  }

  async function updateAvailable() {
    const free = await api.invoke('disk:free', ctx.dir);
    const el = $('infoAvail');
    el.textContent = free >= 0 ? fmtBytes(free) : '—';
    el.classList.toggle('low', free >= 0 && ctx.info && ctx.info.size > free);
  }

  nameInput.addEventListener('input', () => (ctx.nameTouched = true));
  $('infoFolder').addEventListener('click', async () => {
    const dir = await api.invoke('dialog:pickFolder', ctx.dir);
    if (!dir) return;
    ctx.dir = dir;
    ctx.dirTouched = true;
    $('infoDir').textContent = dir;
    $('infoFolder').title = dir;
    updateAvailable();
  });

  function finalName() {
    let n = nameInput.value.trim() || splitName(ctx.info.filename).base;
    if (ctx.ext && !n.toLowerCase().endsWith(ctx.ext.toLowerCase())) n += ctx.ext;
    return n;
  }

  async function add(modeName) {
    const info = ctx.info;
    await api.invoke('downloads:add', {
      url: ctx.url,
      filename: finalName(),
      filenameLocked: !!info.probed || ctx.nameTouched,
      dir: ctx.dir,
      size: info.size,
      resumable: info.resumable,
      referrer: ctx.referrer,
      cookies: ctx.cookies,
      userAgent: ctx.userAgent,
      mode: modeName,
      source: ctx.source,
    });
    close();
  }

  $('paneInfo').addEventListener('submit', (e) => {
    e.preventDefault();
    add('now');
  });
  $('infoLater').addEventListener('click', () => add('queue'));
  $('infoWatch').addEventListener('click', async () => {
    await api.invoke('player:open', { url: ctx.url, title: finalName(), referrer: ctx.referrer, cookies: ctx.cookies });
  });

  // ------------------------------------------------------------ boot
  (async function boot() {
    if (mode === 'refresh') {
      setTitle('Refresh Download Link');
      const detail = await api.invoke('downloads:detail', params.get('id'));
      $('addrLabel').textContent = `New address for “${detail ? detail.filename : 'download'}”:`;
      addr.value = '';
      addr.placeholder = 'Paste the new link (open the download page again and copy the link)';
      setTimeout(() => addr.focus(), 50);
      return;
    }
    if (mode === 'info') {
      // Opened by the browser extension: show what the browser told us
      // right away, then confirm the details with the server.
      const p = (await api.invoke('dialog:payload', params.get('token'))) || {};
      Object.assign(ctx, { url: p.url || '', referrer: p.referrer || '', cookies: p.cookies || '', userAgent: p.userAgent || '', source: 'browser' });
      const guess = p.filename || decodeURIComponent((ctx.url.split('?')[0].split('/').pop() || 'download'));
      const fake = { filename: guess, size: p.size || -1, resumable: false, category: categoryFromName(guess), dir: '' };
      ctx.dir = (await api.invoke('settings:get')).downloadDir;
      showInfo(fake, { pending: true });
      const info = await api.invoke('downloads:probe', { url: ctx.url, referrer: ctx.referrer, cookies: ctx.cookies, userAgent: ctx.userAgent });
      if (info.error) {
        showInfo({ ...fake, warning: `Couldn't check the file: ${info.error}` });
        $('infoSize').textContent = fake.size > 0 ? fmtBytes(fake.size) : 'Unknown';
      } else {
        // Prefer the browser's file name (it already applied the site's rules).
        showInfo({ ...info, filename: p.filename || info.filename, probed: true, dir: info.dir });
      }
      return;
    }
    const pre = params.get('url') || '';
    const urls = splitUrls(pre);
    if (urls.length > 1) setBatch(urls);
    else addr.value = urls[0] || '';
    setTimeout(() => {
      addr.focus();
      addr.select();
    }, 50);
  })();

  function categoryFromName(n) {
    const ext = (/\.([a-z0-9]+)$/i.exec(n) || [])[1] || '';
    const map = {
      video: /^(mp4|mkv|avi|mov|wmv|flv|webm|m4v|mpg|mpeg|ts)$/i,
      audio: /^(mp3|m4a|aac|flac|wav|ogg|opus|wma)$/i,
      zip: /^(zip|rar|7z|tar|gz|bz2|xz|iso|img)$/i,
      text: /^(pdf|docx?|txt|xlsx?|pptx?|epub|srt|ass)$/i,
      exe: /^(exe|msi|apk|dmg)$/i,
    };
    for (const [k, re] of Object.entries(map)) if (re.test(ext)) return k;
    return 'other';
  }
})();
