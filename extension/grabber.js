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
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#kdm_clip0_513_1448)"><rect width="28" height="28" rx="8" fill="url(#kdm_paint0_linear_513_1448)"/><g filter="url(#kdm_filter0_f_513_1448)"><circle cx="20.5" cy="23.5" r="5.5" fill="#5A47DF"/></g><g filter="url(#kdm_filter1_f_513_1448)"><circle cx="8.5" cy="2.5" r="5.5" fill="#DEC4FB"/></g><circle opacity="0.5" cx="14.5" cy="14.5" r="7.5" fill="url(#kdm_paint1_linear_513_1448)"/><g clip-path="url(#kdm_clip1_513_1448)"><path d="M7.75715 15.6143C5.21429 18.9857 4.07143 21.9 5.08572 22.9143C6.51429 24.3428 11.6571 21.4857 16.5143 16.5714C21.3714 11.6571 24.2857 6.57141 22.8571 5.14284C21.9429 4.21427 19.4571 5.14284 16.4714 7.15713" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke="white"/><path d="M21.2143 11.0286C21.7123 12.1171 21.9287 13.3133 21.8437 14.5073C21.7587 15.7012 21.375 16.8547 20.7278 17.8617C20.0807 18.8687 19.1908 19.6969 18.1401 20.2702C17.0893 20.8435 15.9113 21.1436 14.7143 21.1429C13.758 21.1432 12.8112 20.9539 11.9286 20.5857" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke="white"/><path d="M13.208 6.8751L13.2611 7.62321V7.62321L13.208 6.8751ZM17.55 8.8857C17.8814 9.13423 18.3515 9.06707 18.6 8.7357C18.8485 8.40433 18.7814 7.93423 18.45 7.6857L18 8.2857L17.55 8.8857ZM8.66354 8.94922L9.19387 9.47955C10.282 8.39141 11.7261 7.7323 13.2611 7.62321L13.208 6.8751L13.1548 6.12698C11.2596 6.26167 9.47666 7.07544 8.13321 8.41889L8.66354 8.94922ZM13.208 6.8751L13.2611 7.62321C14.7961 7.51412 16.3189 7.96238 17.55 8.8857L18 8.2857L18.45 7.6857C16.9301 6.54574 15.0499 5.9923 13.1548 6.12698L13.208 6.8751ZM8.46311 9.20625L9.07984 9.63303C9.11573 9.58117 9.14474 9.54151 9.16717 9.51267C9.19153 9.48134 9.19965 9.47377 9.19387 9.47955L8.66354 8.94922L8.13321 8.41889C8.03108 8.52102 7.93066 8.65768 7.84638 8.77946L8.46311 9.20625ZM5 15L12.5647 10.784L5.13121 6.34074L5 15Z" fill="white"/></g></g><defs><filter id="kdm_filter0_f_513_1448" x="4.9" y="7.9" width="31.2" height="31.2" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="5.05" result="effect1_foregroundBlur_513_1448"/></filter><filter id="kdm_filter1_f_513_1448" x="-9.3" y="-15.3" width="35.6" height="35.6" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="6.15" result="effect1_foregroundBlur_513_1448"/></filter><linearGradient id="kdm_paint0_linear_513_1448" x1="14" y1="0" x2="14" y2="28" gradientUnits="userSpaceOnUse"><stop stop-color="#CE9FFC"/><stop offset="1" stop-color="#7367F0"/></linearGradient><linearGradient id="kdm_paint1_linear_513_1448" x1="10.5" y1="7" x2="18.5" y2="19.5" gradientUnits="userSpaceOnUse"><stop stop-color="white" stop-opacity="0.05"/><stop offset="1" stop-color="white"/></linearGradient><clipPath id="kdm_clip0_513_1448"><rect width="28" height="28" rx="8" fill="white"/></clipPath><clipPath id="kdm_clip1_513_1448"><rect width="20" height="20" fill="white" transform="translate(4 4)"/></clipPath></defs></svg>
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
