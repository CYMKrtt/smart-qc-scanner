// Smart QC Scanner — prototype server (Node.js, no dependencies)
// - Serves the web app (station / camera / dashboard)
// - WebRTC signaling relay (SSE + POST)
// - Stores inspection results + images, streams them live to dashboards
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HTTP_PORT = Number(process.env.PORT || 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const REJECT_WEBHOOK = process.env.REJECT_WEBHOOK || ''; // e.g. http://plc-gateway/reject
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || ''; // set this before exposing the server to the internet
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const IMAGES = path.join(DATA, 'images');
const LOG_FILE = path.join(DATA, 'inspections.jsonl');
const CERT_DIR = path.join(ROOT, 'certs');

fs.mkdirSync(IMAGES, { recursive: true });

// ---------- inspection store ----------
let inspections = [];
if (fs.existsSync(LOG_FILE)) {
  for (const line of fs.readFileSync(LOG_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { inspections.push(JSON.parse(line)); } catch { /* skip bad line */ }
  }
}
console.log(`Loaded ${inspections.length} inspection records`);

// ---------- SSE hubs ----------
const dashClients = new Set();
function broadcastDash(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of dashClients) res.write(msg);
}

// signaling rooms: room -> Map(peerId -> {res, role})
const rooms = new Map();
function room(name) {
  if (!rooms.has(name)) rooms.set(name, new Map());
  return rooms.get(name);
}
function sendSignal(res, data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }

// station heartbeat status per line
const stations = new Map(); // line -> {status, ts, ...}

setInterval(() => {
  for (const res of dashClients) res.write(': ping\n\n');
  for (const r of rooms.values()) for (const p of r.values()) p.res.write(': ping\n\n');
}, 15000);

// ---------- helpers ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function saveDataUrl(dataUrl, file) {
  const m = /^data:image\/(jpeg|png);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  fs.writeFileSync(path.join(IMAGES, file), Buffer.from(m[2], 'base64'));
  return `/images/${file}`;
}
function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  // private LAN ranges first (VPN adapters such as 26.x / 100.x go last)
  const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return out.sort((a, b) => isPrivate(b) - isPrivate(a));
}
function postWebhook(payload) {
  if (!REJECT_WEBHOOK) return;
  try {
    const u = new URL(REJECT_WEBHOOK);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 2000 });
    req.on('error', e => console.warn('webhook error:', e.message));
    req.end(JSON.stringify(payload));
  } catch (e) { console.warn('webhook error:', e.message); }
}

function stats(line) {
  const list = line ? inspections.filter(i => i.line === line) : inspections;
  const total = list.length;
  const fail = list.filter(i => i.result === 'FAIL').length;
  const byDefect = {};
  for (const i of list) for (const d of i.defects || []) byDefect[d] = (byDefect[d] || 0) + 1;
  const now = Date.now();
  const lastMin = list.filter(i => now - i.ts < 60000).length;
  const avgMs = total ? list.slice(-200).reduce((s, i) => s + (i.procMs || 0), 0) / Math.min(total, 200) : 0;
  const labeled = list.filter(i => i.truth);
  const correct = labeled.filter(i => (i.truth === 'defect') === (i.result === 'FAIL')).length;
  return {
    total, pass: total - fail, fail,
    yield: total ? (total - fail) / total : null,
    perMinute: lastMin, avgProcMs: avgMs, byDefect,
    accuracy: labeled.length ? correct / labeled.length : null, labeled: labeled.length,
  };
}

