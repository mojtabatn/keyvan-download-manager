// KDM "Download video" button: appears over the video under the mouse.
(() => {
  if (window.__kdmGrabber) return;
  window.__kdmGrabber = true;

  let enabled = true;
  chrome.runtime.sendMessage({ type: 'grabber-config' }, (r) => {
    if (chrome.runtime.lastError) return;
    enabled = !r || r.enabled !== false;
  });

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      button{all:unset;position:fixed;display:none;align-items:center;gap:7px;padding:7px 12px 7px 8px;border-radius:9px;
        background:rgba(20,18,24,.9);color:#fff;font:600 12px/16px system-ui,"Segoe UI",sans-serif;cursor:pointer;
        box-shadow:0 4px 18px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.08);backdrop-filter:blur(6px);transition:background .15s;white-space:nowrap}
      button:hover{background:rgba(115,103,240,.95)}
      button.show{display:flex}
      svg{width:18px;height:18px;flex:none}
    </style>
    <button type="button" title="Download this video with KDM">
      <svg viewBox="0 0 28 28" fill="none"><rect width="28" height="28" rx="8" fill="#7367F0"/><path d="M7.76 15.6c-2.55 3.38-3.69 6.3-2.67 7.31 1.43 1.43 6.57-1.43 11.43-6.34 4.86-4.91 7.77-10 6.34-11.43-.91-.93-3.4 0-6.39 2.01" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><path d="M21.21 11.03a7.14 7.14 0 0 1-9.28 9.56" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><path d="M5 15l7.56-4.22L5.13 6.34 5 15Z" fill="#fff"/></svg>
      <span>Download video</span>
    </button>`;
  const btn = root.querySelector('button');
  const label = root.querySelector('span');
  (document.body || document.documentElement).appendChild(host);

  let current = null;
  let hideTimer = null;
  let overButton = false;

  const show = (v) => {
    const r = v.getBoundingClientRect();
    if (r.width < 200 || r.height < 110 || r.bottom < 0 || r.top > innerHeight) return hide();
    current = v;
    btn.style.top = `${Math.max(6, r.top + 10)}px`;
    btn.style.left = `${Math.max(6, Math.min(innerWidth - 160, r.right - 152))}px`;
    btn.classList.add('show');
    clearTimeout(hideTimer);
  };
  const hide = () => {
    if (overButton) return;
    btn.classList.remove('show');
    current = null;
  };

  const videoAt = (x, y) => {
    for (const el of document.elementsFromPoint(x, y)) if (el.tagName === 'VIDEO') return el;
    // players often cover the video with controls: fall back to geometry
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return v;
    }
    return null;
  };

  let last = 0;
  document.addEventListener(
    'pointermove',
    (e) => {
      if (!enabled || Date.now() - last < 80) return;
      last = Date.now();
      const v = videoAt(e.clientX, e.clientY);
      if (v) show(v);
      else if (current) {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hide, 900);
      }
    },
    { passive: true, capture: true }
  );
  addEventListener('scroll', () => current && show(current), { passive: true, capture: true });
  btn.addEventListener('pointerenter', () => (overButton = true));
  btn.addEventListener('pointerleave', () => {
    overButton = false;
    hideTimer = setTimeout(hide, 900);
  });

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const src = current ? current.currentSrc || current.src : '';
    label.textContent = 'Sending…';
    chrome.runtime.sendMessage({ type: 'grab-video', src, title: document.title }, (ok) => {
      label.textContent = chrome.runtime.lastError || !ok ? 'KDM isn’t running' : 'Sent to KDM ✓';
      setTimeout(() => (label.textContent = 'Download video'), 2200);
    });
  });
})();
