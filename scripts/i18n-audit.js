// Opens every screen of the real app in Persian and lists visible text that still has Latin letters
// (anything that should have been translated). Usage: xvfb-run -a node scripts/i18n-audit.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');
const { makeData, startServer } = require('../test/helpers');
const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// text that is allowed to stay Latin: product names, file names, addresses, units
const OK = /^(KDM|yt-dlp|ffmpeg|HD|Full HD|MP3|HTTP \/ HTTPS|SOCKS5|HLS|DASH|https?:.*|[\w.\-+ ()\[\]]+\.(mkv|mp3|zip|iso|dmg|rar|pdf)|chrome:\/\/extensions|edge:\/\/extensions|Telegram.*|Instagram.*|Ctrl.*|127\.0\.0\.1|[\d.:/ -]+|Windows ?\d*)$/i;

async function scan(page, label, found) {
  const items = await page.evaluate(() => {
    const out = [];
    const skip = (e) => e.closest('script,style,code,input,textarea,.name,.dl-name,.path,.c-size,[data-keep]');
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      const n = w.currentNode;
      const t = n.nodeValue.trim();
      if (!t || !/[A-Za-z]{2}/.test(t)) continue;
      const e = n.parentElement;
      if (!e || skip(e) || e.offsetParent === null && getComputedStyle(e).position !== 'fixed') continue;
      out.push(t);
    }
    for (const e of document.querySelectorAll('[title],[placeholder],[data-tip],[alt],[aria-label]')) {
      if (e.closest('[hidden]')) continue;
      for (const a of ['title', 'placeholder', 'data-tip', 'aria-label']) {
        const v = e.getAttribute(a);
        if (v && /[A-Za-z]{3}/.test(v) && !e.classList.contains('name')) out.push(`[${a}] ${v}`);
      }
    }
    return out;
  });
  // a text counts as translated when it contains Persian letters (it may still name KDM, yt-dlp…)
  for (const t of items) if (!/[\u0600-\u06FF]/.test(t) && !OK.test(t) && !found.has(t)) found.set(t, label);
}

(async () => {
  const fast = await startServer(makeData(2 * 1024 * 1024, 3));
  const slow = await startServer(makeData(64 * 1024 * 1024, 5), { bytesPerSec: 200 * 1024 });
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'kdm-audit-'));
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ notifications: false, clipboardWatch: false, showProgressWindow: false, showCompleteWindow: false, language: 'fa', lastSeenVersion: '0.2.0' }));
  const app = await electron.launch({ executablePath: require('electron'), args: [root, '--no-sandbox'], env: { ...process.env, DM_USER_DATA: ud, DM_DOWNLOADS: path.join(ud, 'D') } });
  const main = await app.firstWindow();
  await main.waitForLoadState('domcontentloaded');
  await sleep(1200);
  const found = new Map();
  const add = (o) => main.evaluate((x) => window.api.invoke('downloads:add', x), o);
  await add({ url: `${fast.base}/file/a.zip`, mode: 'now' });
  await sleep(1200);
  const a = await add({ url: `${slow.base}/file/Silo.mkv`, mode: 'now' });
  const b = await add({ url: `${slow.base}/file/Blender.zip`, mode: 'now' });
  await add({ url: 'http://127.0.0.1:9/x/Queued.iso', mode: 'queue' });
  await add({ url: 'http://127.0.0.1:9/x/Err.bin', mode: 'now' });
  await sleep(2500);
  await main.evaluate((id) => window.api.invoke('downloads:action', { id, action: 'pause' }), b.id);
  await sleep(500);
  await scan(main, 'main: all', found);
  await main.click('[data-view-mode="compact"]');
  await sleep(300);
  await scan(main, 'main: compact', found);
  await main.click('[data-view-mode="cards"]');
  for (const v of ['completed', 'scheduled', 'settings']) {
    await main.click(`.nav-item[data-view="${v}"]`);
    await sleep(500);
    await scan(main, `main: ${v}`, found);
  }
  await main.evaluate(() => (document.querySelector('.set-group:last-child') || document.body).scrollIntoView());
  // new queue name editing + action tooltips
  await main.click('.nav-item[data-view="scheduled"]');
  await main.click('.q-add');
  await sleep(400);
  await scan(main, 'main: new queue', found);
  await main.keyboard.press('Escape');
  await main.click('.nav-item[data-view="all"]');
  for (const sel of ['#actResume', '#actPause', '#actStop', '#actDelete', '#actSelectAll']) {
    await main.hover(sel, { force: true });
    await scan(main, `tooltip ${sel}`, found);
  }
  const open = async (fn) => {
    const n = (await app.windows()).length;
    await fn();
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      const ws = await app.windows();
      if (ws.length > n) {
        const w = ws[ws.length - 1];
        await w.waitForLoadState('domcontentloaded');
        await sleep(500);
        return w;
      }
    }
  };
  let d = await open(() => main.click('#addLink'));
  await scan(d, 'dialog: add', found);
  await d.fill('#address', 'notalink');
  await d.click('#addOk');
  await sleep(300);
  await scan(d, 'dialog: add error', found);
  await d.fill('#address', `${slow.base}/file/x.mkv`);
  await d.click('#addOk');
  await d.waitForSelector('#paneInfo:not([hidden])', { timeout: 15000 });
  await sleep(500);
  await scan(d, 'dialog: info', found);
  await d.close();
  d = await open(() => main.click('#addLink'));
  await d.fill('#address', `${slow.base}/file/p.part[01-03].rar`);
  await d.click('#addOk');
  await d.waitForSelector('#paneBatch:not([hidden])');
  await scan(d, 'dialog: batch', found);
  await d.close();
  d = await open(() => main.click('#addLink'));
  await d.fill('#address', 'https://www.youtube.com/watch?v=abc');
  await d.click('#addOk');
  await d.waitForSelector('#mediaInstall:not([hidden]), #mediaError:not([hidden]), #mediaReady:not([hidden])', { timeout: 15000 }).catch(() => {});
  await sleep(500);
  await scan(d, 'dialog: video', found);
  await d.close();
  const p = await open(() => main.evaluate((id) => window.api.invoke('downloads:action', { id, action: 'progress' }), a.id));
  await sleep(1000);
  await p.click('#detailsBtn');
  await sleep(1200);
  await scan(p, 'progress', found);
  await p.close();
  const wn = await open(() => main.evaluate(() => window.api.invoke('whatsnew:open')));
  await scan(wn, 'whats-new', found);
  await app.close();
  fast.server.close();
  slow.server.close();
  if (!found.size) return console.log('No untranslated text found.');
  for (const [t, where] of found) console.log(`${where.padEnd(24)} ${t}`);
  process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
