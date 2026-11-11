'use strict';
/* Shared renderer helpers (classic script, exposes window.DM). */
(function () {
  const params = new URLSearchParams(location.search);

  // Theme id -> light/dark base (drives icon variants, color-scheme, dark-only rules).
  const THEME_BASE = {
    light: 'light', dark: 'dark', day: 'light', paper: 'light', mint: 'light', retro: 'light',
    night: 'dark', ocean: 'dark', neon: 'dark', jungle: 'dark',
  };
  function setTheme(t) {
    const id = THEME_BASE[t] ? t : 'light';
    document.documentElement.dataset.theme = id;
    document.documentElement.dataset.base = THEME_BASE[id];
  }
  setTheme(params.get('theme'));
  window.api.on('theme:changed', setTheme);

  function fmtBytes(n, digits = 2) {
    if (!(n >= 0)) return '—';
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
  }

  function fmtSpeed(bps) {
    if (!(bps > 0)) return '0 KB/sec';
    if (bps >= 1024 * 1024) return `${(bps / 1048576).toFixed(1)} MB/sec`;
    return `${Math.max(1, Math.round(bps / 1024))} KB/sec`;
  }

  function fmtEta(sec) {
    if (!(sec >= 0) || !isFinite(sec)) return '--:--:--';
    sec = Math.round(sec);
    if (sec > 99 * 3600) return '99:59:59+';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return [h, m, s].map((x) => String(x).padStart(2, '0')).join(':');
  }

  function fmtSizePair(d) {
    if (d.size > 0) return `${fmtBytes(d.downloaded)}/${fmtBytes(d.size)}`;
    return fmtBytes(d.downloaded);
  }

  function pct(d) {
    if (d.status === 'completed') return 100;
    return d.size > 0 ? Math.min(100, (d.downloaded / d.size) * 100) : 0;
  }

  const CAT = { video: 'video', audio: 'audio', zip: 'zip', text: 'text', exe: 'exe', other: 'other' };
  function catIcon(category, size = 'min') {
    return `assets/categories/${CAT[category] || 'other'}-${size}.svg`;
  }

  const MEDIA_EXT = /\.(mp4|mkv|webm|mov|m4v|avi|wmv|flv|ts|mp3|m4a|aac|flac|wav|ogg|opus)$/i;

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) e.append(c);
    return e;
  }

  function icon(name, cls = '') {
    return el('img', { src: `assets/icons/${name}.svg`, class: cls, alt: '' });
  }

  /** Icon with separate light/dark artwork (as drawn in the Figma file). */
  function themedIcon(name, cls = '') {
    const wrap = document.createDocumentFragment();
    wrap.append(icon(name, `${cls} only-light`), icon(`${name}-dark`, `${cls} only-dark`));
    return wrap;
  }

  let toastTimer;
  function toast(text, ms = 2200) {
    let t = document.getElementById('toast');
    if (!t) {
      t = el('div', { id: 'toast', class: 'toast' });
      document.body.append(t);
    }
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }
  window.api.on('toast', (p) => p && p.text && toast(p.text));

  function splitUrls(text) {
    return String(text || '')
      .split(/[\s"'<>]+/)
      .map((s) => s.trim())
      .filter((s) => /^https?:\/\/\S+/i.test(s));
  }

  window.DM = { params, setTheme, fmtBytes, fmtSpeed, fmtEta, fmtSizePair, pct, catIcon, el, icon, themedIcon, toast, splitUrls, MEDIA_EXT };
})();
