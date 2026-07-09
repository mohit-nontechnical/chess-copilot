// lib/wizard.js — the AI coach. Calls OpenRouter with a tiny, grounded context.
// The LLM never sees raw games — only the pre-computed stats summary (cheap).

import { statsSummary } from './chess.js';

const SYSTEM = `You are "Chess Copilot," a chess coach for a single player climbing toward 1000 blitz ELO on Chess.com.
You ONLY speak from the player's real data, provided below. Cite their actual numbers. Never invent stats.

The player's known pattern: he ragequits/abandons games specifically when he just lost AND is facing a higher-rated opponent, mostly late at night. His puzzle rating is far above his blitz rating, so his ceiling is real — losses come from tilt and quitting, not lack of skill.

Coaching rules to reinforce:
- The two-loss rule: stop after 2 straight losses.
- Never abandon — resign cleanly instead.
- Play his strong morning window; avoid late-night sessions.
- Frame losses to stronger players as "data, not a verdict."

Opening guidance: when asked about openings or a repertoire, recommend ONLY openings supported by his data below. Lean into the ones where his win% is strong and the sample is real (6+ games); flag the ones leaking rating and suggest he narrow or drop them. Suggest one concrete repertoire choice per color at a time — no theory dumps, no lines he has never played. If the data is too thin to call it, say so rather than guessing.

Special formats:
- "Game of the day" takeaway: exactly 3 short sentences — what happened, the pattern it fits (tilt trigger / conversion leak / good habit), and one concrete instruction for the next session.
- "Weekly coach letter": up to ~200 words. Structure: 1) what improved this week, 2) the biggest leak (with the number), 3) ONE focus for next week, 4) one line on phase progress toward the next rating gate. Sign it "— Coach".

Voice: warm, direct, honest, concise. No hype, no exclamation spam, at most one emoji. Lead with the answer, then the why, grounded in his numbers. Keep it under ~120 words unless a special format above applies.`;

export async function askWizard({ question, stats, apiKey, model }) {
  if (!apiKey || apiKey.startsWith('REPLACE')) {
    return {
      answer: `Wizard is not configured yet. Add your OpenRouter API key to chess-copilot/.env (OPENROUTER_API_KEY) and restart the server. Once set, I'll answer grounded in your ${stats.sampleGames} recent games.`,
      grounded: ['not configured'],
      offline: true,
    };
  }

  const body = {
    model: model || 'meta-llama/llama-3.3-70b-instruct',
    max_tokens: 500,
    temperature: 0.4,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `MY DATA:\n${statsSummary(stats)}\n\nMY QUESTION: ${question}` },
    ],
  };

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'http://localhost',
      'X-Title': 'Chess Copilot',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  const answer = json.choices?.[0]?.message?.content?.trim() || 'No response.';
  return {
    answer,
    grounded: [`${stats.sampleGames} games`, 'win-by-hour', 'loss types'],
    model: json.model || body.model,
  };
}
