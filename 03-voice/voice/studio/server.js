// breeze-studio server: serves the studio page and proxies /api/* to the local
// TTS server, starting it on demand. Node's http module binds 127.0.0.1 without
// needing an admin URL reservation (PowerShell's HttpListener does not).
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Machine-specific locations come from <package root>\voice-paths.json (written
// by the installer). Missing or unreadable file = the defaults below, so a
// fresh copy of the bundle still works. Layout: <pkg root>\voice\studio[\].
const PKG_ROOT = path.join(__dirname, '..', '..');

function readVoicePaths() {
  const file = path.join(PKG_ROOT, 'voice-paths.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

const PATHS = readVoicePaths();

// Values are taken only when present and non-empty, exactly like the PowerShell
// side: a key with null/'' falls back instead of producing an empty path.
function vp(name, fallback) {
  const v = PATHS[name];
  return (typeof v === 'string' && v.trim()) ? v : fallback;
}

// Fallback defaults are generic on purpose: bridge files live under the DSH home
// (DSH_HOME, else ~/.dsh) and the model/binary root is <pkg root>\engine-runtime
// (install.ps1 unpacks the engine there). voice-paths.json, when present, wins.
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const BRIDGE_HOME = path.join(DSH_HOME, 'qq-bridge');

const ROOT = vp('voiceRoot', path.join(PKG_ROOT, 'engine-runtime'));
const RUN_DIR = path.join(ROOT, 'run');
const ACTIVITY = path.join(RUN_DIR, 'last-activity.txt');
const STUDIO_DIR = vp('studioDir', path.join(PKG_ROOT, 'voice', 'studio'));
const PAGE = path.join(STUDIO_DIR, 'index.html');
const LAUNCHER = path.join(__dirname, '..', 'scripts', 'breeze-tts.ps1');
const VOICES_DIR = vp('voicesDir', path.join(BRIDGE_HOME, 'voice', 'breeze-voices'));
// deleted voices are recycled next to the live ones, not unlinked
const VOICES_TRASH = path.join(path.dirname(VOICES_DIR), 'voices-deleted');
const CONFIG = vp('configFile', path.join(BRIDGE_HOME, 'breeze-tts.json'));
const PERSONA_FILE = vp('personaFile', path.join(BRIDGE_HOME, 'personas.json'));
const PERSONA_VOICES = vp('voicePersonas', path.join(BRIDGE_HOME, 'voice-personas.json'));
const UPSTREAM_PORT = 8137;
const PORT = Number(process.argv[2] || 8140);
const UPSTREAM_TIMEOUT_MS = 240000;

function touchActivity() {
  try {
    if (!fs.existsSync(RUN_DIR)) fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.writeFileSync(ACTIVITY, new Date().toISOString());
  } catch (e) { /* ignore */ }
}

function ensureServer() {
  console.log('starting tts server on demand');
  try {
    execFileSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', LAUNCHER, '-EnsureServer'],
      { timeout: 150000, windowsHide: true, stdio: 'ignore' });
    return true;
  } catch (e) {
    console.log('ensure failed: ' + String(e && e.message));
    return false;
  }
}

// Send one upstream request with an already-buffered body. Calls back with
// (err, status, headers, body) exactly once.
function upstream(method, target, headers, body, cb) {
  let done = false;
  const finish = (err, status, hdrs, buf) => { if (!done) { done = true; cb(err, status, hdrs, buf); } };
  const req = http.request({ host: '127.0.0.1', port: UPSTREAM_PORT, path: target, method, headers }, (res) => {
    const parts = [];
    res.on('data', c => parts.push(c));
    res.on('end', () => finish(null, res.statusCode, res.headers, Buffer.concat(parts)));
  });
  req.on('error', (err) => finish(err));
  req.setTimeout(UPSTREAM_TIMEOUT_MS, () => req.destroy(new Error('upstream timeout')));
  if (body && body.length) req.write(body);
  req.end();
}

function handleApi(req, res) {
  const target = req.url.replace(/^\/api/, '') || '/';
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers = {};
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    if (body.length) headers['content-length'] = body.length;

    const send = (status, hdrs, buf) => {
      const out = { 'content-type': (hdrs && hdrs['content-type']) || 'application/octet-stream' };
      if (hdrs && hdrs['x-sample-rate']) out['x-sample-rate'] = hdrs['x-sample-rate'];
      res.writeHead(status, out);
      res.end(buf);
    };

    touchActivity();
    upstream(req.method, target, headers, body, (err, status, hdrs, buf) => {
      if (!err) { send(status, hdrs, buf); return; }
      if (String(err.code) === 'ECONNREFUSED' || /ECONNREFUSED/.test(String(err.message))) {
        // server is asleep: start it, then retry once (the body is already buffered)
        if (ensureServer()) {
          touchActivity();
          upstream(req.method, target, headers, body, (err2, status2, hdrs2, buf2) => {
            if (err2) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'tts server did not come back: ' + String(err2.message) })); return; }
            send(status2, hdrs2, buf2);
          });
          return;
        }
      }
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'tts upstream unreachable: ' + String(err && err.message) }));
    });
  });
}

