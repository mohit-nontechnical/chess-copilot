// lib/chess.js — fetch Chess.com public API and compute behavioral stats for Climb.
// Zero dependencies. Node 18+ (global fetch).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Serverless-safe: writable temp dir (Vercel only allows writes to /tmp).
const CACHE_DIR = path.join(os.tmpdir(), 'chess-copilot-cache');
const CACHE_TTL_MS = 15 * 60 * 1000; // games don't change retroactively; 15-min cache
const MEM = new Map(); // primary cache; survives warm serverless invocations
const UA = 'chess-copilot/1.0 (personal coaching tool)';

const DRAW_RESULTS = new Set([
  'agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient',
]);

function classify(result) {
  if (result === 'win') return 'W';
  if (DRAW_RESULTS.has(result)) return 'D';
  return 'L';
}

// Parse a clean opening family name from a chess.com ECO url.
// e.g. ".../openings/Sicilian-Defense-2.Nf3-d6" -> "Sicilian Defense"
//      ".../openings/Kings-Pawn-Opening-1...e5" -> "Kings Pawn Opening"
function openingName(eco) {
  if (!eco) return null;
  const slug = eco.split('/openings/')[1];
  if (!slug) return null;
  const out = [];
  for (const part of slug.split('-')) {
    if (!part) continue;
    if (/^\d/.test(part) || part.includes('...')) break; // hit the move sequence
    out.push(part);
  }
  // Keep names short: cut at the first "family" word so we get the opening, not the sub-variation.
  // e.g. "Scandinavian Defense Mieses Kotrc Variation" -> "Scandinavian Defense".
  // Fall back to the first 3 words for openings with no family word (e.g. "Ruy Lopez").
  const FAMILY = /^(Defense|Defence|Game|Opening|Gambit|Attack|System)$/i;
  let cut = out.findIndex((w) => FAMILY.test(w));
  cut = cut === -1 ? Math.min(out.length, 3) : cut + 1;
  const name = out.slice(0, cut).join(' ').replace(/\./g, '').trim();
  return name || null;
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Chess.com ${res.status} for ${url}`);
  return res.json();
}

// Pull profile, stats, and the last `months` monthly archives of games.
async function fetchRaw(username, months = 4) {
  const u = encodeURIComponent(username.toLowerCase());
  const base = `https://api.chess.com/pub/player/${u}`;
  const [profile, stats, archiveList] = await Promise.all([
    getJSON(base),
    getJSON(`${base}/stats`),
    getJSON(`${base}/games/archives`),
  ]);
  const recent = (archiveList.archives || []).slice(-months);
  const monthly = await Promise.all(recent.map((a) => getJSON(a).then((r) => r.games || []).catch(() => [])));
  const games = monthly.flat();
  return { profile, stats, games };
}

