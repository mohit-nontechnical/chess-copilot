// Vercel serverless function: POST /api/wizard
import { getStats } from '../lib/chess.js';
import { askWizard } from '../lib/wizard.js';
import { isAuthed } from '../lib/auth.js';

export default async function handler(req, res) {
  if (!isAuthed(req)) return res.status(401).json({ error: 'locked' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const username = process.env.CHESS_USERNAME || 'hikaru';
  const apiKey = process.env.OPENROUTER_API_KEY || '';
  const model = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001';
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    const question = body?.question;
    if (!question) return res.status(400).json({ error: 'question required' });
    const stats = await getStats(username);
    const result = await askWizard({ question, stats, apiKey, model });
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(result);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
