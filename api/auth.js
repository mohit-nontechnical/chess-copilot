// Vercel serverless function: POST /api/auth { password }  -> sets auth cookie
import { checkPassword, authCookieHeader, gateEnabled } from '../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ gate: gateEnabled() });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    if (checkPassword(body?.password)) {
      res.setHeader('Set-Cookie', authCookieHeader());
      return res.status(200).json({ ok: true });
    }
    return res.status(401).json({ ok: false, error: 'wrong password' });
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
}
