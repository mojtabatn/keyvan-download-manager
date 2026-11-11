'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Download, probe } = require('./download');
const { Throttle } = require('./throttle');
const { CATEGORIES, categoryOf } = require('./categories');
const { sanitize, fromUrl, uniquePath } = require('./filename');

const TICK_MS = 500;
const DAY_KEYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * Owns every download, the main queue ("Scheduled"), the scheduler and the
 * on-disk list. Emits:
 *   'added' (snapshot) · 'changed' (snapshot) · 'removed' (id)
 *   'progress' (snapshots of running items) · 'completed' (snapshot)
 *   'failed' (snapshot) · 'queue' ({ running }) · 'queue-done'
 *   'activity' ({ active, speed, progress })
 */
class Manager extends EventEmitter {
  constructor({ file, getSettings, getProxy }) {
    super();
    this.file = file;
    this.getSettings = getSettings;
    this.getProxy = getProxy;
    this.items = new Map();
    this.queueRunning = false;
    this.queueStartedToday = null;
    this.queueStoppedToday = null;
    this.throttle = new Throttle(((getSettings().speedLimit || 0) * 1024) | 0);
    this.ctx = {
      throttle: this.throttle,
      settings: getSettings,
      proxyFor: (secure) => (secure ? getProxy() : null),
      takenPaths: (exceptId) => this.takenPaths(exceptId),
    };
    this.saveTimer = null;
    this.ticker = null;
    this.scheduler = null;
  }

