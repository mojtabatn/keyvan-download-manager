'use strict';

const fs = require('fs');
const path = require('path');

const THEME_IDS = ['light', 'dark', 'day', 'night', 'paper', 'mint', 'ocean', 'neon', 'jungle', 'retro'];

function defaults(downloadsDir) {
  return {
    theme: 'light', // a theme id from windows.js THEMES
    downloadDir: downloadsDir,
    categorize: true, // sort into Video / Music / Compressed / Documents / Programs / General
    connections: 8, // connections per download
    maxConcurrent: 1, // downloads at a time from a queue: one after another
    speedLimit: 0, // KB/s, 0 = unlimited
    maxRetries: 10,
    listView: 'cards', // 'cards' (large icons) | 'compact' (list without icons)
    videoQuality: 'best', // preselected quality: 'best' | '2160' | '1080' | '720' | '480' | '360' | 'audio'
    autoUpdate: true, // check GitHub Releases for new versions
    videoButton: true, // show the "Download video" button on web pages (browser extension)
    showProgressWindow: true,
    showCompleteWindow: true,
    clipboardWatch: true,
    browserIntegration: true,
    notifications: true,
    preventSleep: true,
    closeToTray: true,
    launchAtStartup: false,
    schedule: {
      enabled: false,
      startTime: '02:00',
      stopEnabled: false,
      stopTime: '08:00',
      days: [0, 1, 2, 3, 4, 5, 6],
      afterDone: 'none', // 'none' | 'exit' | 'sleep' | 'hibernate' | 'shutdown'
    },
  };
}

class Settings {
  constructor(file, downloadsDir) {
    this.file = file;
    this.data = defaults(downloadsDir);
    this.listeners = new Set();
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = merge(this.data, saved);
    } catch {
      /* first run */
    }
    // Older versions stored 'system' (or a theme that no longer exists).
    if (!THEME_IDS.includes(this.data.theme)) this.data.theme = 'light';
    // Older versions had one queue configured by `schedule` + `maxConcurrent`.
    if (!Array.isArray(this.data.queues) || !this.data.queues.length) {
      // 0.1.0 ran 3 queue items at once by default; queues now go one by one unless the user chose otherwise
      const max = this.data.maxConcurrent === 3 ? 1 : this.data.maxConcurrent;
      this.data.queues = [{ id: 'main', name: 'Main queue', maxConcurrent: max, schedule: { ...this.data.schedule } }];
    }
    this.data.queues = sanitizeQueues(this.data.queues, this.data);
  }

  get() {
    return this.data;
  }

  set(patch) {
    const prev = JSON.parse(JSON.stringify(this.data));
    this.data = merge(this.data, sanitizePatch(patch));
    this.save();
    for (const fn of this.listeners) fn(this.data, prev);
    return this.data;
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (e) {
      console.error('settings save failed', e);
    }
  }
}

function merge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in base)) continue;
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], v);
    else out[k] = v;
  }
  return out;
}

const clamp = (n, lo, hi, dflt) => {
  const x = Math.round(Number(n));
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt;
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const AFTER = ['none', 'exit', 'sleep', 'hibernate', 'shutdown'];

/** Every queue: { id, name, maxConcurrent, schedule }. The first one is always "main". */
function sanitizeQueues(list, base = {}) {
  const def = defaults('').schedule;
  const seen = new Set();
  const out = [];
  for (const q of Array.isArray(list) ? list : []) {
    if (!q || typeof q !== 'object') continue;
    const id = String(q.id || '').replace(/[^\w-]/g, '').slice(0, 40);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const s = { ...def, ...(q.schedule && typeof q.schedule === 'object' ? q.schedule : {}) };
    out.push({
      id,
      name: String(q.name || 'Queue').trim().slice(0, 40) || 'Queue',
      maxConcurrent: clamp(q.maxConcurrent ?? base.maxConcurrent, 1, 20, 1),
      schedule: {
        enabled: !!s.enabled,
        startTime: TIME.test(s.startTime) ? s.startTime : def.startTime,
        stopEnabled: !!s.stopEnabled,
        stopTime: TIME.test(s.stopTime) ? s.stopTime : def.stopTime,
        days: Array.isArray(s.days) ? [...new Set(s.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : def.days,
        afterDone: AFTER.includes(s.afterDone) ? s.afterDone : 'none',
      },
    });
  }
  if (!out.some((q) => q.id === 'main')) out.unshift({ id: 'main', name: 'Main queue', maxConcurrent: clamp(base.maxConcurrent, 1, 20, 1), schedule: { ...def } });
  else out.unshift(...out.splice(out.findIndex((q) => q.id === 'main'), 1));
  return out.slice(0, 20);
}

function sanitizePatch(p) {
  const out = { ...p };
  if ('queues' in out) out.queues = sanitizeQueues(out.queues);
  if ('connections' in out) out.connections = clamp(out.connections, 1, 32, 8);
  if ('maxConcurrent' in out) out.maxConcurrent = clamp(out.maxConcurrent, 1, 20, 1);
  if ('speedLimit' in out) out.speedLimit = clamp(out.speedLimit, 0, 10_000_000, 0);
  if ('maxRetries' in out) out.maxRetries = clamp(out.maxRetries, 0, 100, 10);
  if ('theme' in out && !THEME_IDS.includes(out.theme)) delete out.theme;
  if ('listView' in out && !['cards', 'compact'].includes(out.listView)) delete out.listView;
  if ('videoQuality' in out && !['best', '2160', '1080', '720', '480', '360', 'audio'].includes(String(out.videoQuality))) delete out.videoQuality;
  return out;
}

module.exports = { Settings, sanitizeQueues };
