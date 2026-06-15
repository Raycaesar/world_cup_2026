#!/usr/bin/env node
/*
  Auto-update World Cup results in data.json from ESPN's scoreboard feed.

  Usage:
    node scripts/update_scores.js
    node scripts/update_scores.js --dry-run

  Optional env:
    DATA_PATH=data.json
    SCOREBOARD_FIXTURE=/path/to/espn-scoreboard.json   # local test fixture
    UPDATE_LOG_LIMIT=10
    NO_UPDATE_LOG=1
*/

const fs = require("node:fs");
const path = require("node:path");

const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const BJT_TIME_ZONE = "Asia/Shanghai";
const DATA_PATH = process.env.DATA_PATH || "data.json";
const DRY_RUN = process.argv.includes("--dry-run");
const UPDATE_LOG_LIMIT = Number(process.env.UPDATE_LOG_LIMIT || 10);
const SHOULD_UPDATE_LOG = process.env.NO_UPDATE_LOG !== "1";

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
  "韩国": "韩国",
  "南韩": "韩国",
  "美国队": "美国",
  "刚果民主共和国": "刚果（金）",
  "刚果（金）": "刚果（金）",
  "佛得角群岛": "佛得角",
  "库拉çao": "库拉索"
};

function normalizeName(name) {
  const raw = String(name || "").trim();
  return NAME_ALIASES[raw] || TEAM_ZH[raw] || raw;
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
    home_score: pred.home_score,
    away_score: pred.away_score,
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

function resultCloseness(predOutcome, actualOutcome) {
  if (predOutcome === actualOutcome) return 2;
  if (predOutcome === "draw" && actualOutcome !== "draw") return 1;
  if (predOutcome !== "draw" && actualOutcome === "draw") return 1;
  return 0;
}

function calculateMatchPoints(match) {
  const actual = match.actual_score;
  if (!actual || actual.home_score === null || actual.away_score === null) {
    return { ray: 0, gpt: 0, explanation: "比赛尚未结束，暂不计分。" };
  }

  const ray = parsePrediction(match.ray_prediction);
  const gpt = parsePrediction(match.gpt_prediction);
  const actualOutcome = pickOutcome(actual.home_score, actual.away_score);
  const rayCorrect = ray.outcome === actualOutcome;
  const gptCorrect = gpt.outcome === actualOutcome;
  const rayExact = exactScore(match.ray_prediction, actual);
  const gptExact = exactScore(match.gpt_prediction, actual);

  if (samePrediction(match.ray_prediction, match.gpt_prediction)) {
    return { ray: 0, gpt: 0, explanation: "双方预测完全相同，本场不计分。" };
  }

  let rayPts = 0;
  let gptPts = 0;
  let explanation = "";

  if (rayCorrect && !gptCorrect) {
    rayPts = 3 + (rayExact ? 1 : 0);
    explanation = rayExact ? "Ray 猜对胜平负且比分完全命中，得到 4 分。" : "Ray 猜对胜平负，得到 3 分。";
  } else if (!rayCorrect && gptCorrect) {
    gptPts = 3 + (gptExact ? 1 : 0);
    explanation = gptExact ? "GPT 猜对胜平负且比分完全命中，得到 4 分。" : "GPT 猜对胜平负，得到 3 分。";
  } else if (rayCorrect && gptCorrect) {
    // 双方都猜中胜平负时，胜平负本身不拉开差距；只奖励精确比分的一方 1 分。
    if (rayExact && !gptExact) {
      rayPts = 1;
      explanation = "双方都猜对胜平负，胜平负不计分；Ray 比分完全命中，得到 1 分。";
    } else if (!rayExact && gptExact) {
      gptPts = 1;
      explanation = "双方都猜对胜平负，胜平负不计分；GPT 比分完全命中，得到 1 分。";
    } else {
      explanation = "双方都猜对胜平负，但没有形成比分命中差异，本场不计分。";
    }
  } else {
    // 双方都猜错时，只比较“胜/平/负方向”的接近程度；
    // 不再用具体比分误差打破平局，避免出现“双方都押同一方向失败，但因数字更近而加分”的争议。
    const rayClose = resultCloseness(ray.outcome, actualOutcome);
    const gptClose = resultCloseness(gpt.outcome, actualOutcome);
    if (rayClose > gptClose) {
      rayPts = 1;
      explanation = "双方都猜错，但 Ray 的胜平负方向更接近真实赛果，得到 1 分。";
    } else if (gptClose > rayClose) {
      gptPts = 1;
      explanation = "双方都猜错，但 GPT 的胜平负方向更接近真实赛果，得到 1 分。";
    } else {
      explanation = "双方都猜错，且胜平负方向没有形成差异，本场不计分。";
    }
  }

  return { ray: rayPts, gpt: gptPts, explanation };
}

function predictionText(pred) {
  if (!pred || pred.home_score === null || pred.home_score === undefined || pred.away_score === null || pred.away_score === undefined) return "未明确预测";
  return `${pred.home_score}:${pred.away_score}`;
}

function matchKey(home, away) {
  return `${normalizeName(home)}__${normalizeName(away)}`;
}

function collectMatchRefs(data) {
  const refs = [];
  const seen = new Set();

  function add(match, location) {
    if (!match || !match.home || !match.away) return;
    const refId = `${location}:${match.id || match.home + "-" + match.away}`;
    if (seen.has(refId)) return;
    seen.add(refId);
    refs.push({ match, location });
  }

  (data.today_matches || []).forEach(m => add(m, "today"));
  (data.matchdays || []).forEach(day => (day.matches || []).forEach(m => add(m, `day:${day.date}`)));
  return refs;
}

function isFinished(match) {
  const actual = match.actual_score || {};
  return actual.home_score !== null && actual.home_score !== undefined && actual.away_score !== null && actual.away_score !== undefined && String(match.status || "").includes("已结束");
}

function buildReview(match, pts) {
  const actual = match.actual_score || {};
  return `${match.home} ${actual.home_score}:${actual.away_score} ${match.away}。赛果已自动录入；Ray 预测 ${predictionText(match.ray_prediction)}，GPT 预测 ${predictionText(match.gpt_prediction)}。${pts.explanation} 本场得分：Ray +${pts.ray}，GPT +${pts.gpt}。`;
}

function updateOneMatch(match, event) {
  const actual = { home_score: event.home_score, away_score: event.away_score };
  const oldActual = match.actual_score || {};
  const changedScore = oldActual.home_score !== actual.home_score || oldActual.away_score !== actual.away_score;
  const needsStatus = String(match.status || "") !== "已结束";

  if (!changedScore && !needsStatus && isFinished(match)) return null;

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

function recomputeDayPoints(data) {
  (data.matchdays || []).forEach(day => {
    let ray = 0;
    let gpt = 0;
    (day.matches || []).forEach(match => {
      const pts = match.manual_points ? { ray: Number(match.manual_points.ray || 0), gpt: Number(match.manual_points.gpt || 0) } : calculateMatchPoints(match);
      ray += pts.ray;
      gpt += pts.gpt;
    });
    day.ray_points = ray;
    day.gpt_points = gpt;
  });
}

function recomputeTotals(data) {
  let ray = 0;
  let gpt = 0;
  const counted = new Set();
  (data.matchdays || []).forEach(day => (day.matches || []).forEach(match => {
    const key = match.id || `${day.date}:${matchKey(match.home, match.away)}`;
    if (counted.has(key)) return;
    counted.add(key);
    const pts = match.manual_points ? { ray: Number(match.manual_points.ray || 0), gpt: Number(match.manual_points.gpt || 0) } : calculateMatchPoints(match);
    ray += pts.ray;
    gpt += pts.gpt;
  }));
  data.score_summary = data.score_summary || {};
  data.score_summary.ray_total = ray;
  data.score_summary.gpt_total = gpt;
  const leader = ray === gpt ? "Ray 与 GPT 5.5 暂时战平。" : ray > gpt ? `Ray 暂时 ${ray}:${gpt} 领先 GPT 5.5。` : `GPT 5.5 暂时 ${gpt}:${ray} 领先 Ray。`;
  data.score_summary.leader_comment = leader;
  return { ray, gpt };
}

function appendUpdateLog(data, updates) {
  if (!SHOULD_UPDATE_LOG || !updates.length) return;
  data.update_log = Array.isArray(data.update_log) ? data.update_log : [];
  for (const u of updates) {
    const text = `自动更新：${u.home} ${u.score} ${u.away}，Ray +${u.ray}，GPT +${u.gpt}。`;
    if (!data.update_log.some(item => item.text === text)) {
      data.update_log.push({ time: shortBJT(new Date()).replace(" BJT", ""), text });
    }
  }
  if (Number.isFinite(UPDATE_LOG_LIMIT) && UPDATE_LOG_LIMIT > 0 && data.update_log.length > UPDATE_LOG_LIMIT) {
    data.update_log = data.update_log.slice(-UPDATE_LOG_LIMIT);
  }
}

function refreshHeadline(data, updates, totals) {
  if (!updates.length) return;
  const last = updates[updates.length - 1];
  data.headline = `总分 Ray ${totals.ray}:${totals.gpt} GPT 5.5：${last.home} ${last.score} ${last.away} 已自动更新。`;
  data.brief = `本场复盘为自动简写版，只记录赛果、预测与计分；详细评论可稍后手动补充。`;
}

function ensureMeta(data) {
  data.meta = data.meta || {};
  data.meta.updated_at = formatBJT(new Date());
  data.meta.version = `auto-score-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 12)}`;
}

async function main() {
  const dataFile = path.resolve(DATA_PATH);
  const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  const scoreboard = await loadScoreboard();
  const events = (scoreboard.events || []).map(normalizeEvent).filter(e => e.completed && e.home_score !== null && e.away_score !== null);
  const eventByKey = new Map(events.map(e => [matchKey(e.home, e.away), e]));
  const updatesById = new Map();

  for (const { match } of collectMatchRefs(data)) {
    const event = eventByKey.get(matchKey(match.home, match.away));
    if (!event) continue;
    const update = updateOneMatch(match, event);
    if (update) updatesById.set(update.id, update);
  }

  const updates = [...updatesById.values()];
  if (!updates.length) {
    console.log("No completed matches to update.");
    return;
  }

  recomputeDayPoints(data);
  const totals = recomputeTotals(data);
  appendUpdateLog(data, updates);
  refreshHeadline(data, updates, totals);
  ensureMeta(data);

  const out = JSON.stringify(data, null, 2) + "\n";
  if (DRY_RUN) {
    console.log(out);
    console.error(`Dry run: ${updates.length} match(es) would be updated.`);
  } else {
    fs.writeFileSync(dataFile, out, "utf8");
    console.log(`Updated ${updates.length} completed match(es): ${updates.map(u => `${u.home} ${u.score} ${u.away}`).join("; ")}`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