function loadCache(username) {
  const key = username.toLowerCase();
  const mem = MEM.get(key);
  if (mem && Date.now() - mem._ts < CACHE_TTL_MS) return mem.data;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${key}.json`), 'utf8'));
    if (Date.now() - raw._ts < CACHE_TTL_MS) { MEM.set(key, raw); return raw.data; }
  } catch { /* no file cache */ }
  return null;
}
function saveCache(username, data) {
  const key = username.toLowerCase();
  MEM.set(key, { _ts: Date.now(), data });
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify({ _ts: Date.now(), data }));
  } catch { /* best effort */ }
}

// Normalize a chess.com game into a compact record from `username`'s POV.
function normalize(g, username) {
  const un = username.toLowerCase();
  const meSide = g.white.username.toLowerCase() === un ? 'white' : 'black';
  const me = g[meSide];
  const opp = meSide === 'white' ? g.black : g.white;
  const result = me.result;
  return {
    end: g.end_time,
    side: meSide,
    outcome: classify(result),
    result,
    myRating: me.rating,
    oppRating: opp.rating,
    timeClass: g.time_class,
    opening: openingName(g.eco),
    hour: new Date(g.end_time * 1000).getHours(),
    date: new Date(g.end_time * 1000),
  };
}

function isToday(d) {
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }

// Split a time-sorted list into sessions (games within 10 min of each other).
function sessionize(games) {
  const sessions = [];
  let cur = [];
  for (let i = 0; i < games.length; i++) {
    if (i > 0 && games[i].end - games[i - 1].end >= 600) { sessions.push(cur); cur = []; }
    cur.push(games[i]);
  }
  if (cur.length) sessions.push(cur);
  return sessions;
}

export async function getStats(username, { force = false } = {}) {
  if (!force) { const c = loadCache(username); if (c) return c; }

  const { profile, stats, games: raw } = await fetchRaw(username);
  const blitz = raw.filter((g) => g.time_class === 'blitz').map((g) => normalize(g, username));
  blitz.sort((a, b) => a.end - b.end);

  const rating = stats?.chess_blitz?.last?.rating ?? null;
  const peak = stats?.chess_blitz?.best?.rating ?? null;
  const puzzle = stats?.tactics?.highest?.rating ?? null;

  // ---- TODAY ----
  const todayGames = blitz.filter((g) => isToday(g.date));
  const tWins = todayGames.filter((g) => g.outcome === 'W').length;
  const tLoss = todayGames.filter((g) => g.outcome === 'L').length;
  const tAband = todayGames.filter((g) => g.result === 'abandoned').length;
  const startR = todayGames.find((g) => g.myRating)?.myRating ?? rating;
  const endR = [...todayGames].reverse().find((g) => g.myRating)?.myRating ?? rating;
  const delta = (endR ?? 0) - (startR ?? 0);
  const last5 = blitz.slice(-5).map((g) => (g.outcome === 'W' ? 'W' : 'L'));

  // ---- COLOR ----
  const colorRate = (side) => {
    const s = blitz.filter((g) => g.side === side);
    const w = s.filter((g) => g.outcome === 'W').length;
    return s.length ? w / s.length : 0;
  };
  const white = colorRate('white');
  const black = colorRate('black');

  // ---- OPENINGS ----
  // Aggregate win-rate by opening family. `side` = 'white' | 'black' | null (both).
  const openingAgg = (side, minN) => {
    const map = new Map();
    for (const g of blitz) {
      if (side && g.side !== side) continue;
      if (!g.opening) continue;
      if (!map.has(g.opening)) map.set(g.opening, { name: g.opening, n: 0, w: 0, l: 0 });
      const o = map.get(g.opening);
      o.n++;
      if (g.outcome === 'W') o.w++; else if (g.outcome === 'L') o.l++;
    }
    return [...map.values()]
      .map((o) => ({ ...o, rate: o.w / o.n, pct: Math.round((o.w / o.n) * 100) }))
      .filter((o) => o.n >= minN)
      .sort((a, b) => b.n - a.n);
  };
  const openWhite = openingAgg('white', 4);
  const openBlack = openingAgg('black', 4);
  const rankable = openingAgg(null, 6).sort((a, b) => b.rate - a.rate);
  const openings = {
    white: openWhite.slice(0, 6),
    black: openBlack.slice(0, 6),
    best: rankable.slice(0, 3),
    worst: rankable.slice(-3).reverse().filter((o) => !rankable.slice(0, 3).includes(o)),
  };

  // ---- HOURS ----
  const hourW = Array(24).fill(0), hourN = Array(24).fill(0);
  for (const g of blitz) { hourN[g.hour]++; if (g.outcome === 'W') hourW[g.hour]++; }
  const hours = hourN.map((n, h) => (n >= 3 ? hourW[h] / n : 0.5)); // smooth thin hours to neutral
  // best/worst windows (3h rolling, min sample)
  const winWindows = [];
  for (let h = 0; h <= 21; h++) {
    let w = 0, n = 0;
    for (let k = 0; k < 3; k++) { w += hourW[h + k]; n += hourN[h + k]; }
    if (n >= 8) winWindows.push({ h, rate: w / n, n });
  }
  winWindows.sort((a, b) => b.rate - a.rate);
  const best = winWindows[0];
  const worst = winWindows[winWindows.length - 1];
  const fmtHr = (h) => `${((h % 12) || 12)}${h < 12 ? 'a' : 'p'}`;
  const bestCallout = best ? { label: `${fmtHr(best.h)}–${fmtHr(best.h + 3)}`, pct: Math.round(best.rate * 100) } : null;
  const worstCallout = worst ? { label: `${fmtHr(worst.h)}–${fmtHr(worst.h + 3)}`, pct: Math.round(worst.rate * 100) } : null;

  // ---- HOW YOU LOSE ----
  const losses = blitz.filter((g) => g.outcome === 'L');
  const bucket = { Resigned: 0, Checkmated: 0, Timeout: 0, Abandoned: 0 };
  for (const g of losses) {
    if (g.result === 'resigned') bucket.Resigned++;
    else if (g.result === 'checkmated') bucket.Checkmated++;
    else if (g.result === 'timeout') bucket.Timeout++;
    else if (g.result === 'abandoned') bucket.Abandoned++;
  }
  const lossTotal = losses.length || 1;
  const loseTypes = [
    { k: 'Resigned', v: Math.round((bucket.Resigned / lossTotal) * 100), ctrl: false },
    { k: 'Checkmated', v: Math.round((bucket.Checkmated / lossTotal) * 100), ctrl: false },
    { k: 'Timeout', v: Math.round((bucket.Timeout / lossTotal) * 100), ctrl: true },
    { k: 'Abandoned', v: Math.round((bucket.Abandoned / lossTotal) * 100), ctrl: true },
  ];
  const abandonPct = loseTypes.find((d) => d.k === 'Abandoned').v;

  // ---- TILT MAP (last 24) ----
  const tilt = blitz.slice(-24).map((g) => (g.result === 'abandoned' ? 'a' : g.outcome === 'W' ? 'W' : 'L')).join('');

  // ---- TILT TRIGGER (abandon rate vs opponent strength) ----
  // The known pattern: loss + higher-rated opponent -> abandon. Show him his own trigger.
  const allAbandons = blitz.filter((g) => g.result === 'abandoned');
  const vsHigher = allAbandons.filter((g) => g.oppRating > g.myRating).length;
  const afterLoss = allAbandons.filter((g) => {
    const i = blitz.indexOf(g);
    return i > 0 && blitz[i - 1].outcome === 'L';
  }).length;
  const bucketDef = [
    { key: 'weaker', label: 'Opp rated below you', test: (g) => g.oppRating < g.myRating },
    { key: 'stronger', label: 'Opp rated above you', test: (g) => g.oppRating >= g.myRating },
  ];
  const tiltTrigger = {
    abandons: allAbandons.length,
    vsHigherPct: allAbandons.length ? Math.round((vsHigher / allAbandons.length) * 100) : 0,
    afterLossPct: allAbandons.length ? Math.round((afterLoss / allAbandons.length) * 100) : 0,
    buckets: bucketDef.map((b) => {
      const games = blitz.filter(b.test);
      const ab = games.filter((g) => g.result === 'abandoned').length;
      return { key: b.key, label: b.label, n: games.length, abandons: ab, rate: games.length ? Math.round((ab / games.length) * 100) : 0 };
    }),
  };

  // ---- CONVERSION LEAKS (draws that were probably wins) ----
  // Stalemate / insufficient-material / time-vs-insufficient draws are the classic
  // "winning endgame, didn't convert" signatures at this level.
  const drawGames = blitz.filter((g) => g.outcome === 'D');
  const drawBucket = {};
  for (const g of drawGames) drawBucket[g.result] = (drawBucket[g.result] || 0) + 1;
  const LEAK_TYPES = ['stalemate', 'insufficient', 'timevsinsufficient'];
  const leakCount = LEAK_TYPES.reduce((a, t) => a + (drawBucket[t] || 0), 0);
  const conversions = {
    draws: drawGames.length,
    leaks: leakCount,
    stalemates: drawBucket.stalemate || 0,
    types: [
      { k: 'Stalemate', v: drawBucket.stalemate || 0, leak: true },
      { k: 'Insufficient material', v: drawBucket.insufficient || 0, leak: true },
      { k: 'Time vs insufficient', v: drawBucket.timevsinsufficient || 0, leak: true },
      { k: 'Repetition', v: drawBucket.repetition || 0, leak: false },
      { k: 'Agreed / 50-move', v: (drawBucket.agreed || 0) + (drawBucket['50move'] || 0), leak: false },
    ].filter((t) => t.v > 0),
  };

  // ---- THIS WEEK behavioral scorecard ----
  const weekStart = daysAgo(7);
  const week = blitz.filter((g) => g.date >= weekStart);
  const weekAband = week.filter((g) => g.result === 'abandoned').length;
  const weekSessions = sessionize(week);
  // two-loss-rule: a session "violates" if it continues to play AFTER a 2nd consecutive loss
  let goodSessions = 0;
  for (const s of weekSessions) {
    let streak = 0, violated = false;
    for (let i = 0; i < s.length; i++) {
      if (s[i].outcome === 'L') streak++; else streak = 0;
      if (streak >= 2 && i < s.length - 1) { violated = true; break; }
    }
    if (!violated) goodSessions++;
  }
  const twoLossPct = weekSessions.length ? Math.round((goodSessions / weekSessions.length) * 100) : 100;
  const goodHourGames = week.filter((g) => g.hour >= 9 && g.hour < 13).length;
  const goodHoursPct = week.length ? Math.round((goodHourGames / week.length) * 100) : 0;

  // ---- DAILY HISTORY (reconstructed from archives — no DB) ----
  const keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const byDay = new Map();
  for (const g of blitz) {
    const k = keyOf(g.date);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(g);
  }
  function dayMetrics(games) {
    const gs = [...games].sort((a, b) => a.end - b.end);
    const wins = gs.filter((g) => g.outcome === 'W').length;
    const losses = gs.filter((g) => g.outcome === 'L').length;
    const abandons = gs.filter((g) => g.result === 'abandoned').length;
    const endRating = [...gs].reverse().find((g) => g.myRating)?.myRating ?? null;
    const startRating = gs.find((g) => g.myRating)?.myRating ?? endRating;
    const goodHourGames = gs.filter((g) => g.hour >= 9 && g.hour < 13).length;
    let st = 0, violated = false;
    for (let i = 0; i < gs.length; i++) {
      if (gs[i].outcome === 'L') st++; else st = 0;
      if (st >= 2 && i < gs.length - 1) { violated = true; break; }
    }
    return { games: gs.length, wins, losses, abandons, endRating, delta: (endRating ?? 0) - (startRating ?? 0), goodHourGames, twoLossViolated: violated };
  }
  const dayKeys = [...byDay.keys()].sort();
  const history = dayKeys.slice(-30).map((k) => ({ date: k, label: k.slice(5).replace('-', '/'), ...dayMetrics(byDay.get(k)) }));

  // clean-day streak: consecutive play-days (latest backward) with zero abandons
  let cleanDays = 0;
  for (let i = dayKeys.length - 1; i >= 0; i--) {
    if (dayMetrics(byDay.get(dayKeys[i])).abandons === 0) cleanDays++; else break;
  }
  let bestCleanDays = 0, run = 0;
  for (const k of dayKeys) { if (dayMetrics(byDay.get(k)).abandons === 0) { run++; bestCleanDays = Math.max(bestCleanDays, run); } else run = 0; }

  // streak milestones — give the clean streak something to chase
  const MILESTONES = [3, 7, 14, 30, 50, 100];
  const nextMilestone = MILESTONES.find((m) => m > cleanDays) ?? cleanDays + 50;
  const milestoneHit = MILESTONES.includes(cleanDays) ? cleanDays : null;

  // yesterday's grade
  const yd = new Date(); yd.setDate(yd.getDate() - 1);
  const yKey = keyOf(yd);
  const yesterday = byDay.has(yKey)
    ? (() => { const m = dayMetrics(byDay.get(yKey)); return { ...m, twoLossOk: !m.twoLossViolated }; })()
    : null;

  // ---- SHOULD I PLAY NOW? (in-the-moment tilt guard) ----
  let trailingLosses = 0;
  for (let i = blitz.length - 1; i >= 0; i--) { if (blitz[i].outcome === 'L') trailingLosses++; else break; }
  const nowHour = new Date().getHours();
  const lateNight = nowHour >= 23 || nowHour < 5;
  let recommend = 'go';
  const reasons = [];
  if (trailingLosses >= 2) { recommend = 'stop'; reasons.push(`You've lost ${trailingLosses} in a row — that's exactly your abandon trigger.`); }
  else if (tAband > 0 && trailingLosses >= 1) { recommend = 'stop'; reasons.push('You already abandoned today and just lost — step away before it spirals.'); }
  else if (lateNight && trailingLosses >= 1) { recommend = 'stop'; reasons.push('A loss this late is how the bad sessions start.'); }
  else if (lateNight) { recommend = 'caution'; reasons.push('Late night is your weakest window — keep it short.'); }
  else if (trailingLosses === 1) { recommend = 'caution'; reasons.push('One loss. Fine to continue — but stop if you drop the next one.'); }
  else { reasons.push('No tilt signals. Steady games, and honor the two-loss rule.'); }
  if (cleanDays > 0) reasons.push(`You're on a ${cleanDays}-day clean streak. Protect it.`);
  const playNow = { recommend, reasons, trailingLosses, lateNight };

  // climb roadmap phase
  let phaseIdx = 0;
  if (rating >= 752) phaseIdx = 2; else if (rating >= 650) phaseIdx = 1; else phaseIdx = 0;
  const nextTarget = phaseIdx === 0 ? 650 : phaseIdx === 1 ? 752 : 1000;
  // progress through the current phase (floor -> next gate)
  const phaseFloor = phaseIdx === 0 ? 450 : phaseIdx === 1 ? 650 : 752;
  const phaseProgress = rating != null
    ? Math.max(0, Math.min(100, Math.round(((rating - phaseFloor) / (nextTarget - phaseFloor)) * 100)))
    : 0;

  // ---- GAME OF THE DAY (most instructive recent game) ----
  // Priority: an abandon > the costliest loss > the biggest win. Today first, else yesterday.
  function pickGameOfDay() {
    const ydate = new Date(); ydate.setDate(ydate.getDate() - 1);
    const pool = todayGames.length ? todayGames : blitz.filter((g) => keyOf(g.date) === keyOf(ydate));
    if (!pool.length) return null;
    const withDelta = pool.map((g) => {
      const i = blitz.indexOf(g);
      const prev = i > 0 ? blitz[i - 1].myRating : null;
      return { ...g, delta: prev != null && g.myRating != null ? g.myRating - prev : 0 };
    });
    const abandon = withDelta.find((g) => g.result === 'abandoned');
    const losses2 = withDelta.filter((g) => g.outcome === 'L').sort((a, b) => a.delta - b.delta);
    const wins2 = withDelta.filter((g) => g.outcome === 'W').sort((a, b) => b.delta - a.delta);
    const g = abandon || losses2[0] || wins2[0] || withDelta[withDelta.length - 1];
    return {
      when: todayGames.length ? 'today' : 'yesterday',
      outcome: g.outcome,
      result: g.result,
      side: g.side,
      opening: g.opening,
      myRating: g.myRating,
      oppRating: g.oppRating,
      oppDelta: g.oppRating - g.myRating,
      delta: g.delta,
      hour: g.hour,
      kind: abandon ? 'abandon' : g.outcome === 'L' ? 'loss' : 'win',
    };
  }
  const gameOfDay = pickGameOfDay();

  const data = {
    player: profile.username,
    rating, peak, puzzle, goal: 1000,
    sampleGames: blitz.length,
    today: { wins: tWins, losses: tLoss, abandons: tAband, delta },
    last5: last5.length ? last5 : ['—'],
    white, black,
    whitePct: Math.round(white * 100), blackPct: Math.round(black * 100),
    hours,
    bestCallout, worstCallout,
    loseTypes, abandonPct,
    openings,
    tilt,
    tiltTrigger,
    conversions,
    gameOfDay,
    phaseProgress,
    scorecard: {
      abandons: weekAband,
      twoLossPct,
      goodHoursPct,
      sessions: weekSessions.length,
    },
    history,
    streak: { cleanDays, bestCleanDays, nextMilestone, milestoneHit },
    yesterday,
    playNow,
    phaseIdx, nextTarget,
    updated: Date.now(),
  };
  saveCache(username, data);
  return data;
}

