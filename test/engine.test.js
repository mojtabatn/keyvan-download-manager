'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Manager } = require('../src/main/engine/manager');
const { probe } = require('../src/main/engine/download');
const { parseContentDisposition, sanitize } = require('../src/main/engine/filename');
const { looksDownloadable, categoryOf } = require('../src/main/engine/categories');
const { makeData, sha, startServer, startSocks, startHttpProxy } = require('./helpers');

const SIZE = 6 * 1024 * 1024 + 12345;
const DATA = makeData(SIZE);
const DATA_SHA = sha(DATA);

let srv;
let tmp;
test.before(async () => {
  srv = await startServer(DATA);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-'));
});
test.after(() => {
  srv.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeManager(overrides = {}, proxy = null) {
  const dir = fs.mkdtempSync(path.join(tmp, 'm-'));
  const settings = {
    downloadDir: dir,
    categorize: false,
    connections: 8,
    maxConcurrent: 3,
    maxRetries: 4,
    speedLimit: 0,
    connectionMode: 'normal',
    ...overrides,
  };
  const m = new Manager({ file: path.join(dir, 'downloads.json'), getSettings: () => settings, getProxy: () => proxy });
  m.startTimers();
  return { m, dir, settings };
}

const waitFor = (dl, statuses = ['completed', 'error']) =>
  new Promise((resolve) => {
    const check = () => statuses.includes(dl.d.status) && !dl.running;
    if (check()) return resolve(dl);
    const on = () => {
      if (check()) {
        dl.off('stopped', on);
        resolve(dl);
      }
    };
    dl.on('stopped', on);
  });

const fileSha = (p) => sha(fs.readFileSync(p));

test('unit: filename parsing and categories', () => {
  assert.strictEqual(parseContentDisposition("attachment; filename*=UTF-8''%E2%82%AC%20rates.pdf"), '€ rates.pdf');
  assert.strictEqual(parseContentDisposition('attachment; filename="a \\"b\\".zip"'), 'a "b".zip');
  assert.strictEqual(sanitize('con.txt'), '_con.txt');
  assert.strictEqual(sanitize('a<b>:c?.mkv  . '), 'a_b__c_.mkv');
  assert.ok(looksDownloadable('https://x.com/Silo.S01E07.720p.mkv?token=1'));
  assert.ok(!looksDownloadable('https://x.com/page.html'));
  assert.strictEqual(categoryOf('a.MP3'), 'audio');
  assert.strictEqual(categoryOf('setup.exe'), 'exe');
});

test('probe reports size, resume support and name', async () => {
  const info = await probe(`${srv.base}/file/movie.mkv`);
  assert.strictEqual(info.size, SIZE);
  assert.strictEqual(info.resumable, true);
  assert.strictEqual(info.filename, 'movie.mkv');
  assert.strictEqual(info.category, 'video');
  const cd = await probe(`${srv.base}/cd`);
  assert.strictEqual(cd.filename, 'فیلم new.mkv');
  const red = await probe(`${srv.base}/redirect`);
  assert.strictEqual(red.filename, 'redirected.bin');
});

test('multi-connection download is byte-exact and uses several connections', async () => {
  const { m } = makeManager({ connections: 6 });
  const before = srv.stats.ranges.length;
  const dl = m.add({ url: `${srv.base}/file/multi.bin`, mode: 'now' });
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.strictEqual(fileSha(dl.d.savePath), DATA_SHA);
  assert.ok(srv.stats.ranges.length - before >= 6, 'expected >= 6 ranged requests');
  assert.ok(!fs.existsSync(dl.d.savePath + '.dmpart'));
  await m.shutdown();
});

test('pause and resume keeps already downloaded bytes', async () => {
  const slow = await startServer(DATA, { bytesPerSec: 512 * 1024 });
  const { m } = makeManager({ connections: 4 });
  const dl = m.add({ url: `${slow.base}/file/pause.bin`, mode: 'now' });
  await new Promise((r) => setTimeout(r, 1500));
  await m.pause(dl.id);
  assert.strictEqual(dl.d.status, 'paused');
  const kept = dl.flushedBytes();
  assert.ok(kept > 0, 'should have bytes on disk');
  assert.ok(fs.existsSync(dl.tempPath));
  // Simulate an app restart: save, then load into a new manager.
  m.saveNow();
  await m.shutdown();
  const m2 = new (require('../src/main/engine/manager').Manager)({ file: m.file, getSettings: m.getSettings, getProxy: () => null });
  m2.load();
  m2.startTimers();
  const again = m2.get(dl.id);
  assert.strictEqual(again.d.downloaded, kept);
  const reqsBefore = slow.stats.ranges.length;
  slow.server.close();
  const fast = await startServer(DATA);
  again.d.url = `${fast.base}/file/pause.bin`;
  m2.start(again.id);
  await waitFor(again);
  assert.strictEqual(again.d.status, 'completed', again.d.error);
  assert.strictEqual(fileSha(again.d.savePath), DATA_SHA);
  // Resumed ranges must not start at 0 for every segment.
  assert.ok(fast.stats.ranges.some(([s]) => s > 0));
  assert.ok(reqsBefore > 0);
  fast.server.close();
  await m2.shutdown();
});

test('dropped connections are retried transparently', async () => {
  const { m } = makeManager({ connections: 4 });
  const dl = m.add({ url: `${srv.base}/flaky/flaky.bin`, mode: 'now' });
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.strictEqual(fileSha(dl.d.savePath), DATA_SHA);
  await m.shutdown();
});

test('server without range support falls back to one connection', async () => {
  const { m } = makeManager();
  const dl = m.add({ url: `${srv.base}/norange/plain.bin`, mode: 'now' });
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.strictEqual(dl.d.resumable, false);
  assert.strictEqual(fileSha(dl.d.savePath), DATA_SHA);
  await m.shutdown();
});

test('server that lies about range support still downloads (single-connection fallback)', async () => {
  const { m } = makeManager({ connections: 8 });
  const dl = m.add({ url: `${srv.base}/liar/liar.bin`, mode: 'now' });
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.strictEqual(dl.d.resumable, false);
  assert.strictEqual(fileSha(dl.d.savePath), DATA_SHA);
  await m.shutdown();
});

test('unknown length (chunked) download', async () => {
  const { m } = makeManager();
  const dl = m.add({ url: `${srv.base}/chunked/stream.bin`, mode: 'now' });
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.strictEqual(dl.d.size, SIZE);
  assert.strictEqual(fileSha(dl.d.savePath), DATA_SHA);
  await m.shutdown();
});

test('dynamic segmentation splits the slow segment', async () => {
  const { m } = makeManager({ connections: 4 });
  const dl = m.add({ url: `${srv.base}/slowfirst/split.bin`, mode: 'now' });
  let maxSegs = 0;
  const orig = dl.schedule.bind(dl);
  dl.schedule = () => {
    orig();
    maxSegs = Math.max(maxSegs, dl.d.segments.length);
  };
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.strictEqual(fileSha(dl.d.savePath), DATA_SHA);
  assert.ok(maxSegs > 4, `segments should grow beyond 4 (got ${maxSegs})`);
  await m.shutdown();
});

test('cancel keeps the download in the list (Canceled) and Resume continues', async () => {
  const slow = await startServer(DATA, { bytesPerSec: 768 * 1024 });
  const { m } = makeManager({ connections: 4 });
  const dl = m.add({ url: `${slow.base}/file/cancel.bin`, mode: 'queue' });
  m.startQueue();
  await new Promise((r) => setTimeout(r, 1200));
  await m.cancel(dl.id);
  assert.strictEqual(dl.d.status, 'canceled');
  assert.strictEqual(dl.d.queued, false, 'a canceled item leaves the queue');
  assert.ok(m.list().some((d) => d.id === dl.id), 'still listed');
  const kept = dl.flushedBytes();
  assert.ok(kept > 0 && fs.existsSync(dl.tempPath), 'partial data kept');
  // survives a restart as "canceled"
  m.saveNow();
  const m2 = new (require('../src/main/engine/manager').Manager)({ file: m.file, getSettings: m.getSettings, getProxy: () => null });
  m2.load();
  assert.strictEqual(m2.get(dl.id).d.status, 'canceled');
  m2.resumeAll();
  assert.strictEqual(m2.get(dl.id).running, false, 'Resume all leaves canceled items alone');
  await m.shutdown();
  // explicit resume continues where it stopped
  m.startTimers();
  m.start(dl.id);
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.strictEqual(fileSha(dl.d.savePath), DATA_SHA);
  slow.server.close();
  await m.shutdown();
});

test('403 becomes a readable error', async () => {
  const { m } = makeManager();
  const dl = m.add({ url: `${srv.base}/forbidden`, mode: 'now' });
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'error');
  assert.match(dl.d.error, /403/);
  await m.shutdown();
});

test('secure connection through SOCKS5 (v2ray-style) proxy', async () => {
  const socks = await startSocks();
  const { m } = makeManager({ connectionMode: 'secure', connections: 4 }, { type: 'socks5', host: '127.0.0.1', port: socks.port });
  const dl = m.add({ url: `${srv.base}/file/socks.bin`, mode: 'now' });
  assert.strictEqual(dl.d.secure, true);
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.strictEqual(fileSha(dl.d.savePath), DATA_SHA);
  assert.ok(socks.stats.connections > 0);
  socks.server.close();
  await m.shutdown();
});

test('secure connection through HTTP proxy', async () => {
  const hp = await startHttpProxy();
  const { m } = makeManager({ connectionMode: 'secure', connections: 3 }, { type: 'http', host: '127.0.0.1', port: hp.port });
  const dl = m.add({ url: `${srv.base}/file/httpproxy.bin`, mode: 'now' });
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.strictEqual(fileSha(dl.d.savePath), DATA_SHA);
  assert.ok(hp.stats.requests > 0);
  hp.server.close();
  await m.shutdown();
});

test('proxy down gives a helpful message', async () => {
  const { m } = makeManager({ connectionMode: 'secure', maxRetries: 1 }, { type: 'socks5', host: '127.0.0.1', port: 1 });
  const dl = m.add({ url: `${srv.base}/file/x.bin`, mode: 'now' });
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'error');
  assert.match(dl.d.error, /proxy|v2ray|Secure/i);
  await m.shutdown();
});

