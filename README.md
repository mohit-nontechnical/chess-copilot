# Chess Copilot ("Climb")

Behavioral chess coaching built on live Chess.com data and an OpenRouter-powered AI wizard.
Point it at any public Chess.com account and it tells you *how you lose*, not just what your rating is.

Zero npm dependencies. One `node server.js` and it runs.

<!-- TODO: add a real screenshot at docs/screenshot.png -->

## What it does

Four screens in a warm editorial UI:

- **Today**: a calm-state banner (good window vs. tilt warning), today's record, last-5 results, the **abandons** hero metric, and a coach nudge.
- **Patterns**: win rate by hour of day, win rate by color, "how you lose" breakdown, tilt map.
- **Climb**: a 3-phase rating roadmap with a weekly behavioral scorecard: abandons, the two-loss rule, and share of games played in your strong hours.
- **Wizard**: an AI coach grounded only in your computed stats. It never sees raw games, so calls cost fractions of a cent.

## Quickstart

```bash
git clone https://github.com/mohit-nontechnical/chess-copilot.git
cd chess-copilot
cp .env.example .env      # set CHESS_USERNAME to your Chess.com handle
npm start                 # → http://localhost:4750
```

That's it. No `npm install`, there are no dependencies. Stats work immediately from the Chess.com public API. The wizard needs an OpenRouter key (see below); until one is set it stays in "configure me" mode.

## Environment variables

All configuration lives in `.env` (see [`.env.example`](.env.example)):

| Variable | Required? | What it is |
|----------|-----------|------------|
| `CHESS_USERNAME` | yes | The Chess.com account to coach (any public account) |
| `OPENROUTER_API_KEY` | for the wizard | Key from https://openrouter.ai/keys |
| `OPENROUTER_MODEL` | optional | Default `google/gemini-2.0-flash-001`; `meta-llama/llama-3.3-70b-instruct:free` works for $0 |
| `PORT` | optional | Local server port (default 4750) |
| `APP_PASSWORD` | optional | Passphrase gate for the UI; unset = open |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | optional | Daily coach nudge via `/api/nudge` (wired to Vercel Cron) |
| `CRON_SECRET` | optional | Shared secret so only the cron (or you) can trigger the nudge |

## Architecture notes

- **Zero-dependency by design.** The server is Node's built-in `http` module; the UI is a single `public/index.html` using CDN React + Babel. No build step, no lockfile, nothing to audit.
- **The LLM never sees raw games.** `lib/chess.js` fetches the Chess.com public API, caches responses for 15 minutes, and computes every behavioral metric in plain JS. `lib/wizard.js` sends only a compact stats summary (a few hundred tokens) to OpenRouter, so each wizard call is tiny and cheap.
- **Behavior over openings.** The metrics target the things that actually cost rating at club level: abandoned games, playing past two losses, and playing outside your strong hours, not move-quality analysis.
- **Runs local or serverless.** `server.js` serves everything locally; the same `lib/` code is reused by Vercel serverless functions in `api/` (`/api/stats`, `/api/wizard`, `/api/auth`, `/api/nudge`), with `vercel.json` scheduling the daily nudge.
- **Optional cookie gate.** `lib/auth.js` is a tiny dependency-free password gate: an HMAC-SHA256 token derived from `APP_PASSWORD`, stored as an HTTP-only cookie, compared with `timingSafeEqual`.

## License

MIT. See [LICENSE](LICENSE).
