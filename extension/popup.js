const DEFAULTS = { enabled: true, minSizeKB: 512 };
const $ = (id) => document.getElementById(id);

(async () => {
  const cfg = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  $('enabled').checked = cfg.enabled;
  $('minSize').value = String(cfg.minSizeKB);
  $('enabled').addEventListener('change', (e) => chrome.storage.local.set({ enabled: e.target.checked }));
  $('minSize').addEventListener('change', (e) => chrome.storage.local.set({ minSizeKB: Number(e.target.value) }));

  const st = await chrome.runtime.sendMessage({ type: 'status' });
  const el = $('status');
  if (st && st.app) {
    el.className = 'status ok';
    $('statusText').textContent = st.enabled ? `Connected · v${st.version}` : 'Connected · integration is off in the app';
  } else {
    el.className = 'status bad';
    $('statusText').textContent = 'App not running — downloads stay in the browser';
  }
  $('grab').addEventListener('click', async () => {
    $('grab').textContent = 'Sending…';
    await chrome.runtime.sendMessage({ type: 'grab' });
    window.close();
  });
})();
