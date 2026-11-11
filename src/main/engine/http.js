'use strict';

const http = require('http');
const https = require('https');
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

class HttpError extends Error {
  constructor(status, message) {
    super(message || `Server responded ${status}`);
    this.status = status;
  }
  get fatal() {
    return [400, 401, 403, 404, 405, 410, 416, 451].includes(this.status);
  }
}

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 256 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 256 }),
};

/**
 * Performs a request, following redirects. Resolves once response headers
 * arrive with { req, res, url } (url = final URL after redirects).
 * The caller owns the response stream and must consume or destroy it.
 */
function request(urlStr, opts = {}) {
  const { method = 'GET', headers = {}, timeout = 30000, maxRedirects = 10, signal } = opts;
  return new Promise((resolve, reject) => {
    let redirects = 0;
    let currentMethod = method;
    const origin = safeHost(urlStr);

    const go = (target) => {
      let u;
      try {
        u = new URL(target);
      } catch {
        return reject(new Error('Invalid URL'));
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error(`Unsupported protocol ${u.protocol}`));
      const lib = u.protocol === 'https:' ? https : http;
      const h = {
        'User-Agent': DEFAULT_UA,
        Accept: '*/*',
        'Accept-Encoding': 'identity',
        Connection: 'keep-alive',
        ...headers,
      };
      // Cookies we were handed belong to the original site only.
      if (u.host !== origin) delete h.Cookie;
      if (u.username) {
        h.Authorization = 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
      }
      const req = lib.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || undefined,
          path: u.pathname + u.search,
          method: currentMethod,
          headers: h,
          agent: agents[u.protocol],
        },
        (res) => {
          const loc = res.headers.location;
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc) {
            res.resume();
            if (++redirects > maxRedirects) return reject(new Error('Too many redirects'));
            if (res.statusCode === 303) currentMethod = 'GET';
            let next;
            try {
              next = new URL(loc, u).toString();
            } catch {
              return reject(new Error('Bad redirect location'));
            }
            return go(next);
          }
          resolve({ req, res, url: u.toString() });
        }
      );
      req.setTimeout(timeout, () => req.destroy(new Error('Connection timed out')));
      req.on('error', reject);
      if (signal) {
        const onAbort = () => req.destroy(new Error('Aborted'));
        if (signal.aborted) onAbort();
        else {
          signal.addEventListener('abort', onAbort, { once: true });
          req.once('close', () => signal.removeEventListener('abort', onAbort));
        }
      }
      req.end();
    };
    go(urlStr);
  });
}

function safeHost(u) {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
}

/** Parses "bytes 100-199/1000" -> { start, end, total } (total -1 when "*"). */
function parseContentRange(v) {
  const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(v || '');
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? -1 : Number(m[3]) };
}

module.exports = { request, HttpError, parseContentRange, DEFAULT_UA };
