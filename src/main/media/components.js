'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const { request } = require('../engine/http');

/**
 * Video support needs two helper programs that are downloaded on first use
 * (≈ 53 MB) instead of being bundled into the installer:
 *  - yt-dlp: finds the real video streams on 1000+ sites (YouTube, X, …)
 *  - ffmpeg: joins separate video + audio streams, converts audio to MP3
 */
const SOURCES = {
  win32: {
    ytdlp: { url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', file: 'yt-dlp.exe' },
    ffmpeg: { url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64.gz', file: 'ffmpeg.exe', gz: true },
  },
  linux: {
    ytdlp: { url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux', file: 'yt-dlp' },
    ffmpeg: { url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-x64.gz', file: 'ffmpeg', gz: true },
  },
  darwin: {
    ytdlp: { url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos', file: 'yt-dlp' },
    ffmpeg: {
      url: `https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}.gz`,
      file: 'ffmpeg',
      gz: true,
    },
  },
};

class Components {
  /** sources: optional override of the download URLs (used by tests). */
  constructor(dir, platform = process.platform, sources = null) {
    this.dir = dir;
    this.src = sources || SOURCES[platform] || SOURCES.linux;
    this.installing = null;
    this.ytdlpVersion = null;
  }

  get ytdlpPath() {
    return path.join(this.dir, this.src.ytdlp.file);
  }
  get ffmpegPath() {
    return path.join(this.dir, this.src.ffmpeg.file);
  }

  ready() {
    return fs.existsSync(this.ytdlpPath) && fs.existsSync(this.ffmpegPath);
  }

  async status() {
    const ytdlp = fs.existsSync(this.ytdlpPath);
    const ffmpeg = fs.existsSync(this.ffmpegPath);
    if (ytdlp && !this.ytdlpVersion) this.ytdlpVersion = await this.run(this.ytdlpPath, ['--version']).catch(() => null);
    return {
      ready: ytdlp && ffmpeg,
      installing: !!this.installing,
      ytdlp: { installed: ytdlp, version: ytdlp ? this.ytdlpVersion : null },
      ffmpeg: { installed: ffmpeg },
      downloadSize: (ytdlp ? 0 : 24) + (ffmpeg ? 0 : 30), // MB, roughly
    };
  }

  run(file, args, timeout = 20000) {
    return new Promise((resolve, reject) => {
      execFile(file, args, { timeout, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } }, (err, out) =>
        err ? reject(err) : resolve(String(out).trim())
      );
    });
  }

  /** Downloads whatever is missing. onProgress({ step, received, total }). */
  install(onProgress = () => {}) {
    if (this.installing) return this.installing;
    this.installing = (async () => {
      await fsp.mkdir(this.dir, { recursive: true });
      const todo = [];
      if (!fs.existsSync(this.ytdlpPath)) todo.push(['ytdlp', this.src.ytdlp, this.ytdlpPath]);
      if (!fs.existsSync(this.ffmpegPath)) todo.push(['ffmpeg', this.src.ffmpeg, this.ffmpegPath]);
      // One combined progress bar across both files.
      const totals = new Map();
      const got = new Map();
      const report = (step) => {
        const total = [...totals.values()].reduce((a, b) => a + b, 0);
        const received = [...got.values()].reduce((a, b) => a + b, 0);
        onProgress({ step, received, total, files: todo.length });
      };
      await Promise.all(
        todo.map(async ([name, src, dest]) => {
          const tmp = dest + '.download';
          const { req, res } = await request(src.url, { timeout: 60000 });
          if (res.statusCode !== 200) {
            res.resume();
            req.destroy();
            throw new Error(`Could not download ${name} (HTTP ${res.statusCode})`);
          }
          totals.set(name, Number(res.headers['content-length']) || 0);
          got.set(name, 0);
          res.on('data', (c) => {
            got.set(name, got.get(name) + c.length);
            report(name);
          });
          const out = fs.createWriteStream(tmp, { mode: 0o755 });
          if (src.gz) await pipeline(res, zlib.createGunzip(), out);
          else await pipeline(res, out);
          await fsp.rename(tmp, dest);
          if (process.platform !== 'win32') await fsp.chmod(dest, 0o755);
        })
      );
      this.ytdlpVersion = null;
      return this.status();
    })().finally(() => {
      this.installing = null;
    });
    return this.installing;
  }

  /** yt-dlp updates itself in place (sites change often, so this matters). */
  async update() {
    if (!fs.existsSync(this.ytdlpPath)) return this.install();
    await this.run(this.ytdlpPath, ['-U'], 120000).catch(async () => {
      // Fall back to a fresh download if self-update isn't possible.
      await fsp.rm(this.ytdlpPath, { force: true });
      await this.install();
    });
    this.ytdlpVersion = null;
    return this.status();
  }
}

module.exports = { Components };