// ---------- access control (HTTP Basic Auth, any username) ----------
function authorized(req) {
  if (!ACCESS_PASSWORD) return true;
  const m = /^Basic (.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const given = crypto.createHash('sha256').update(decoded.slice(decoded.indexOf(':') + 1)).digest();
  const want = crypto.createHash('sha256').update(ACCESS_PASSWORD).digest();
  return crypto.timingSafeEqual(given, want);
}

// ---------- request handler ----------
async function handle(req, res) {
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Smart QC", charset="UTF-8"', 'Content-Type': 'text/plain' });
    return res.end('Password required');
  }
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // --- API ---
    if (p === '/api/info') {
      return json(res, 200, { ips: lanIPs(), httpPort: HTTP_PORT, httpsPort: httpsServer ? HTTPS_PORT : null });
    }
    if (p === '/api/inspections' && req.method === 'POST') {
      const b = await readBody(req);
      const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
      const rec = {
        id, ts: Date.now(), line: String(b.line || 'line-1').slice(0, 40),
        result: b.result === 'FAIL' ? 'FAIL' : 'PASS',
        defects: Array.isArray(b.defects) ? b.defects.slice(0, 8).map(String) : [],
        score: Number(b.score) || 0, metrics: b.metrics || {}, procMs: Number(b.procMs) || 0,
        mode: String(b.mode || ''), truth: b.truth || null, truthDefect: b.truthDefect ? String(b.truthDefect) : null,
        image: b.image ? saveDataUrl(b.image, `${id}.jpg`) : null,
        heatmap: b.heatmap ? saveDataUrl(b.heatmap, `${id}-h.jpg`) : null,
      };
      inspections.push(rec);
      fs.appendFileSync(LOG_FILE, JSON.stringify(rec) + '\n');
      broadcastDash('inspection', rec);
      if (rec.result === 'FAIL') postWebhook({ type: 'reject', ...rec });
      return json(res, 200, rec);
    }
    if (p === '/api/inspections' && req.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 5000);
      const line = url.searchParams.get('line');
      const list = line ? inspections.filter(i => i.line === line) : inspections;
      return json(res, 200, list.slice(-limit));
    }
    if (p === '/api/stats') return json(res, 200, stats(url.searchParams.get('line')));
    if (p === '/api/reset' && req.method === 'POST') {
      inspections = [];
      fs.writeFileSync(LOG_FILE, '');
      for (const f of fs.readdirSync(IMAGES)) fs.unlinkSync(path.join(IMAGES, f));
      broadcastDash('reset', {});
      return json(res, 200, { ok: true });
    }
    if (p === '/api/export.csv') {
      const rows = [['id', 'time', 'line', 'result', 'defects', 'score', 'proc_ms', 'mode', 'truth']];
      for (const i of inspections) rows.push([i.id, new Date(i.ts).toISOString(), i.line, i.result, i.defects.join('|'), i.score.toFixed(1), Math.round(i.procMs), i.mode, i.truth || '']);
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="qc-inspections.csv"' });
      return res.end('\ufeff' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n'));
    }
    if (p === '/api/station' && req.method === 'POST') {
      const b = await readBody(req);
      const line = String(b.line || 'line-1');
      const st = { line, status: String(b.status || ''), source: String(b.source || ''), fps: Number(b.fps) || 0, ts: Date.now() };
      stations.set(line, st);
      broadcastDash('station', st);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      for (const st of stations.values()) res.write(`event: station\ndata: ${JSON.stringify(st)}\n\n`);
      dashClients.add(res);
      req.on('close', () => dashClients.delete(res));
      return;
    }

    // --- WebRTC signaling ---
    if (p === '/signal/events') {
      const roomName = url.searchParams.get('room') || 'line-1';
      const id = url.searchParams.get('id') || crypto.randomUUID();
      const role = url.searchParams.get('role') || 'peer';
      const r = room(roomName);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      // tell newcomer who's here; tell others about newcomer
      sendSignal(res, { type: 'welcome', id, peers: [...r.entries()].map(([pid, v]) => ({ id: pid, role: v.role })) });
      for (const [pid, v] of r) if (pid !== id) sendSignal(v.res, { type: 'peer-joined', id, role });
      r.set(id, { res, role });
      req.on('close', () => {
        if (r.get(id)?.res === res) {
          r.delete(id);
          for (const v of r.values()) sendSignal(v.res, { type: 'peer-left', id, role });
        }
      });
      return;
    }
    if (p === '/signal/send' && req.method === 'POST') {
      const b = await readBody(req, 512 * 1024);
      const r = room(b.room || 'line-1');
      const msg = { type: 'signal', from: b.from, data: b.data };
      for (const [pid, v] of r) {
        if (pid === b.from) continue;
        if (b.to && pid !== b.to) continue;
        sendSignal(v.res, msg);
      }
      return json(res, 200, { ok: true });
    }

    // --- static ---
    let file;
    if (p.startsWith('/images/')) file = path.join(IMAGES, path.basename(p));
    else file = path.join(PUBLIC, path.normalize(p === '/' ? '/index.html' : p).replace(/^([\\/]\.\.)+/, ''));
    if (!file.startsWith(PUBLIC) && !file.startsWith(IMAGES)) { res.writeHead(403); return res.end(); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    });
  } catch (e) {
    console.error(e);
    json(res, 400, { error: e.message });
  }
}

// ---------- HTTPS (needed so phones on the LAN can open their camera) ----------
function findOpenssl() {
  const candidates = [
    'openssl',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files (x86)\\Git\\mingw64\\bin\\openssl.exe',
  ];
  for (const c of candidates) {
    try { execFileSync(c, ['version'], { stdio: 'ignore' }); return c; } catch { /* next */ }
  }
  return null;
}
function ensureCert() {
  const key = path.join(CERT_DIR, 'key.pem');
  const cert = path.join(CERT_DIR, 'cert.pem');
  if (fs.existsSync(key) && fs.existsSync(cert)) return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  const ossl = findOpenssl();
  if (!ossl) return null;
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...lanIPs().map(ip => `IP:${ip}`)].join(',');
  try {
    execFileSync(ossl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
      '-keyout', key, '-out', cert, '-subj', '/CN=Smart QC Scanner', '-addext', `subjectAltName=${san}`], { stdio: 'ignore' });
    console.log('Generated self-signed certificate in ./certs');
    return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  } catch (e) {
    console.warn('Could not generate certificate:', e.message);
    return null;
  }
}

http.createServer(handle).listen(HTTP_PORT, () => {
  console.log('\n=== Smart QC Scanner ===');
  console.log(`Station / Dashboard (this PC):  http://localhost:${HTTP_PORT}`);
  console.log(ACCESS_PASSWORD ? 'Password protection: ON' : 'Password protection: OFF (set ACCESS_PASSWORD before sharing online)');
});
let httpsServer = null;
const creds = ensureCert();
if (creds) {
  httpsServer = https.createServer(creds, handle).listen(HTTPS_PORT, () => {
    for (const ip of lanIPs()) console.log(`From phone / other devices:     https://${ip}:${HTTPS_PORT}`);
    console.log('(Self-signed certificate: accept the browser warning once on each device.)\n');
  });
} else {
  console.log('HTTPS disabled (openssl not found) — phone camera over LAN will not work; webcam & simulator still work.');
}