test('global speed limit is respected', async () => {
  const small = makeData(400 * 1024, 7);
  const s2 = await startServer(small);
  const { m } = makeManager({ speedLimit: 200, connections: 4 });
  const t0 = Date.now();
  const dl = m.add({ url: `${s2.base}/file/limited.bin`, mode: 'now' });
  await waitFor(dl);
  const secs = (Date.now() - t0) / 1000;
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.ok(secs >= 1.4, `took ${secs}s, expected >= 1.4s at 200 KB/s`);
  s2.server.close();
  await m.shutdown();
});

test('queue honours "max downloads at a time" and reports when done', async () => {
  const s3 = await startServer(makeData(1024 * 1024, 3), { bytesPerSec: 2 * 1024 * 1024 });
  const { m } = makeManager({ maxConcurrent: 1, connections: 2 });
  const dls = [1, 2, 3].map((i) => m.add({ url: `${s3.base}/file/q${i}.bin`, mode: 'queue' }));
  assert.ok(dls.every((d) => d.d.status === 'queued'));
  let maxRunning = 0;
  const iv = setInterval(() => (maxRunning = Math.max(maxRunning, dls.filter((d) => d.running).length)), 20);
  const done = new Promise((r) => m.once('queue-done', r));
  m.startQueue();
  await done;
  clearInterval(iv);
  assert.strictEqual(maxRunning, 1);
  assert.ok(dls.every((d) => d.d.status === 'completed'));
  s3.server.close();
  await m.shutdown();
});

test('empty queue never fires queue-done (no surprise shutdown)', async () => {
  const { m } = makeManager();
  let fired = false;
  m.on('queue-done', () => (fired = true));
  m.startQueue();
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(fired, false);
  await m.shutdown();
});

test('refreshing an expired link keeps progress', async () => {
  const slow = await startServer(DATA, { bytesPerSec: 768 * 1024 });
  const { m } = makeManager({ connections: 2 });
  const dl = m.add({ url: `${slow.base}/file/refresh.bin`, mode: 'now' });
  await new Promise((r) => setTimeout(r, 1200));
  await m.pause(dl.id);
  const kept = dl.flushedBytes();
  dl.d.url = `${srv.base}/forbidden`;
  m.start(dl.id);
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'error');
  await m.refreshUrl(dl.id, `${srv.base}/file/refresh.bin`);
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.strictEqual(fileSha(dl.d.savePath), DATA_SHA);
  assert.ok(kept > 0);
  slow.server.close();
  await m.shutdown();
});