  // ---------- persistence ----------
  load() {
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      list = [];
    }
    for (const data of Array.isArray(list) ? list : []) {
      if (!data || !data.id || !data.url) continue;
      if (['downloading', 'connecting'].includes(data.status)) data.status = data.queued ? 'queued' : 'paused';
      if (data.status === 'removed') continue;
      const dl = new Download(data, this.ctx);
      this.hook(dl);
      this.items.set(dl.id, dl);
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 800);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    const data = JSON.stringify([...this.items.values()].map((d) => d.toJSON()));
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('save failed', e);
    }
  }

  // ---------- lifecycle ----------
  startTimers() {
    let saveCounter = 0;
    this.ticker = setInterval(() => {
      const running = [...this.items.values()].filter((d) => d.running);
      for (const d of running) d.tick(TICK_MS);
      if (running.length) {
        this.emit('progress', running.map((d) => d.snapshot()));
        if (++saveCounter % 10 === 0) this.save(); // checkpoint segment positions every ~5 s
      }
      this.emitActivity(running);
    }, TICK_MS);
    this.scheduler = setInterval(() => this.checkSchedule(), 15000);
    this.checkSchedule();
  }

  async shutdown() {
    clearInterval(this.ticker);
    clearInterval(this.scheduler);
    await Promise.all([...this.items.values()].filter((d) => d.running).map((d) => d.stop(d.d.queued ? 'queue' : 'pause')));
    this.saveNow();
  }

  emitActivity(running) {
    let size = 0;
    let done = 0;
    let speed = 0;
    let unknown = false;
    for (const d of running) {
      speed += d.speed;
      if (d.d.size > 0) {
        size += d.d.size;
        done += Math.min(d.d.downloaded, d.d.size);
      } else unknown = true;
    }
    this.emit('activity', {
      active: running.length,
      speed: Math.round(speed),
      progress: running.length ? (size > 0 ? done / size : unknown ? -1 : 0) : null,
    });
  }

  hook(dl) {
    dl.on('change', () => {
      this.emit('changed', dl.snapshot());
      this.save();
    });
    dl.on('completed', () => {
      this.emit('completed', dl.snapshot());
      this.save();
    });
    dl.on('failed', () => {
      this.emit('failed', dl.snapshot());
      this.save();
    });
    dl.on('stopped', () => {
      this.save();
      // Let the queue move on (and notice when it has drained).
      setImmediate(() => this.pump());
    });
  }

  // ---------- queries ----------
  get(id) {
    return this.items.get(id);
  }

  list() {
    return [...this.items.values()].map((d) => d.snapshot()).sort((a, b) => b.createdAt - a.createdAt);
  }

  takenPaths(exceptId) {
    const set = new Set();
    for (const d of this.items.values()) if (d.id !== exceptId && d.d.status !== 'completed') set.add(String(d.d.savePath).toLowerCase());
    return set;
  }

  folderFor(filename) {
    const s = this.getSettings();
    return s.categorize ? path.join(s.downloadDir, CATEGORIES[categoryOf(filename)].folder) : s.downloadDir;
  }

  async probe(url, { referrer, cookies, userAgent, secure } = {}) {
    const headers = {};
    if (referrer) headers.Referer = referrer;
    if (cookies) headers.Cookie = cookies;
    if (userAgent) headers['User-Agent'] = userAgent;
    const s = this.getSettings();
    const useSecure = secure ?? s.connectionMode === 'secure';
    const info = await probe(url, { headers, proxy: useSecure ? this.getProxy() : null });
    return { ...info, dir: this.folderFor(info.filename) };
  }

  /**
   * opts: { url, filename?, dir?, size?, resumable?, referrer?, cookies?, userAgent?,
   *         secure?, mode: 'now' | 'queue' | 'paused', filenameLocked? }
   */
  add(opts) {
    const s = this.getSettings();
    const filename = sanitize(opts.filename || fromUrl(opts.url) || 'download');
    const dir = opts.dir || this.folderFor(filename);
    const savePath = uniquePath(dir, filename, this.takenPaths());
    const queued = opts.mode === 'queue';
    const maxOrder = Math.max(0, ...[...this.items.values()].map((d) => d.d.queueOrder || 0));
    const dl = new Download(
      {
        id: crypto.randomUUID(),
        url: opts.url,
        referrer: opts.referrer || '',
        cookies: opts.cookies || '',
        userAgent: opts.userAgent || '',
        filename: path.basename(savePath),
        filenameLocked: !!opts.filenameLocked,
        dir,
        savePath,
        size: opts.size ?? -1,
        resumable: !!opts.resumable,
        status: queued ? 'queued' : 'paused',
        connections: s.connections,
        secure: opts.secure ?? s.connectionMode === 'secure',
        category: categoryOf(filename),
        createdAt: Date.now(),
        queued,
        queueOrder: queued ? maxOrder + 1 : 0,
        addedFrom: opts.source || 'manual',
      },
      this.ctx
    );
    this.hook(dl);
    this.items.set(dl.id, dl);
    this.emit('added', dl.snapshot());
    this.save();
    if (opts.mode === 'now') dl.start();
    else if (queued) this.pump();
    return dl;
  }

  // ---------- actions ----------
  start(id) {
    const d = this.items.get(id);
    if (!d || d.d.status === 'completed') return;
    if (d.d.status === 'error') {
      // a manual retry gets a fresh set of attempts
      for (const s of d.d.segments) s.fails = 0;
    }
    d.start();
  }

  async pause(id) {
    const d = this.items.get(id);
    if (d) await d.stop('pause');
  }

  /**
   * Stops a download but keeps it in the list as "Canceled" (with the bytes
   * already downloaded, so Resume continues). It also leaves the queue.
   */
  async cancel(id) {
    const d = this.items.get(id);
    if (!d || d.d.status === 'completed') return;
    if (d.d.queued) d.update({ queued: false, queueOrder: 0 });
    await d.stop('cancel');
  }

  async remove(id, { deleteFile = false } = {}) {
    const d = this.items.get(id);
    if (!d) return;
    await d.stop('remove');
    if (d.d.status !== 'completed' || deleteFile) await d.deleteFiles({ includeCompleted: deleteFile });
    this.items.delete(id);
    this.emit('removed', id);
    this.save();
  }

  async redownload(id) {
    const d = this.items.get(id);
    if (!d) return;
    await d.stop('pause');
    await d.deleteFiles();
    d.d.segments = [];
    d.d.downloaded = 0;
    d.d.completedAt = null;
    d.d.error = null;
    d.d.status = 'paused';
    if (fs.existsSync(d.d.savePath)) {
      d.d.savePath = uniquePath(d.d.dir, d.d.filename, this.takenPaths(id));
      d.d.filename = path.basename(d.d.savePath);
    }
    d.emit('change', d);
    d.start();
  }

  /** Swap an expired link for a fresh one and keep the downloaded bytes. */
  async refreshUrl(id, url) {
    const d = this.items.get(id);
    if (!d) return;
    const resume = d.running || d.d.status === 'error';
    await d.stop('pause');
    d.update({ url, error: null });
    if (resume) d.start();
  }

  async setSecure(id, secure) {
    const d = this.items.get(id);
    if (!d) return;
    const wasRunning = d.running;
    if (wasRunning) await d.stop('pause');
    d.update({ secure: !!secure });
    if (wasRunning) d.start();
  }

  update(id, patch) {
    const d = this.items.get(id);
    if (!d) return;
    const allowed = {};
    for (const k of ['connections', 'speedLimit']) if (k in patch) allowed[k] = patch[k];
    d.update(allowed);
  }

  async pauseAll() {
    await Promise.all([...this.items.values()].filter((d) => d.running || d.d.status === 'queued').map((d) => d.stop('pause')));
    this.queueRunning = false;
    this.emit('queue', { running: false });
  }

  resumeAll() {
    for (const d of this.items.values()) if (['paused', 'error'].includes(d.d.status) && !d.d.queued) this.start(d.id);
    if ([...this.items.values()].some((d) => d.d.queued && d.d.status !== 'completed')) this.startQueue();
  }

  setQueued(id, queued) {
    const d = this.items.get(id);
    if (!d) return;
    const maxOrder = Math.max(0, ...[...this.items.values()].map((x) => x.d.queueOrder || 0));
    d.update({ queued: !!queued, queueOrder: queued ? maxOrder + 1 : 0 });
    if (queued && !d.running && d.d.status !== 'completed') d.setStatus('queued');
    if (!queued && d.d.status === 'queued') d.setStatus('paused');
    this.pump();
  }

  moveInQueue(id, dir) {
    const q = this.queueItems();
    const i = q.findIndex((d) => d.id === id);
    const j = i + (dir === 'up' ? -1 : 1);
    if (i < 0 || j < 0 || j >= q.length) return;
    const a = q[i].d.queueOrder;
    q[i].update({ queueOrder: q[j].d.queueOrder });
    q[j].update({ queueOrder: a });
  }

  queueItems() {
    return [...this.items.values()].filter((d) => d.d.queued && d.d.status !== 'completed').sort((a, b) => a.d.queueOrder - b.d.queueOrder);
  }

  startQueue() {
    this.queueRunning = true;
    this.queueRunCount = 0;
    for (const d of this.queueItems()) if (['paused', 'error'].includes(d.d.status) && !d.running) d.setStatus('queued');
    this.emit('queue', { running: true });
    this.pump();
  }

  async stopQueue() {
    this.queueRunning = false;
    this.emit('queue', { running: false });
    await Promise.all(this.queueItems().filter((d) => d.running).map((d) => d.stop('queue')));
  }

  /** Starts waiting queue items until "max downloads at a time" is reached. */
  pump() {
    if (!this.queueRunning) return;
    const max = Math.max(1, this.getSettings().maxConcurrent || 3);
    const q = this.queueItems();
    let running = q.filter((d) => d.running).length;
    for (const d of q) {
      if (running >= max) break;
      if (!d.running && d.d.status === 'queued') {
        d.start();
        this.queueRunCount++;
        running++;
      }
    }
    const rest = this.queueItems();
    if (rest.some((d) => d.running || d.d.status === 'queued')) return;
    this.queueRunning = false;
    this.emit('queue', { running: false });
    // Only a queue that actually ran and wasn't interrupted by the user counts
    // as "finished" (this is what triggers shutdown/sleep after downloads).
    const userPaused = rest.some((d) => d.d.status === 'paused');
    if (this.queueRunCount > 0 && !userPaused) this.emit('queue-done', { failed: rest.filter((d) => d.d.status === 'error').length });
  }

  setSpeedLimit(kbps) {
    this.throttle.setRate((Number(kbps) || 0) * 1024);
  }

  // ---------- scheduler ----------
  checkSchedule(now = new Date()) {
    const sch = this.getSettings().schedule || {};
    if (!sch.enabled) return;
    const days = Array.isArray(sch.days) ? sch.days : DAY_KEYS;
    const today = now.toDateString();
    const hm = now.getHours() * 60 + now.getMinutes();
    const toMin = (t) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
      return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    };
    const start = toMin(sch.startTime);
    const stop = sch.stopEnabled ? toMin(sch.stopTime) : null;
    if (start !== null && days.includes(now.getDay()) && hm >= start && hm < start + 2 && this.queueStartedToday !== today) {
      this.queueStartedToday = today;
      if (!this.queueRunning && this.queueItems().length) this.startQueue();
    }
    if (stop !== null && hm >= stop && hm < stop + 2 && this.queueStoppedToday !== today) {
      this.queueStoppedToday = today;
      if (this.queueRunning) this.stopQueue();
    }
  }
}

module.exports = { Manager };
