'use strict';

const http = require('http');
const net = require('net');
const crypto = require('crypto');

function makeData(size, seed = 1) {
  const buf = Buffer.alloc(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = x & 0xff;
  }
  return buf;
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * Test file server.
 *  /file/<name>        ranged, Accept-Ranges
 *  /norange/<name>     ignores Range, 200 only
 *  /chunked/<name>     no Content-Length
 *  /cd                 Content-Disposition with a UTF-8 name
 *  /redirect           302 -> /file/redirected.bin
 *  /forbidden          403
 *  /flaky/<name>       the first four responses are cut after 100 KiB
 *  /slowfirst/<name>   requests starting at 0 are throttled hard
 *  /liar/<name>        says Accept-Ranges: bytes but always sends the full file (200)
 * Per-connection throttle via opts.bytesPerSec.
 */
function startServer(data, opts = {}) {
  const stats = { requests: 0, concurrent: 0, maxConcurrent: 0, ranges: [], flakyHits: new Set() };
  const server = http.createServer((req, res) => {
    stats.requests++;
    stats.concurrent++;
    stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.concurrent);
    res.on('close', () => stats.concurrent--);
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/redirect') {
      res.writeHead(302, { Location: '/file/redirected.bin' });
      return res.end();
    }
    if (p === '/forbidden') {
      res.writeHead(403);
      return res.end('no');
    }
    if (p === '/cd') {
      res.writeHead(200, {
        'Content-Length': data.length,
        'Content-Disposition': "attachment; filename=\"fallback.bin\"; filename*=UTF-8''%D9%81%DB%8C%D9%84%D9%85%20new.mkv",
        'Accept-Ranges': 'bytes',
      });
      return req.method === 'HEAD' ? res.end() : res.end(data);
    }
    const ranged = p.startsWith('/file/') || p.startsWith('/flaky/') || p.startsWith('/slowfirst/');
    let start = 0;
    let end = data.length - 1;
    let status = 200;
    const headers = { 'Content-Type': 'application/octet-stream' };
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (ranged) headers['Accept-Ranges'] = 'bytes';
    if (ranged && range) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
      if (start >= data.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${data.length}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${data.length}`;
      stats.ranges.push([start, end]);
    }
    if (p.startsWith('/liar/')) headers['Accept-Ranges'] = 'bytes';
    if (!p.startsWith('/chunked/')) headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    let pos = start;
    let cutAt = Infinity;
    if (p.startsWith('/flaky/') && stats.flakyHits.size < 4 && !stats.flakyHits.has(start)) {
      stats.flakyHits.add(start);
      cutAt = start + 100 * 1024;
    }
    const rate = p.startsWith('/slowfirst/') && start === 0 ? 64 * 1024 : opts.bytesPerSec || 0;
    const step = 16 * 1024;
    const pump = () => {
      if (res.destroyed) return;
      while (pos <= end) {
        if (pos >= cutAt) return res.destroy();
        const next = Math.min(end + 1, pos + step);
        const ok = res.write(data.subarray(pos, next));
        pos = next;
        if (rate) return setTimeout(pump, (step / rate) * 1000);
        if (!ok) return res.once('drain', pump);
      }
      res.end();
    };
    pump();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, stats, base: `http://127.0.0.1:${server.address().port}` })));
}

/** Minimal SOCKS5 server (no auth, CONNECT, IPv4 + domain). */
function startSocks() {
  const stats = { connections: 0, hosts: [] };
  const server = net.createServer((client) => {
    stats.connections++;
    client.once('data', (hello) => {
      if (hello[0] !== 5) return client.destroy();
      client.write(Buffer.from([5, 0]));
      client.once('data', (reqb) => {
        let host;
        let off;
        if (reqb[3] === 1) {
          host = `${reqb[4]}.${reqb[5]}.${reqb[6]}.${reqb[7]}`;
          off = 8;
        } else if (reqb[3] === 3) {
          const len = reqb[4];
          host = reqb.subarray(5, 5 + len).toString();
          off = 5 + len;
        } else return client.destroy();
        const port = reqb.readUInt16BE(off);
        stats.hosts.push(`${host}:${port}`);
        const upstream = net.connect(port, host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
      });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, stats, port: server.address().port })));
}

/** Minimal HTTP proxy: absolute-form GET forwarding + CONNECT tunnels. */
function startHttpProxy() {
  const stats = { requests: 0 };
  const server = http.createServer((req, res) => {
    stats.requests++;
    const u = new URL(req.url);
    const up = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: req.headers }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  server.on('connect', (req, socket) => {
    stats.requests++;
    const [host, port] = req.url.split(':');
    const up = net.connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, stats, port: server.address().port })));
}

module.exports = { makeData, sha, startServer, startSocks, startHttpProxy };