/* ---------- admin: saved voices and the QQ bridge voice ---------- */

function validId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id); }

// Deleting a saved voice moves its file here instead of unlinking it, so an
// accidental × on a persona chip can be undone by putting the file back.
function recycle(file, id) {
  try {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const dir = path.join(VOICES_TRASH, stamp);
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(file, path.join(dir, id + '.breeze'));
    return true;
  } catch (e) {
    try { fs.unlinkSync(file); return true; } catch (e2) { return false; }
  }
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { return {}; }
}

function writeConfig(cfg) {
  const tmp = CONFIG + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG);
}

function readBody(req, cb) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')));
}

function json(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

function listSaved() {
  try {
    return fs.readdirSync(VOICES_DIR).filter(f => f.toLowerCase().endsWith('.breeze'))
      .map(f => f.replace(/\.breeze$/i, ''));
  } catch (e) { return []; }
}

function handleAdmin(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  // persona voices: one chip per 性格模式 in personas.json, base from voice-personas.json
  if (p === '/admin/personas' && req.method === 'GET') {
    let map = {}, people = {};
    try { map = JSON.parse(fs.readFileSync(PERSONA_VOICES, 'utf8')); } catch (e) { }
    try { people = JSON.parse(fs.readFileSync(PERSONA_FILE, 'utf8')); } catch (e) { }
    const out = [];
    const seen = {};
    const chats = (people && people.chats) || {};
    Object.keys(chats).forEach((ck) => {
      const chat = chats[ck];
      const modes = (chat && chat.modes) || {};
      Object.keys(modes).forEach((name) => {
        if (seen[name]) return;
        // only the modes that actually have a curated voice in voice-personas.json
        const entry = (map && map.personas && map.personas[name]) || null;
        if (!entry || entry.hidden) return;
        seen[name] = true;
        out.push({ name, base: entry.base || '', active: chat.active === name, chat: ck });
      });
    });
    return json(res, 200, out);
  }

  // resolve the full voice description the TTS launcher would derive for a mode
  if (p === '/admin/persona' && req.method === 'GET') {
    const name = url.searchParams.get('name') || '';
    if (!name) { return json(res, 400, { error: 'missing name' }); }
    try {
      // the child writes to a pipe, where PowerShell 5.1 would use the OEM code
      // page; force UTF-8 out and pass the (possibly Chinese) name via env
      const out = execFileSync('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & '" + LAUNCHER + "' -Persona $env:BREEZE_PERSONA -ShowVoice"],
        { timeout: 30000, windowsHide: true, encoding: 'utf8', env: Object.assign({}, process.env, { BREEZE_PERSONA: name }) });
      const m = /instruction=(.*)$/m.exec(out || '');
      if (!m) { return json(res, 500, { error: 'could not parse: ' + (out || '').slice(0, 200) }); }
      let voiceId = '';
      try {
        const vm = JSON.parse(fs.readFileSync(PERSONA_VOICES, 'utf8'));
        const e = vm && vm.personas && vm.personas[name];
        if (e && e.voiceId && fs.existsSync(path.join(VOICES_DIR, e.voiceId + '.breeze'))) voiceId = e.voiceId;
      } catch (e2) { }
      return json(res, 200, { name, instruction: m[1].trim(), voiceId });
    } catch (e) {
      return json(res, 500, { error: 'resolve failed: ' + String(e && e.message) });
    }
  }

  if (p === '/admin/bridge' && req.method === 'GET') {
    const cfg = readConfig();
    return json(res, 200, {
      voiceId: cfg.voiceId || '',
      instruction: cfg.instruction || '',
      model: cfg.model || 'q4',
      enabled: cfg.enabled !== false,
      saved: listSaved()
    });
  }

  if (p === '/admin/bridge' && req.method === 'POST') {
    return readBody(req, (raw) => {
      let body;
      try { body = JSON.parse(raw); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      const voiceId = String(body.voiceId || '').trim();
      const instruction = String(body.instruction || '').slice(0, 600);
      if (voiceId && !validId(voiceId)) { return json(res, 400, { error: 'voice id: letters, digits, dash, underscore' }); }
      if (voiceId && !fs.existsSync(path.join(VOICES_DIR, voiceId + '.breeze'))) {
        return json(res, 404, { error: 'voice not saved: ' + voiceId });
      }
      const cfg = readConfig();
      cfg.voiceId = voiceId;
      if (instruction) { cfg.instruction = instruction; }
      try { writeConfig(cfg); } catch (e) { return json(res, 500, { error: 'config write failed: ' + e.message }); }
      return json(res, 200, { ok: true, voiceId: cfg.voiceId, instruction: cfg.instruction });
    });
  }

  if (p === '/admin/persona' && req.method === 'DELETE') {
    const name = url.searchParams.get('name') || '';
    if (!name) { return json(res, 400, { error: 'missing name' }); }
    let map;
    try { map = JSON.parse(fs.readFileSync(PERSONA_VOICES, 'utf8')); } catch (e) { return json(res, 500, { error: 'voice map unreadable' }); }
    if (!map.personas || !map.personas[name]) { return json(res, 404, { error: 'no voice mapped for ' + name }); }

    const entry = map.personas[name];
    const gone = new Set();
    if (entry && entry.voiceId) gone.add(entry.voiceId);

    // keep a timestamped copy before rewriting the mapping
    try {
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      fs.copyFileSync(PERSONA_VOICES, PERSONA_VOICES + '.bak-' + stamp);
    } catch (e) { }

    delete map.personas[name];
    // other modes that shared that same saved voice (hidden aliases) go too
    let aliases = 0;
    Object.keys(map.personas).forEach((k) => {
      const e2 = map.personas[k];
      if (e2 && e2.voiceId && gone.has(e2.voiceId)) { delete map.personas[k]; aliases++; }
    });
    try { fs.writeFileSync(PERSONA_VOICES, JSON.stringify(map, null, 2), 'utf8'); }
    catch (e) { return json(res, 500, { error: 'write failed: ' + e.message }); }

    const drop = (method, path_) => new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: UPSTREAM_PORT, path: path_, method }, (resp) => {
        resp.resume(); resp.on('end', resolve);
      });
      r.on('error', () => resolve());
      r.setTimeout(5000, () => { r.destroy(); resolve(); });
      r.end();
    });

    const jobs = Array.from(gone).map((id) => drop('DELETE', '/v1/voices/' + id));
    return Promise.all(jobs).then(() => {
      let removedFile = false;
      gone.forEach((id) => {
        const f = path.join(VOICES_DIR, id + '.breeze');
        try { if (fs.existsSync(f)) { removedFile = recycle(f, id) || removedFile; } } catch (e) { }
      });
      // if the bridge pointed at the deleted voice, clear it
      const cfg = readConfig();
      let cleared = false;
      if (cfg.voiceId && gone.has(cfg.voiceId)) { cfg.voiceId = ''; try { writeConfig(cfg); cleared = true; } catch (e) { } }
      return json(res, 200, { ok: true, name, removedFile, aliases, bridgeCleared: cleared });
    });
  }

  if (p === '/admin/voice' && req.method === 'DELETE') {
    const id = url.searchParams.get('id') || '';
    if (!validId(id)) { return json(res, 400, { error: 'bad id' }); }
    const file = path.join(VOICES_DIR, id + '.breeze');
    // drop it from the running server's memory first (ignored if it is not there)
    const drop = (method, path_) => new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: UPSTREAM_PORT, path: path_, method }, (resp) => {
        resp.resume(); resp.on('end', resolve); 
      });
      r.on('error', () => resolve());
      r.setTimeout(5000, () => { r.destroy(); resolve(); });
      r.end();
    });
    return drop('DELETE', '/v1/voices/' + id).then(() => {
      let removed = false;
      try { if (fs.existsSync(file)) { removed = recycle(file, id); } } catch (e) { removed = false; }
      // if the bridge was using it, clear the setting so the bridge does not 404
      const cfg = readConfig();
      let cleared = false;
      if ((cfg.voiceId || '') === id) { cfg.voiceId = ''; try { writeConfig(cfg); cleared = true; } catch (e) { } }
      return json(res, 200, { ok: true, removedFile: removed, bridgeCleared: cleared });
    });
  }

  return json(res, 404, { error: 'no such admin route' });
}

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/' || req.url.startsWith('/index.html')) {
      const html = fs.readFileSync(PAGE);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.url.startsWith('/admin/')) { handleAdmin(req, res); return; }
    if (req.url.startsWith('/api/')) { handleApi(req, res); return; }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(e && e.message));
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.log('port ' + PORT + ' already in use, another studio server is running');
    process.exit(0);
  }
  console.log('server error: ' + String(err && err.message));
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('breeze studio on http://127.0.0.1:' + PORT + '/');
});
