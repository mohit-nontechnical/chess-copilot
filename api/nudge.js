// Vercel serverless function: GET /api/nudge — daily Telegram accountability nudge.
// Triggered by Vercel Cron (see vercel.json). On Sundays it sends the weekly coach
// letter (one cheap LLM call/week); other days it's a free, computed-only message.
//
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, CRON_SECRET (recommended).
import { getStats } from '../lib/chess.js';
import { askWizard } from '../lib/wizard.js';

function authorized(req) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return true; // no secret configured => open (set one in prod)
  const header = req.headers?.authorization || '';
  if (header === `Bearer ${secret}`) return true; // Vercel Cron sends this
  return req.query?.secret === secret; // manual testing
}

function dailyMessage(d) {
  const lines = [`♟ <b>Climb — daily check-in</b>`];
  if (d.yesterday) {
    const y = d.yesterday;
    lines.push(`Yesterday: <b>${y.wins}W–${y.losses}L</b>, ${y.abandons} abandon${y.abandons === 1 ? '' : 's'}, rating ${y.delta >= 0 ? '+' : ''}${y.delta}. Two-loss rule ${y.twoLossOk ? 'kept ✅' : 'broken ❌'}.`);
  } else {
    lines.push(`No games yesterday. A rest day never broke a streak.`);
  }
  if (d.streak.cleanDays > 0) {
    lines.push(`Clean streak: <b>${d.streak.cleanDays} day${d.streak.cleanDays === 1 ? '' : 's'}</b> (best ${d.streak.bestCleanDays}). Next milestone: ${d.streak.nextMilestone} days.`);
  }
  lines.push(`Rating <b>${d.rating}</b> → next gate <b>${d.nextTarget}</b> (${d.phaseProgress}% through this phase).`);
  lines.push(`Your good window opens at <b>10am</b>. Play there, stop after two losses, never abandon.`);
  return lines.join('\n');
}

async function weeklyLetter(d) {
  const apiKey = process.env.OPENROUTER_API_KEY || '';
  const model = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct';
  if (!apiKey || apiKey.startsWith('REPLACE')) return null;
  const result = await askWizard({
    question: 'Write my weekly coach letter.',
    stats: d, apiKey, model,
  });
  return `♟ <b>Climb — weekly coach letter</b>\n\n${result.answer}`;
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(`Telegram ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const username = process.env.CHESS_USERNAME || 'hikaru';
  try {
    const d = await getStats(username, { force: true });
    const isSunday = new Date().getUTCDay() === 0;
    let kind = 'daily';
    let text = dailyMessage(d);
    if (isSunday || req.query?.weekly === '1') {
      const letter = await weeklyLetter(d);
      if (letter) { text = letter; kind = 'weekly'; }
    }
    await sendTelegram(text);
    res.status(200).json({ ok: true, kind, sent: true });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
}
