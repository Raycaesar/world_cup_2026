#!/usr/bin/env node
/*
  Safe auto-update World Cup results in data.json from ESPN's scoreboard feed.

  Design rules:
  1. Only update matches that move from unfinished to finished.
  2. Finished matches with manual_points are frozen by default.
  3. Historical matchday points are never recomputed unless that matchday contains a newly finished match.
  4. Totals are computed from matchday day totals, not by replaying every match.
  5. If a guard detects total collapse or historical point mutation, the script exits before writing.

  Usage:
    node scripts/update_scores.js
    node scripts/update_scores.js --dry-run

  Optional env:
    DATA_PATH=data.json
    SCOREBOARD_FIXTURE=/path/to/espn-scoreboard.json
    UPDATE_LOG_LIMIT=10
    NO_UPDATE_LOG=1
    ALLOW_REWRITE_FINISHED=1   # use only for deliberate repair; default is frozen
*/

const fs = require("node:fs");
const path = require("node:path");

const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const BJT_TIME_ZONE = "Asia/Shanghai";
const DATA_PATH = process.env.DATA_PATH || "data.json";
const DRY_RUN = process.argv.includes("--dry-run");
const UPDATE_LOG_LIMIT = Number(process.env.UPDATE_LOG_LIMIT || 10);
const SHOULD_UPDATE_LOG = process.env.NO_UPDATE_LOG !== "1";
const ALLOW_REWRITE_FINISHED = process.env.ALLOW_REWRITE_FINISHED === "1";

const TEAM_ZH = {
  "Mexico": "墨西哥",
  "South Africa": "南非",
  "Korea Republic": "韩国",
  "South Korea": "韩国",
  "Czechia": "捷克",
  "Czech Republic": "捷克",
  "Canada": "加拿大",
  "Bosnia and Herzegovina": "波黑",
  "Bosnia-Herzegovina": "波黑",
  "United States": "美国",
  "USA": "美国",
  "Paraguay": "巴拉圭",
  "Qatar": "卡塔尔",
  "Switzerland": "瑞士",
  "Brazil": "巴西",
  "Morocco": "摩洛哥",
  "Haiti": "海地",
  "Scotland": "苏格兰",
  "Australia": "澳大利亚",
  "Turkey": "土耳其",
  "Türkiye": "土耳其",
  "Germany": "德国",
  "Curacao": "库拉索",
  "Curaçao": "库拉索",
  "Netherlands": "荷兰",
  "Japan": "日本",
  "Ivory Coast": "科特迪瓦",
  "Côte d'Ivoire": "科特迪瓦",
  "Cote d'Ivoire": "科特迪瓦",
  "Ecuador": "厄瓜多尔",
  "Sweden": "瑞典",
  "Tunisia": "突尼斯",
  "Spain": "西班牙",
  "Cape Verde": "佛得角",
  "Cabo Verde": "佛得角",
  "Belgium": "比利时",
  "Egypt": "埃及",
  "Saudi Arabia": "沙特",
  "Uruguay": "乌拉圭",
  "Iran": "伊朗",
  "IR Iran": "伊朗",
  "New Zealand": "新西兰",
  "France": "法国",
  "Senegal": "塞内加尔",
  "Iraq": "伊拉克",
  "Norway": "挪威",
  "Argentina": "阿根廷",
  "Algeria": "阿尔及利亚",
  "Austria": "奥地利",
  "Jordan": "约旦",
  "Portugal": "葡萄牙",
  "DR Congo": "刚果（金）",
  "Congo DR": "刚果（金）",
  "Uzbekistan": "乌兹别克斯坦",
  "Colombia": "哥伦比亚",
  "England": "英格兰",
  "Croatia": "克罗地亚",
  "Ghana": "加纳",
  "Panama": "巴拿马"
};

const NAME_ALIASES = {
  "象牙海岸": "科特迪瓦",
  "南韩": "韩国",
  "美国队": "美国",
  "刚果民主共和国": "刚果（金）",
  "佛得角群岛": "佛得角",
  "库拉çao": "库拉索"
};

