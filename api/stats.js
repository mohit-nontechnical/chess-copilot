// Vercel serverless function: GET /api/stats
import { getStats } from '../lib/chess.js';
import { isAuthed } from '../lib/auth.js';

export default async function handler(req, res) {
  if (!isAuthed(req)) return res.status(401).json({ error: 'locked' });
  const username = process.env.CHESS_USERNAME || 'hikaru';
  const orKey = process.env.OPENROUTER_API_KEY || '';
  try {
    const force = req.query?.refresh === '1';
    const data = await getStats(username, { force });
    data.wizardConfigured = !!(orKey && !orKey.startsWith('REPLACE'));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
