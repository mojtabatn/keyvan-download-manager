// Download Manager — browser integration (Chrome / Edge / Brave, Manifest V3)
const APP = 'http://127.0.0.1:17842';
const DEFAULTS = { enabled: true, minSizeKB: 512 };
const SKIP_MIME = /^(image\/|text\/(html|css|javascript|plain)|application\/(json|javascript|xml|x-javascript|pdf))/i;
const handedOff = new Set();

async function getConfig() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

async function ping(timeout = 400) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    const r = await fetch(`${APP}/ping`, { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    return j && j.app === 'download-manager' ? j : null;
  } catch {
    return null;
  }
}

async function cookiesFor(url) {
  try {
    const list = await chrome.cookies.getAll({ url });
    return list.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

async function send(payload) {
  try {
    const r = await fetch(`${APP}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAgent: navigator.userAgent, ...payload }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

const baseName = (p) => (p || '').split(/[\\/]/).pop();

// ---------------------------------------------------------------- capture browser downloads
chrome.downloads.onCreated.addListener(async (item) => {
  if (handedOff.has(item.url)) return handedOff.delete(item.url); // our own fallback
  const cfg = await getConfig();
  if (!cfg.enabled) return;
  const url = item.finalUrl || item.url;
  if (!/^https?:/i.test(url)) return; // blob:/data: URLs only exist inside the browser
  if (item.mime && SKIP_MIME.test(item.mime)) return;
  const size = item.totalBytes > 0 ? item.totalBytes : item.fileSize > 0 ? item.fileSize : -1;
  if (size > 0 && size < cfg.minSizeKB * 1024) return;

  const app = await ping();
  if (!app || !app.enabled) return; // app closed or integration off: let the browser handle it

  try {
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
  } catch {
    /* already finished — still hand it over */
  }
  const ok = await send({
    url,
    filename: baseName(item.filename),
    referrer: item.referrer || '',
    cookies: await cookiesFor(url),
    size,
  });
  if (!ok) {
    // Couldn't hand it over after all — restart it in the browser.
    handedOff.add(item.url);
    chrome.downloads.download({ url: item.url });
  }
});

// ---------------------------------------------------------------- context menu
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'dm-link', title: 'Download with Download Manager', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'dm-media', title: 'Download this media with Download Manager', contexts: ['video', 'audio', 'image'] });
    chrome.contextMenus.create({ id: 'dm-all', title: 'Download all links with Download Manager', contexts: ['page'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'dm-all') return sendAllLinks(tab);
  const url = info.menuItemId === 'dm-link' ? info.linkUrl : info.srcUrl;
  if (!url || !/^https?:/i.test(url)) return;
  const ok = await send({ url, referrer: info.pageUrl || '', cookies: await cookiesFor(url) });
  if (!ok) chrome.downloads.download({ url });
});

const FILE_EXT = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|mpg|mpeg|ts|mp3|m4a|aac|flac|wav|ogg|opus|zip|rar|7z|tar|gz|bz2|xz|iso|exe|msi|apk|dmg|pdf|epub|srt|ass)(\?|#|$)/i;

async function sendAllLinks(tab) {
  if (!tab || !tab.id) return;
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => [...document.querySelectorAll('a[href]')].map((a) => a.href),
  });
  const urls = [...new Set((res && res.result) || [])].filter((u) => /^https?:/i.test(u) && FILE_EXT.test(u));
  if (!urls.length) return;
  await send({ urls, referrer: tab.url || '', cookies: await cookiesFor(urls[0]) });
}

// popup messages
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'status') {
    ping(800).then(reply);
    return true;
  }
  if (msg && msg.type === 'grab') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => sendAllLinks(tab)).then(() => reply(true));
    return true;
  }
  return false;
});