function normalizeName(name) {
  const raw = String(name || "").trim();
  return NAME_ALIASES[raw] || TEAM_ZH[raw] || raw;
}

function isValidOutcome(outcome) {
  return outcome === "home" || outcome === "away" || outcome === "draw";
}

function ymdUTC(date) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function formatBJT(dateLike) {
  if (!dateLike) return "";
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: BJT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} BJT`;
}

function shortBJT(dateLike) {
  if (!dateLike) return "";
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: BJT_TIME_ZONE,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value || "";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")} BJT`;
}

function dateKeyBJT(dateLike) {
  if (!dateLike) return "";
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: BJT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function teamName(competitor) {
  const raw = competitor?.team?.displayName || competitor?.team?.name || competitor?.team?.shortDisplayName || "";
  return normalizeName(raw);
}

function normalizeEvent(event) {
  const competition = event.competitions?.[0] || {};
  const competitors = competition.competitors || [];
  const home = competitors.find(c => c.homeAway === "home") || competitors[0] || {};
  const away = competitors.find(c => c.homeAway === "away") || competitors[1] || {};
  const statusType = competition.status?.type || event.status?.type || {};
  const state = statusType.state || "pre";
  const completed = state === "post" || statusType.completed === true;
  const homeScore = Number(home.score ?? NaN);
  const awayScore = Number(away.score ?? NaN);

  return {
    espn_id: String(event.id || ""),
    state,
    completed,
    home: teamName(home),
    away: teamName(away),
    home_score: Number.isFinite(homeScore) ? homeScore : null,
    away_score: Number.isFinite(awayScore) ? awayScore : null,
    status_text: completed ? "FT" : (competition.status?.displayClock || statusType.detail || statusType.shortDetail || ""),
    kickoff_bjt: shortBJT(event.date),
    kickoff_date_bjt: dateKeyBJT(event.date),
    kickoff_ts: event.date ? new Date(event.date).getTime() : 0
  };
}

async function loadScoreboard() {
  if (process.env.SCOREBOARD_FIXTURE) {
    const fixturePath = path.resolve(process.env.SCOREBOARD_FIXTURE);
    return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  }

  const now = new Date();
  const start = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + 72 * 60 * 60 * 1000);
  const url = `${ESPN_SCOREBOARD}?limit=100&dates=${ymdUTC(start)}-${ymdUTC(end)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`ESPN scoreboard failed: ${res.status}`);
  return res.json();
}

function pickOutcome(home, away) {
  if (home === null || away === null || home === undefined || away === undefined) return "pending";
  if (home > away) return "home";
  if (home < away) return "away";
  return "draw";
}

function parsePrediction(pred) {
  if (!pred) return { home_score: null, away_score: null, outcome: "pending" };
  return {
    home_score: Number.isFinite(Number(pred.home_score)) ? Number(pred.home_score) : null,
    away_score: Number.isFinite(Number(pred.away_score)) ? Number(pred.away_score) : null,
    outcome: pickOutcome(pred.home_score, pred.away_score)
  };
}

function samePrediction(a, b) {
  if (!a || !b) return false;
  return a.home_score === b.home_score && a.away_score === b.away_score;
}

function exactScore(pred, actual) {
  return pred && actual && pred.home_score === actual.home_score && pred.away_score === actual.away_score;
}

function drawOnlyCloseness(rayOutcome, gptOutcome) {
  // This rule is intentionally narrow:
  // only when both are wrong and exactly one side predicted draw does that side get 1 point.
  // No numeric goal-difference closeness is used.
  if (!isValidOutcome(rayOutcome) || !isValidOutcome(gptOutcome)) return null;
  if (rayOutcome === "draw" && gptOutcome !== "draw") return "ray";
  if (gptOutcome === "draw" && rayOutcome !== "draw") return "gpt";
  return null;
}

function calculateMatchPoints(match) {
  const actual = match.actual_score;
  if (!actual || actual.home_score === null || actual.away_score === null || actual.home_score === undefined || actual.away_score === undefined) {
    return { ray: 0, gpt: 0, explanation: "比赛尚未结束，暂不计分。" };
  }

  const ray = parsePrediction(match.ray_prediction);
  const gpt = parsePrediction(match.gpt_prediction);
  const actualOutcome = pickOutcome(actual.home_score, actual.away_score);

  if (!isValidOutcome(ray.outcome) || !isValidOutcome(gpt.outcome) || !isValidOutcome(actualOutcome)) {
    return { ray: 0, gpt: 0, explanation: "至少一方没有有效预测，本场不计分。" };
  }

  if (samePrediction(match.ray_prediction, match.gpt_prediction)) {
    return { ray: 0, gpt: 0, explanation: "双方预测完全相同，本场不计分。" };
  }

  const rayCorrect = ray.outcome === actualOutcome;
  const gptCorrect = gpt.outcome === actualOutcome;
  const rayExact = exactScore(match.ray_prediction, actual);
  const gptExact = exactScore(match.gpt_prediction, actual);

  if (rayCorrect && !gptCorrect) {
    const pts = 3 + (rayExact ? 1 : 0);
    return { ray: pts, gpt: 0, explanation: rayExact ? "Ray 猜对胜平负且比分完全命中，得到 4 分。" : "Ray 猜对胜平负，得到 3 分。" };
  }

  if (!rayCorrect && gptCorrect) {
    const pts = 3 + (gptExact ? 1 : 0);
    return { ray: 0, gpt: pts, explanation: gptExact ? "GPT 猜对胜平负且比分完全命中，得到 4 分。" : "GPT 猜对胜平负，得到 3 分。" };
  }

  if (rayCorrect && gptCorrect) {
    if (rayExact && !gptExact) {
      return { ray: 1, gpt: 0, explanation: "双方都猜对胜平负，胜平负不拉开差距；Ray 比分完全命中，得到 1 分。" };
    }
    if (!rayExact && gptExact) {
      return { ray: 0, gpt: 1, explanation: "双方都猜对胜平负，胜平负不拉开差距；GPT 比分完全命中，得到 1 分。" };
    }
    return { ray: 0, gpt: 0, explanation: "双方都猜对胜平负，但没有形成比分命中差异，本场不计分。" };
  }

  const closer = drawOnlyCloseness(ray.outcome, gpt.outcome);
  if (closer === "ray") {
    return { ray: 1, gpt: 0, explanation: "双方都猜错，但只有 Ray 预测平局，按平局接近度规则 Ray 得到 1 分。" };
  }
  if (closer === "gpt") {
    return { ray: 0, gpt: 1, explanation: "双方都猜错，但只有 GPT 预测平局，按平局接近度规则 GPT 得到 1 分。" };
  }

  return { ray: 0, gpt: 0, explanation: "双方都猜错，且没有触发平局接近度规则，本场不计分。" };
}

function predictionText(pred) {
  if (!pred || pred.home_score === null || pred.home_score === undefined || pred.away_score === null || pred.away_score === undefined) return "未明确预测";
  return `${pred.home_score}:${pred.away_score}`;
}

function matchKey(home, away) {
  return `${normalizeName(home)}__${normalizeName(away)}`;
}

function reverseEvent(event) {
  return {
    ...event,
    home: event.away,
    away: event.home,
    home_score: event.away_score,
    away_score: event.home_score,
    reversed: true
  };
}

function buildEventIndex(events) {
  const index = new Map();
  for (const e of events) {
    index.set(matchKey(e.home, e.away), e);
    index.set(matchKey(e.away, e.home), reverseEvent(e));
  }
  return index;
}

function collectMatchRefs(data) {
  const refs = [];
  const seen = new Set();

  function add(match, location, dayDate = null) {
    if (!match || !match.home || !match.away) return;
    const refId = `${location}:${match.id || match.home + "-" + match.away}`;
    if (seen.has(refId)) return;
    seen.add(refId);
    refs.push({ match, location, dayDate });
  }

  (data.today_matches || []).forEach(m => add(m, "today", null));
  (data.matchdays || []).forEach(day => (day.matches || []).forEach(m => add(m, `day:${day.date}`, day.date)));
  return refs;
}

function isFinished(match) {
  const actual = match.actual_score || {};
  return actual.home_score !== null && actual.home_score !== undefined && actual.away_score !== null && actual.away_score !== undefined && String(match.status || "").includes("已结束");
}

function hasFrozenPoints(match) {
  return match.manual_points && Number.isFinite(Number(match.manual_points.ray)) && Number.isFinite(Number(match.manual_points.gpt));
}

function buildReview(match, pts) {
  const actual = match.actual_score || {};
  return `${match.home} ${actual.home_score}:${actual.away_score} ${match.away}。Ray 预测 ${predictionText(match.ray_prediction)}，GPT 预测 ${predictionText(match.gpt_prediction)}。${pts.explanation} 本场得分：Ray +${pts.ray}，GPT +${pts.gpt}。`;
}

function updateOneMatch(match, event) {
  const actual = { home_score: event.home_score, away_score: event.away_score };
  const oldActual = match.actual_score || {};
  const wasFinished = isFinished(match);
  const scoreAlreadySame = oldActual.home_score === actual.home_score && oldActual.away_score === actual.away_score;

  // Freeze already finalized matches. If ESPN later differs, fail safely instead of silently rewriting history.
  if (wasFinished && hasFrozenPoints(match) && !ALLOW_REWRITE_FINISHED) {
    if (!scoreAlreadySame) {
      throw new Error(`Refusing to rewrite frozen match ${match.home}-${match.away}: data has ${oldActual.home_score}:${oldActual.away_score}, ESPN has ${actual.home_score}:${actual.away_score}. Use ALLOW_REWRITE_FINISHED=1 only for a deliberate repair.`);
    }
    return null;
  }

  if (wasFinished && scoreAlreadySame && hasFrozenPoints(match)) return null;

  match.status = "已结束";
  match.actual_score = actual;
  match.espn_id = event.espn_id;

  const pts = calculateMatchPoints(match);
  match.manual_points = {
    ray: pts.ray,
    gpt: pts.gpt,
    explanation: pts.explanation
  };
  match.review = buildReview(match, pts);

  return {
    id: match.id || matchKey(match.home, match.away),
    home: match.home,
    away: match.away,
    score: `${actual.home_score}:${actual.away_score}`,
    ray: pts.ray,
    gpt: pts.gpt
  };
}

function snapshotDayPoints(data) {
  const map = new Map();
  for (const day of data.matchdays || []) {
    map.set(day.date, { ray: Number(day.ray_points || 0), gpt: Number(day.gpt_points || 0) });
  }
  return map;
}

function sumMatchPoints(matches) {
  let ray = 0;
  let gpt = 0;
  for (const match of matches || []) {
    if (!hasFrozenPoints(match)) continue;
    ray += Number(match.manual_points.ray || 0);
    gpt += Number(match.manual_points.gpt || 0);
  }
  return { ray, gpt };
}

function recomputeTouchedDayPoints(data, touchedDayDates) {
  for (const day of data.matchdays || []) {
    if (!touchedDayDates.has(day.date)) continue;
    if (!Array.isArray(day.matches) || day.matches.length === 0) continue;
    const pts = sumMatchPoints(day.matches);
    day.ray_points = pts.ray;
    day.gpt_points = pts.gpt;
  }
}

function recomputeTotalsFromDayPoints(data) {
  let ray = 0;
  let gpt = 0;
  for (const day of data.matchdays || []) {
    ray += Number(day.ray_points || 0);
    gpt += Number(day.gpt_points || 0);
  }
  data.score_summary = data.score_summary || {};
  data.score_summary.ray_total = ray;
  data.score_summary.gpt_total = gpt;
  data.score_summary.leader_comment = ray === gpt
    ? `Ray 与 GPT 5.5 暂时 ${ray}:${gpt} 战平。`
    : ray > gpt
      ? `Ray 暂时 ${ray}:${gpt} 领先 GPT 5.5。`
      : `GPT 5.5 暂时 ${gpt}:${ray} 领先 Ray。`;
  return { ray, gpt };
}

function appendUpdateLog(data, updates) {
  if (!SHOULD_UPDATE_LOG || !updates.length) return;
  data.update_log = Array.isArray(data.update_log) ? data.update_log : [];
  for (const u of updates) {
    const text = `赛果更新：${u.home} ${u.score} ${u.away}，Ray +${u.ray}，GPT +${u.gpt}。`;
    if (!data.update_log.some(item => item.text === text)) {
      data.update_log.push({ time: shortBJT(new Date()).replace(" BJT", ""), text });
    }
  }
  if (Number.isFinite(UPDATE_LOG_LIMIT) && UPDATE_LOG_LIMIT > 0 && data.update_log.length > UPDATE_LOG_LIMIT) {
    data.update_log = data.update_log.slice(-UPDATE_LOG_LIMIT);
  }
}

function matchHasScore(match) {
  const actual = match?.actual_score || {};
  return actual.home_score !== null && actual.home_score !== undefined && actual.away_score !== null && actual.away_score !== undefined;
}

function matchScoreText(match) {
  const actual = match.actual_score || {};
  return `${match.home} ${actual.home_score}:${actual.away_score} ${match.away}`;
}

function compactScores(matches, limit = 6) {
  const items = matches.slice(0, limit).map(matchScoreText);
  const more = matches.length > limit ? `；另 ${matches.length - limit} 场` : "";
  return items.join("；") + more;
}

function dayByDate(data, date) {
  return (data.matchdays || []).find(day => day.date === date) || null;
}

function latestTouchedDay(data, touchedDayDates) {
  const dates = [...touchedDayDates].sort();
  for (let i = dates.length - 1; i >= 0; i -= 1) {
    const day = dayByDate(data, dates[i]);
    if (day) return day;
  }
  const active = data.meta?.active_day ? dayByDate(data, data.meta.active_day) : null;
  if (active) return active;
  const days = (data.matchdays || []).filter(day => Array.isArray(day.matches) && day.matches.length);
  return days.length ? days[days.length - 1] : null;
}

function refreshMatchdayCopy(day) {
  if (!day || !Array.isArray(day.matches) || !day.matches.length) return;

  const completed = day.matches.filter(matchHasScore);
  const pending = day.matches.filter(match => !matchHasScore(match));
  const ray = Number(day.ray_points || 0);
  const gpt = Number(day.gpt_points || 0);

  if (!completed.length) {
    day.title = `${day.date} 赛前预测：${day.matches.length} 场待赛`;
    day.summary = `今日比赛尚未结束，预测已经录入，等待赛果更新。`;
    return;
  }

  const scoreSummary = compactScores(completed);
  if (pending.length === 0) {
    day.title = `本日收官：Ray ${ray}:${gpt} GPT 5.5`;
    day.summary = `${scoreSummary}。本日合计 Ray ${ray}:${gpt} GPT 5.5。`;
  } else {
    day.title = `${completed.length}/${day.matches.length} 场已结束：Ray ${ray}:${gpt} GPT 5.5`;
    day.summary = `已结束 ${completed.length}/${day.matches.length} 场：${scoreSummary}。当前本日 Ray ${ray}:${gpt} GPT 5.5；待赛：${pending.map(m => `${m.home}—${m.away}`).join("、")}。`;
  }
}

function refreshHeadline(data, updates, totals, touchedDayDates = new Set()) {
  if (!updates.length) return;

  const day = latestTouchedDay(data, touchedDayDates);
  if (day) {
    refreshMatchdayCopy(day);
    data.headline = `总分 Ray ${totals.ray}:${totals.gpt} GPT 5.5：${day.title}`;
    data.brief = day.summary || `今日赛果已更新。`;
    return;
  }

  const last = updates[updates.length - 1];
  data.headline = `总分 Ray ${totals.ray}:${totals.gpt} GPT 5.5：${last.home} ${last.score} ${last.away} 已更新。`;
  data.brief = `今日赛果已更新，累计总分按历史日积分汇总。`;
}

function ensureMeta(data) {
  data.meta = data.meta || {};
  data.meta.updated_at = formatBJT(new Date());
  data.meta.version = `auto-score-safe-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 12)}`;
}

function validateNoBadPublicPhrases(data) {
  const text = JSON.stringify(data);
  const banned = ["自动简写版", "本场采用人工裁定", "人工裁定", "人工约定"];
  const found = banned.filter(x => text.includes(x));
  if (found.length) throw new Error(`Refusing to write public data with banned phrase(s): ${found.join(", ")}`);
}

function validateDayPointMutation(before, afterData, touchedDayDates) {
  for (const day of afterData.matchdays || []) {
    const old = before.get(day.date);
    if (!old) continue;
    if (touchedDayDates.has(day.date)) continue;
    const now = { ray: Number(day.ray_points || 0), gpt: Number(day.gpt_points || 0) };
    if (old.ray !== now.ray || old.gpt !== now.gpt) {
      throw new Error(`Refusing to mutate historical day ${day.date}: ${old.ray}:${old.gpt} -> ${now.ray}:${now.gpt}`);
    }
  }
}

function validateNoTotalCollapse(oldTotals, newTotals) {
  // Match points are nonnegative, so an automatic update should never reduce cumulative totals.
  // If you need a deliberate manual repair, edit data.json directly or run a one-off repair script.
  if (newTotals.ray < oldTotals.ray || newTotals.gpt < oldTotals.gpt) {
    throw new Error(`Refusing total decrease: Ray ${oldTotals.ray}->${newTotals.ray}, GPT ${oldTotals.gpt}->${newTotals.gpt}`);
  }
}

function totalsFromDayPoints(data) {
  let ray = 0;
  let gpt = 0;
  for (const day of data.matchdays || []) {
    ray += Number(day.ray_points || 0);
    gpt += Number(day.gpt_points || 0);
  }
  return { ray, gpt };
}

async function main() {
  const dataFile = path.resolve(DATA_PATH);
  const originalText = fs.readFileSync(dataFile, "utf8");
  const data = JSON.parse(originalText);
  const beforeDayPoints = snapshotDayPoints(data);
  const oldTotals = totalsFromDayPoints(data);

  const scoreboard = await loadScoreboard();
  const events = (scoreboard.events || [])
    .map(normalizeEvent)
    .filter(e => e.completed && e.home_score !== null && e.away_score !== null);
  const eventByKey = buildEventIndex(events);

  const updatesById = new Map();
  const touchedDayDates = new Set();
  const unmatched = [];

  for (const { match, location, dayDate } of collectMatchRefs(data)) {
    if (isFinished(match) && hasFrozenPoints(match) && !ALLOW_REWRITE_FINISHED) continue;
    const event = eventByKey.get(matchKey(match.home, match.away));
    if (!event) {
      if (!isFinished(match)) unmatched.push(`${match.home}-${match.away}`);
      continue;
    }
    const update = updateOneMatch(match, event);
    if (update) {
      update.dayDate = dayDate || null;
      updatesById.set(update.id, update);
      if (dayDate) touchedDayDates.add(dayDate);
    }
  }

  const updates = [...updatesById.values()];
  if (!updates.length) {
    console.log("No completed matches to update.");
    if (unmatched.length) console.error(`Unmatched unfinished match(es): ${unmatched.join("; ")}`);
    return;
  }

  recomputeTouchedDayPoints(data, touchedDayDates);
  const totals = recomputeTotalsFromDayPoints(data);
  appendUpdateLog(data, updates);
  refreshHeadline(data, updates, totals, touchedDayDates);
  ensureMeta(data);

  validateDayPointMutation(beforeDayPoints, data, touchedDayDates);
  validateNoTotalCollapse(oldTotals, totals);
  validateNoBadPublicPhrases(data);

  const out = JSON.stringify(data, null, 2) + "\n";
  if (DRY_RUN) {
    console.log(out);
    console.error(`Dry run: ${updates.length} match(es) would be updated: ${updates.map(u => `${u.home} ${u.score} ${u.away}`).join("; ")}`);
  } else {
    const backupFile = `${dataFile}.bak-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 12)}`;
    fs.writeFileSync(backupFile, originalText, "utf8");
    fs.writeFileSync(dataFile, out, "utf8");
    console.log(`Updated ${updates.length} completed match(es): ${updates.map(u => `${u.home} ${u.score} ${u.away}`).join("; ")}`);
    console.log(`Backup written: ${backupFile}`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
