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
    maxConcurrent: 3, // downloads at a time from the queue
    speedLimit: 0, // KB/s, 0 = unlimited
    maxRetries: 10,
    connectionMode: 'normal', // 'normal' | 'secure'
    proxy: { type: 'socks5', host: '127.0.0.1', port: 10808, username: '', password: '' },
    listView: 'cards', // 'cards' (large icons) | 'compact' (list without icons)
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

function sanitizePatch(p) {
  const out = { ...p };
  if ('connections' in out) out.connections = clamp(out.connections, 1, 32, 8);
  if ('maxConcurrent' in out) out.maxConcurrent = clamp(out.maxConcurrent, 1, 20, 3);
  if ('speedLimit' in out) out.speedLimit = clamp(out.speedLimit, 0, 10_000_000, 0);
  if ('maxRetries' in out) out.maxRetries = clamp(out.maxRetries, 0, 100, 10);
  if ('theme' in out && !THEME_IDS.includes(out.theme)) delete out.theme;
  if ('connectionMode' in out && !['normal', 'secure'].includes(out.connectionMode)) delete out.connectionMode;
  if ('listView' in out && !['cards', 'compact'].includes(out.listView)) delete out.listView;
  if (out.proxy) {
    out.proxy = { ...out.proxy };
    if ('port' in out.proxy) out.proxy.port = clamp(out.proxy.port, 1, 65535, 10808);
    if ('type' in out.proxy && !['socks5', 'http'].includes(out.proxy.type)) delete out.proxy.type;
  }
  return out;
}

module.exports = { Settings };
