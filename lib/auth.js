// lib/auth.js — tiny cookie-based password gate. No dependencies.
import crypto from 'node:crypto';

const COOKIE = 'cc_auth';

function password() { return process.env.APP_PASSWORD || ''; }

// Deterministic token derived from the password — server can always recompute it.
export function expectedToken() {
  const p = password();
  if (!p) return '';
  return crypto.createHmac('sha256', p).update('chess-copilot-v1').digest('hex');
}

export function gateEnabled() { return !!password(); }

function readCookie(req, name) {
  const raw = req.headers?.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

export function isAuthed(req) {
  if (!gateEnabled()) return true; // no password set => open
  const got = readCookie(req, COOKIE);
  const want = expectedToken();
  if (!got || got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch { return false; }
}

export function checkPassword(input) {
  const p = password();
  if (!p) return true;
  if (typeof input !== 'string' || input.length !== p.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(input), Buffer.from(p)); } catch { return false; }
}

export function authCookieHeader() {
  const maxAge = 60 * 60 * 24 * 30; // 30 days
  return `${COOKIE}=${expectedToken()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
