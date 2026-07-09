// server.js — Chess Copilot. Zero-dependency Node http server.
// Serves the Climb UI + live Chess.com stats + OpenRouter wizard.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStats } from './lib/chess.js';
import { askWizard } from './lib/wizard.js';
import { isAuthed, checkPassword, authCookieHeader, gateEnabled } from './lib/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- tiny .env loader (no dependency) ----
function loadEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env */ }
}
loadEnv();

const PORT = process.env.PORT || 4750;
const USERNAME = process.env.CHESS_USERNAME || 'hikaru';
const OR_KEY = process.env.OPENROUTER_API_KEY || '';
const OR_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001';

const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // GET /api/auth (status)  &  POST /api/auth { password }
  if (url.pathname === '/api/auth') {
    if (req.method === 'GET') return send(res, 200, { gate: gateEnabled() });
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e4) req.destroy(); });
    req.on('end', () => {
      try {
        const { password } = JSON.parse(buf || '{}');
        if (checkPassword(password)) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': authCookieHeader() });
          return res.end(JSON.stringify({ ok: true }));
        }
        return send(res, 401, { ok: false, error: 'wrong password' });
      } catch (e) { return send(res, 400, { error: String(e.message || e) }); }
    });
    return;
  }

  // GET /api/stats
  if (url.pathname === '/api/stats') {
    if (!isAuthed(req)) return send(res, 401, { error: 'locked' });
    try {
      const force = url.searchParams.get('refresh') === '1';
      const data = await getStats(USERNAME, { force });
      data.wizardConfigured = !!(OR_KEY && !OR_KEY.startsWith('REPLACE'));
      return send(res, 200, data);
    } catch (e) {
      return send(res, 502, { error: String(e.message || e) });
    }
  }

  // POST /api/wizard  { question }
  if (url.pathname === '/api/wizard' && req.method === 'POST') {
    if (!isAuthed(req)) return send(res, 401, { error: 'locked' });
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      try {
        const { question } = JSON.parse(buf || '{}');
        if (!question) return send(res, 400, { error: 'question required' });
        const stats = await getStats(USERNAME);
        const result = await askWizard({ question, stats, apiKey: OR_KEY, model: OR_MODEL });
        return send(res, 200, result);
      } catch (e) {
        return send(res, 502, { error: String(e.message || e) });
      }
    });
    return;
  }

  // GET /api/nudge — manual trigger of the Telegram nudge (local testing)
  if (url.pathname === '/api/nudge') {
    const { default: nudge } = await import('./api/nudge.js');
    const shim = {
      status: (code) => ({ json: (obj) => send(res, code, obj) }),
      setHeader: () => {},
    };
    return nudge({ headers: req.headers, query: Object.fromEntries(url.searchParams) }, shim);
  }

  if (req.method === 'GET') return serveStatic(req, res);
  return send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`\n  ♟  Chess Copilot running → http://localhost:${PORT}`);
  console.log(`     player: ${USERNAME}`);
  console.log(`     wizard: ${OR_KEY && !OR_KEY.startsWith('REPLACE') ? `on (${OR_MODEL})` : 'OFF — add OPENROUTER_API_KEY to .env'}\n`);
});