// Compact text summary fed to the wizard LLM (keeps tokens tiny — no raw PGN).
export function statsSummary(d) {
  return [
    `Player ${d.player}. Blitz rating ${d.rating}, peak ${d.peak}, puzzle rating ${d.puzzle}, goal ${d.goal}.`,
    `Sample: ${d.sampleGames} recent blitz games.`,
    `Today: ${d.today.wins}W-${d.today.losses}L, ${d.today.abandons} abandons, rating delta ${d.today.delta}.`,
    `Last 5: ${d.last5.join(' ')}.`,
    `Win rate by color: White ${d.whitePct}%, Black ${d.blackPct}%.`,
    d.bestCallout ? `Best hours ${d.bestCallout.label} (${d.bestCallout.pct}%).` : '',
    d.worstCallout ? `Worst hours ${d.worstCallout.label} (${d.worstCallout.pct}%).` : '',
    `Losses breakdown: ${d.loseTypes.map((t) => `${t.k} ${t.v}%`).join(', ')}. Abandoned ${d.abandonPct}% (controllable leak).`,
    d.openings?.white?.length ? `Openings as White (games/win%): ${d.openings.white.map((o) => `${o.name} ${o.n}/${o.pct}%`).join('; ')}.` : '',
    d.openings?.black?.length ? `Openings as Black (games/win%): ${d.openings.black.map((o) => `${o.name} ${o.n}/${o.pct}%`).join('; ')}.` : '',
    d.openings?.best?.length ? `Strongest openings (min 6 games): ${d.openings.best.map((o) => `${o.name} ${o.pct}% (${o.n})`).join('; ')}.` : '',
    d.openings?.worst?.length ? `Weakest openings (min 6 games): ${d.openings.worst.map((o) => `${o.name} ${o.pct}% (${o.n})`).join('; ')}.` : '',
    d.tiltTrigger?.abandons ? `Tilt trigger: ${d.tiltTrigger.abandons} abandons in sample; ${d.tiltTrigger.vsHigherPct}% vs higher-rated opponents, ${d.tiltTrigger.afterLossPct}% immediately after a loss. Abandon rate by opponent strength: ${d.tiltTrigger.buckets.map((b) => `${b.label} ${b.rate}% (${b.abandons}/${b.n})`).join(', ')}.` : '',
    d.conversions?.draws ? `Draws: ${d.conversions.draws} total, of which ${d.conversions.leaks} look like blown conversions (${d.conversions.stalemates} stalemates). Endgame technique leak.` : '',
    `This week: ${d.scorecard.abandons} abandons, two-loss-rule adherence ${d.scorecard.twoLossPct}%, good-hours play ${d.scorecard.goodHoursPct}%.`,
    `Clean-day streak: ${d.streak.cleanDays} days with zero abandons (best ever ${d.streak.bestCleanDays}, next milestone ${d.streak.nextMilestone} days).`,
    d.gameOfDay ? `Game of the day (${d.gameOfDay.when}): ${d.gameOfDay.kind} as ${d.gameOfDay.side}${d.gameOfDay.opening ? ` in the ${d.gameOfDay.opening}` : ''}, vs opponent rated ${d.gameOfDay.oppRating} (${d.gameOfDay.oppDelta >= 0 ? '+' : ''}${d.gameOfDay.oppDelta} vs him), ended by "${d.gameOfDay.result}", rating delta ${d.gameOfDay.delta}, around ${d.gameOfDay.hour}:00.` : '',
    d.yesterday ? `Yesterday: ${d.yesterday.wins}W-${d.yesterday.losses}L, ${d.yesterday.abandons} abandons, two-loss-rule ${d.yesterday.twoLossOk ? 'kept' : 'broken'}, rating delta ${d.yesterday.delta}.` : 'No games yesterday.',
    `Right now: ${d.playNow.trailingLosses} losses in a row, recommendation "${d.playNow.recommend}".`,
    `Roadmap phase index ${d.phaseIdx} (0=Stabilize,1=Reclaim peak,2=Breakthrough), next target ${d.nextTarget}.`,
  ].filter(Boolean).join('\n');
}
