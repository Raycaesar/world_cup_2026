#!/usr/bin/env node
/*
  Safe auto-update knockout match results in data.json from ESPN scoreboard.
  Handles 90 minutes, extra time, penalty shootouts, and top-scorer updates.
  Extra-time/penalty matches are not silently treated as complete when the
  90-minute score is missing: the script first reconstructs it from ESPN
  summary/scoring plays; if that still fails, score-bonus settlement remains
  provisional and visibly marked for follow-up.
*/
const fs = require("node:fs");
const path = require("node:path");

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world";
const ESPN_SCOREBOARD = `${ESPN_BASE}/scoreboard`;
const ESPN_SUMMARY = `${ESPN_BASE}/summary`;
const DATA_PATH = process.env.DATA_PATH || "data.json";
const UPDATE_LOG_LIMIT = Number(process.env.UPDATE_LOG_LIMIT || 24);
const UPDATE_TOP_SCORERS = process.env.UPDATE_TOP_SCORERS !== "0";
const TOP_SCORERS_LIMIT = Math.max(8, Number(process.env.TOP_SCORERS_LIMIT || 12));
const SCORER_CATCHUP = process.env.SCORER_CATCHUP === "1";
const SCORER_CATCHUP_FROM = process.env.SCORER_CATCHUP_FROM || "";
const BJT_TIME_ZONE = "Asia/Shanghai";

const TEAM_ZH = {
  "South Africa":"南非", "Canada":"加拿大", "Brazil":"巴西", "Japan":"日本", "Germany":"德国", "Paraguay":"巴拉圭",
  "Netherlands":"荷兰", "Morocco":"摩洛哥", "Curacao":"库拉索", "Curaçao":"库拉索", "Ivory Coast":"科特迪瓦", "Côte d'Ivoire":"科特迪瓦", "Norway":"挪威",
  "France":"法国", "Sweden":"瑞典", "Mexico":"墨西哥", "Ecuador":"厄瓜多尔", "England":"英格兰", "DR Congo":"刚果（金）",
  "Congo DR":"刚果（金）", "Belgium":"比利时", "Senegal":"塞内加尔", "United States":"美国", "USA":"美国",
  "Bosnia and Herzegovina":"波黑", "Bosnia-Herzegovina":"波黑", "Spain":"西班牙", "Austria":"奥地利", "Portugal":"葡萄牙",
  "Croatia":"克罗地亚", "Switzerland":"瑞士", "Algeria":"阿尔及利亚", "Australia":"澳大利亚", "Egypt":"埃及",
  "Argentina":"阿根廷", "Cape Verde":"佛得角", "Cabo Verde":"佛得角", "Colombia":"哥伦比亚", "Ghana":"加纳",
  "Saudi Arabia":"沙特", "Uruguay":"乌拉圭", "Iran":"伊朗", "IR Iran":"伊朗", "New Zealand":"新西兰", "Iraq":"伊拉克", "Jordan":"约旦", "Tunisia":"突尼斯"
};

function normalizeName(name) { const raw = String(name || "").trim(); return TEAM_ZH[raw] || raw; }
function matchKey(home, away) { return `${normalizeName(home)}__${normalizeName(away)}`; }
function ymdUTC(date) { return `${date.getUTCFullYear()}${String(date.getUTCMonth()+1).padStart(2,"0")}${String(date.getUTCDate()).padStart(2,"0")}`; }
function formatParts(dateLike) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: BJT_TIME_ZONE, year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false }).formatToParts(date);
  const get = t => parts.find(p => p.type === t)?.value || "";
  return { year:get("year"), month:get("month"), day:get("day"), hour:get("hour"), minute:get("minute") };
}
function shortBJT(dateLike) { const p = formatParts(dateLike); return `${p.month}-${p.day} ${p.hour}:${p.minute} BJT`; }
function formatBJT(dateLike) { const p = formatParts(dateLike); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} BJT`; }
function teamName(competitor) { return normalizeName(competitor?.team?.displayName || competitor?.team?.name || competitor?.team?.shortDisplayName || ""); }
function numberOrNull(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function scoreComplete(score) { return score && score.home_score !== null && score.home_score !== undefined && score.away_score !== null && score.away_score !== undefined; }
function makeScore(home, away) { return { home_score: home, away_score: away }; }
function sameScore(a, b) { return scoreComplete(a) && scoreComplete(b) && a.home_score === b.home_score && a.away_score === b.away_score; }
function normalizeTextKey(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}
function parseBjDateTime(value) {
  const m = String(value || "").match(/(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return Number.NaN;
  return Date.UTC(2026, Number(m[1]) - 1, Number(m[2]), Number(m[3]) - 8, Number(m[4]));
}
function catchupCutoffMs() {
  if (!SCORER_CATCHUP_FROM) return Number.NaN;
  const m = String(SCORER_CATCHUP_FROM).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), -8, 0);
}

function readShootoutScore(competitor) {
  const candidates = [competitor?.shootoutScore, competitor?.shootout_score, competitor?.curatedRank?.shootoutScore, competitor?.curatedRank?.shootout_score];
  for (const c of candidates) {
    const n = numberOrNull(c);
    if (n !== null) return n;
  }
  return null;
}
function lineValues(competitor) {
  return (competitor?.linescores || []).map(x => numberOrNull(x?.value ?? x?.displayValue)).filter(x => x !== null);
}
function sumFirst(values, n) {
  if (!values || values.length < n) return null;
  return values.slice(0, n).reduce((s, x) => s + x, 0);
}
function readRegulationScore(home, away) {
  const hv = lineValues(home), av = lineValues(away);
  const hs = sumFirst(hv, 2), as = sumFirst(av, 2);
  return hs === null || as === null ? null : makeScore(hs, as);
}
function statusText(competition, event) {
  return [competition.status?.type?.detail, competition.status?.type?.shortDetail, competition.status?.type?.name, event.status?.type?.detail, event.status?.type?.shortDetail, event.status?.type?.name].filter(Boolean).join(" ");
}
function inferMethod(competition, event, home, away) {
  const status = statusText(competition, event).toLowerCase();
  const hp = readShootoutScore(home), ap = readShootoutScore(away);
  if (status.includes("pen") || hp !== null || ap !== null) return "penalties";
  if (status.includes("aet") || status.includes("extra")) return "extra_time";
  const hv = lineValues(home), av = lineValues(away);
  if (hv.length > 2 || av.length > 2) return "extra_time";
  return "90";
}
function winnerFromScores(homeScore, awayScore, homeTeam, awayTeam) {
  if (homeScore > awayScore) return homeTeam;
  if (awayScore > homeScore) return awayTeam;
  return null;
}
function normalizeEvent(event) {
  const competition = event.competitions?.[0] || {};
  const competitors = competition.competitors || [];
  const home = competitors.find(c => c.homeAway === "home") || competitors[0] || {};
  const away = competitors.find(c => c.homeAway === "away") || competitors[1] || {};
  const statusType = competition.status?.type || event.status?.type || {};
  const completed = statusType.state === "post" || statusType.completed === true;
  const method = inferMethod(competition, event, home, away);
  const homeTeam = teamName(home), awayTeam = teamName(away);
  const final = makeScore(numberOrNull(home.score), numberOrNull(away.score));
  const penalties = makeScore(readShootoutScore(home), readShootoutScore(away));
  const regulation = readRegulationScore(home, away);
  let advancing = null;
  if (method === "penalties" && scoreComplete(penalties)) advancing = winnerFromScores(penalties.home_score, penalties.away_score, homeTeam, awayTeam);
  if (!advancing && scoreComplete(final)) advancing = winnerFromScores(final.home_score, final.away_score, homeTeam, awayTeam);
  if (!advancing) {
    const markedWinner = competitors.find(c => c.winner === true);
    if (markedWinner) advancing = teamName(markedWinner);
  }
  return {
    raw: event,
    espn_id: String(event.id || ""), completed, home: homeTeam, away: awayTeam,
    final_score: final, regulation_score: regulation,
    extra_time_score: method === "extra_time" || method === "penalties" ? final : null,
    penalties_score: scoreComplete(penalties) ? penalties : null,
    advancing_team: advancing,
    method,
    kickoff_bjt: shortBJT(event.date),
    status_text: statusText(competition, event),
    goal_events: []
  };
}

async function loadScoreboard() {
  if (process.env.SCOREBOARD_FIXTURE) return JSON.parse(fs.readFileSync(path.resolve(process.env.SCOREBOARD_FIXTURE), "utf8"));
  const now = new Date();
  const start = new Date(now.getTime() - 72*60*60*1000);
  const end = new Date(now.getTime() + 96*60*60*1000);
  const url = `${ESPN_SCOREBOARD}?limit=100&dates=${ymdUTC(start)}-${ymdUTC(end)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`ESPN scoreboard failed: ${res.status}`);
  return res.json();
}
async function loadEventSummary(eventId) {
  if (!eventId) return null;
  if (process.env.SUMMARY_FIXTURE_DIR) {
    const file = path.join(path.resolve(process.env.SUMMARY_FIXTURE_DIR), `${eventId}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  const url = `${ESPN_SUMMARY}?event=${encodeURIComponent(eventId)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    console.warn(`ESPN summary unavailable for ${eventId}: ${res.status}`);
    return null;
  }
  return res.json();
}

function walkArrays(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    if (value.some(x => x && typeof x === "object" && (x.text || x.type || x.team || x.athletes || x.participants || x.clock || x.period))) out.push(value);
    for (const x of value) walkArrays(x, out);
  } else {
    for (const x of Object.values(value)) walkArrays(x, out);
  }
  return out;
}
function possibleScoringItems(summary) {
  const roots = [summary?.scoringPlays, summary?.plays, summary?.details, summary?.header?.competitions?.[0]?.details].filter(Boolean);
  const arrays = roots.flatMap(root => Array.isArray(root) ? [root] : walkArrays(root));
  return arrays.flat().filter(x => x && typeof x === "object");
}
function scoringText(item) {
  return [item.text, item.shortText, item.displayText, item.type?.text, item.type?.description, item.scoringType?.displayName, item.scoringType?.name].filter(Boolean).join(" ");
}
function isShootoutItem(item) { return /shootout|penalty shootout|点球大战/i.test(scoringText(item)); }
function isOwnGoalItem(item) { return /own goal|autogol|\bog\b|乌龙/i.test(scoringText(item)); }
function isTeamGoalItem(item) {
  if (isShootoutItem(item)) return false;
  const text = scoringText(item).toLowerCase();
  if (/goal|penalty - scored|penalty scored|scored/i.test(text)) return true;
  const scoreValue = numberOrNull(item.scoreValue ?? item.scoringPlay?.scoreValue);
  return scoreValue === 1 && !!(item.team || item.athletes || item.participants || item.scorer);
}
function isPlayerGoalItem(item) { return isTeamGoalItem(item) && !isOwnGoalItem(item); }
function itemPeriodNumber(item) {
  const n = numberOrNull(item.period?.number ?? item.period ?? item.periodNumber);
  return n;
}
function parseMinuteFromText(value) {
  const text = String(value || "");
  const m = text.match(/(\d{1,3})(?:\s*[+'’]\s*(\d{1,2}))?/);
  if (!m) return null;
  const base = Number(m[1]);
  return Number.isFinite(base) ? base : null;
}
function itemMinute(item) {
  return parseMinuteFromText(item.clock?.displayValue || item.time?.displayValue || item.displayClock || item.clock || scoringText(item));
}
function isRegulationGoal(item) {
  const period = itemPeriodNumber(item);
  if (period !== null) return period <= 2;
  const minute = itemMinute(item);
  if (minute !== null) return minute <= 90;
  return true;
}
function normalizeTeamObject(team) { return normalizeName(team?.displayName || team?.name || team?.shortDisplayName || team?.abbreviation || ""); }
function itemTeamName(item) {
  return normalizeTeamObject(item.team) || normalizeTeamObject(item.competitor?.team) || normalizeTeamObject(item.scoringPlay?.team);
}
function sideForItem(item, event) {
  const t = itemTeamName(item);
  if (t && normalizeTextKey(t) === normalizeTextKey(event.home)) return "home";
  if (t && normalizeTextKey(t) === normalizeTextKey(event.away)) return "away";
  const text = scoringText(item);
  if (normalizeTextKey(text).includes(normalizeTextKey(event.home))) return "home";
  if (normalizeTextKey(text).includes(normalizeTextKey(event.away))) return "away";
  return null;
}
function readRegulationFromSummaryLines(summary, event) {
  const comp = summary?.header?.competitions?.[0] || summary?.boxscore?.teams?.[0]?.competition || {};
  const competitors = comp?.competitors || [];
  const home = competitors.find(c => c.homeAway === "home") || competitors.find(c => teamName(c) === event.home);
  const away = competitors.find(c => c.homeAway === "away") || competitors.find(c => teamName(c) === event.away);
  return home && away ? readRegulationScore(home, away) : null;
}
function readRegulationFromSummaryScoring(summary, event) {
  if (!summary) return null;
  let home = 0, away = 0, found = false;
  for (const item of possibleScoringItems(summary)) {
    if (!isTeamGoalItem(item) || !isRegulationGoal(item)) continue;
    const side = sideForItem(item, event);
    if (side === "home") { home += 1; found = true; }
    if (side === "away") { away += 1; found = true; }
  }
  return found ? makeScore(home, away) : null;
}
function athleteName(a) {
  return a?.displayName || a?.fullName || a?.shortName || a?.name || a?.athlete?.displayName || a?.athlete?.fullName || "";
}
function candidateAthletes(item) {
  const result = [];
  const push = a => { if (a && typeof a === "object") result.push(a.athlete || a); };
  push(item.scorer);
  push(item.athlete);
  (item.athletes || []).forEach(push);
  (item.participants || []).forEach(push);
  (item.competitors || []).forEach(push);
  return result;
}
function extractGoalEvents(summary, event) {
  if (!summary) return [];
  const goals = [];
  const seen = new Set();
  for (const item of possibleScoringItems(summary)) {
    if (!isPlayerGoalItem(item)) continue;
    const side = sideForItem(item, event);
    const team = side === "home" ? event.home : side === "away" ? event.away : itemTeamName(item);
    const athletes = candidateAthletes(item);
    const player = athletes.map(athleteName).find(Boolean) || "";
    if (!player || !team) continue;
    const minute = itemMinute(item);
    const period = itemPeriodNumber(item);
    const key = [normalizeTextKey(player), normalizeTextKey(team), period ?? "", minute ?? "", normalizeTextKey(scoringText(item)).slice(0, 80)].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    goals.push({ player, team, minute, period, text: scoringText(item) });
  }
  return goals;
}
function enrichEventFromSummary(event, summary) {
  if (!summary) return event;
  if (!scoreComplete(event.regulation_score)) {
    const reg = readRegulationFromSummaryLines(summary, event) || readRegulationFromSummaryScoring(summary, event);
    if (scoreComplete(reg)) event.regulation_score = reg;
  }
  event.goal_events = extractGoalEvents(summary, event);
  return event;
}

function actualFinished(match) {
  return !!(match.actual && match.actual.advancing_team && scoreComplete(match.actual.final_score));
}

function needsRegulationScore(method) {
  return method === "extra_time" || method === "penalties";
}

function needsRegulationRepair(match) {
  const actual = match.actual || {};
  return actualFinished(match) && needsRegulationScore(actual.method) && !scoreComplete(actual.regulation_score);
}

function fullyPointSettled(match) {
  return actualFinished(match)
    && !!match.manual_points
    && !match.manual_points.provisional
    && !needsRegulationRepair(match);
}

function methodLabel(method) { return method === "90" ? "90分钟" : method === "extra_time" || method === "extra" ? "加时" : method === "penalties" ? "点球" : "未定"; }
function scoreLabel(score) { return scoreComplete(score) ? `${score.home_score}:${score.away_score}` : "—"; }
function predictionDetailPoints(pred, actual) {
  const predMethod = pred?.method === "extra" ? "extra_time" : pred?.method;
  const actualMethod = actual?.method === "extra" ? "extra_time" : actual?.method;
  if (!predMethod || !actualMethod || predMethod !== actualMethod) return 0;
  let pts = 1;
  const ps = pred.regulation_score || {};
  const as = actual.regulation_score || {};
  if (scoreComplete(ps) && scoreComplete(as) && ps.home_score === as.home_score && ps.away_score === as.away_score) pts += 1;
  return pts;
}
function calculateKnockoutPoints(match) {
  const actual = match.actual || {};
  if (!actual.advancing_team) return null;
  const r = match.ray_prediction || {}, g = match.gpt_prediction || {};
  const rayWin = r.advancing_team === actual.advancing_team;
  const gptWin = g.advancing_team === actual.advancing_team;
  const rayDetail = rayWin ? predictionDetailPoints(r, actual) : 0;
  const gptDetail = gptWin ? predictionDetailPoints(g, actual) : 0;
  if (rayWin && !gptWin) {
    const ray = 3 + rayDetail;
    return { ray, gpt: 0, explanation: `Ray 猜中晋级队，GPT 未猜中；晋级队 +3，路径与比分加分 +${rayDetail}，Ray +${ray}。` };
  }
  if (!rayWin && gptWin) {
    const gpt = 3 + gptDetail;
    return { ray: 0, gpt, explanation: `GPT 猜中晋级队，Ray 未猜中；晋级队 +3，路径与比分加分 +${gptDetail}，GPT +${gpt}。` };
  }
  if (!rayWin && !gptWin) return { ray: 0, gpt: 0, explanation: "双方都未猜中晋级队，本场不计分。" };
  return { ray: rayDetail, gpt: gptDetail, explanation: `双方都猜中晋级队；不重复给胜负分，只按晋级方式与90分钟比分计分：Ray +${rayDetail}，GPT +${gptDetail}。` };
}
function publicScore(match) {
  const a = match.actual || {};
  if (!scoreComplete(a.final_score)) return "—";
  let out = scoreLabel(a.final_score);
  if (a.method === "extra_time") out += "（加时）";
  if (a.method === "penalties" && scoreComplete(a.penalties_score)) out += `，点球 ${scoreLabel(a.penalties_score)}`;
  return out;
}

function nextMatchTextFromNote(note, winner) {
  const raw = String(note || "").trim();
  if (!raw || !/对阵/.test(raw)) return "";
  let m = raw.match(/(?:下一轮)?将?对阵(.+)$/);
  if (m) return `对阵${m[1]}`;
  m = raw.match(/^胜者对阵(.+)$/);
  if (m) return `对阵${m[1]}`;
  if (winner && raw.startsWith(winner)) {
    m = raw.match(/对阵(.+)$/);
    if (m) return `对阵${m[1]}`;
  }
  return raw;
}
function findBracketEntry(data, match) {
  return (data.bracket || []).find(b => String(b.id || "") === String(match.espn_id || "") || matchKey(b.home, b.away) === matchKey(match.home, match.away));
}
function updateBracket(data, match) {
  const b = findBracketEntry(data, match);
  if (!b || !match.actual) return;
  b.status = "已结束";
  b.winner = match.actual.advancing_team;
  b.method = match.actual.method;
  b.score_obj = match.actual.final_score;
  b.score = publicScore(match);
  if (scoreComplete(match.actual.regulation_score)) b.regulation_score = match.actual.regulation_score;
  if (scoreComplete(match.actual.penalties_score)) b.penalties_score = match.actual.penalties_score;
  const next = match.actual.next_match || (b.note && b.note.includes("对阵") ? b.note.replace(/^胜者/, match.actual.advancing_team) : "");
  b.note = next ? `${match.actual.advancing_team}通过${methodLabel(match.actual.method)}晋级，${next}` : `${match.actual.advancing_team}通过${methodLabel(match.actual.method)}晋级`;
}

function setActualRegulation(match, event) {
  const method = match.actual.method;
  const existing = match.actual.regulation_score;
  if (scoreComplete(existing)) return;
  if (scoreComplete(event.regulation_score)) match.actual.regulation_score = event.regulation_score;
  else if (method === "90" && scoreComplete(event.final_score)) match.actual.regulation_score = event.final_score;
  else if (needsRegulationScore(method)) match.actual.regulation_score = makeScore(null, null);
}
function reviewText(match, pts, provisionalReason) {
  const a = match.actual || {};
  const nextSentence = a.next_match
    ? (/^对阵/.test(String(a.next_match)) ? `下一轮将${a.next_match}。` : `${a.next_match}。`)
    : "";
  const methodPhrase = a.method === "penalties" && scoreComplete(a.penalties_score)
    ? `，点球大战 ${scoreLabel(a.penalties_score)}`
    : a.method === "extra_time"
      ? "，加时"
      : a.method === "penalties"
        ? "，点球大战"
        : "";
  const regPhrase = needsRegulationScore(a.method) && scoreComplete(a.regulation_score) ? `90分钟 ${scoreLabel(a.regulation_score)}，` : "";
  const provisional = provisionalReason ? `注意：${provisionalReason}` : "";
  return `${match.home} ${scoreLabel(a.final_score)} ${match.away}${methodPhrase}，${regPhrase}${a.advancing_team}晋级。${nextSentence}${pts ? pts.explanation : "本场计分待确认。"}${provisional}`;
}
function updateOneMatch(data, match, event) {
  if (fullyPointSettled(match)) return null;
  if (!scoreComplete(event.final_score)) return null;

  const oldManual = match.manual_points || null;
const oldRay = Number(oldManual?.ray || 0);
const oldGpt = Number(oldManual?.gpt || 0);
const wasActualFinished = actualFinished(match);
const oldActualText = JSON.stringify(match.actual || {});

  match.status = "已结束";
  match.espn_id = event.espn_id || match.espn_id;
  match.actual = match.actual || {};
  match.actual.method = event.method || match.actual.method || "90";
  match.actual.final_score = event.final_score;
  match.actual.advancing_team = event.advancing_team;
  setActualRegulation(match, event);
  if (scoreComplete(event.extra_time_score)) match.actual.extra_time_score = event.extra_time_score;
  if (scoreComplete(event.penalties_score)) match.actual.penalties_score = event.penalties_score;
  if (!wasActualFinished && UPDATE_TOP_SCORERS) match.actual.scorer_update_pending = true;

  if (!match.actual.advancing_team) {
    match.actual.settlement_status = "needs_advancing_team";
    match.review = `${match.home} ${scoreLabel(event.final_score)} ${match.away}。比赛已结束，但晋级队仍无法从 ESPN 数据确认；需要人工补充加时/点球信息。`;
    return { id: match.id, changed: true, needsManual: true, home: match.home, away: match.away, score: scoreLabel(event.final_score), ray: 0, gpt: 0 };
  }

  const b = findBracketEntry(data, match);
  if (b?.note && !match.actual.next_match) match.actual.next_match = nextMatchTextFromNote(b.note, match.actual.advancing_team);

  const missingRegulation = needsRegulationScore(match.actual.method) && !scoreComplete(match.actual.regulation_score);
  if (missingRegulation) match.actual.settlement_status = "provisional_missing_regulation_score";
  else delete match.actual.settlement_status;

  const pts = calculateKnockoutPoints(match);
  const provisionalReason = missingRegulation ? "本场进入加时/点球，但 ESPN 当前数据没有给出可确认的90分钟比分；晋级队与方式已先结算，准确90分钟比分加分暂不结算。" : "";
  if (pts) {
    match.manual_points = {
      ray: pts.ray,
      gpt: pts.gpt,
      explanation: provisionalReason ? `${pts.explanation}${provisionalReason}` : pts.explanation
    };
    if (missingRegulation) {
      match.manual_points.provisional = true;
      match.manual_points.pending_detail = "regulation_score";
    }
  }
  match.review = reviewText(match, pts, provisionalReason);
  updateBracket(data, match);

  const newRay = Number(match.manual_points?.ray || 0);
  const newGpt = Number(match.manual_points?.gpt || 0);
  const deltaRay = newRay - oldRay;
  const deltaGpt = newGpt - oldGpt;
  const pointsChanged = deltaRay !== 0 || deltaGpt !== 0 || !!oldManual?.provisional !== !!match.manual_points?.provisional;
 
const actualChanged = JSON.stringify(match.actual || {}) !== oldActualText;
const changed = !wasActualFinished || pointsChanged || actualChanged;
 if (!changed && deltaRay === 0 && deltaGpt === 0) return null;
  return { id: match.id, changed: true, home: match.home, away: match.away, score: publicScore(match), ray: deltaRay, gpt: deltaGpt, needsManual: missingRegulation };
}

function scorerKey(player, team) { return `${normalizeTextKey(player)}__${normalizeTextKey(team)}`; }
function rankTopScorers(list) {
  list.sort((a, b) => {
    const goals = Number(b.goals || 0) - Number(a.goals || 0);
    if (goals) return goals;
    const assists = Number(b.assists || 0) - Number(a.assists || 0);
    if (assists) return assists;
    const am = Number.isFinite(Number(a.minutes)) ? Number(a.minutes) : 99999;
    const bm = Number.isFinite(Number(b.minutes)) ? Number(b.minutes) : 99999;
    if (am !== bm) return am - bm;
    return String(a.player || "").localeCompare(String(b.player || ""));
  });
  list.forEach((row, i) => { row.rank = i + 1; });
  return list.slice(0, TOP_SCORERS_LIMIT);
}
function updateTopScorersForMatch(data, match, event, summary) {
  if (!match.actual) match.actual = {};
  if (!summary) {
    match.actual.scorer_update_pending = true;
    match.actual.scorer_update_status = "summary_unavailable";
    return { changed: false, goals: [] };
  }
  const goals = event.goal_events && event.goal_events.length ? event.goal_events : extractGoalEvents(summary, event);
  const openPlayGoals = scoreComplete(match.actual.final_score) ? Number(match.actual.final_score.home_score || 0) + Number(match.actual.final_score.away_score || 0) : 0;
  if (!goals.length && openPlayGoals > 0) {
    match.actual.scorer_update_pending = true;
    match.actual.scorer_update_status = "needs_manual_goal_scorers";
    return { changed: true, goals: [] };
  }

  data.top_scorers = Array.isArray(data.top_scorers) ? data.top_scorers : [];
  const before = JSON.stringify(data.top_scorers);
  const byKey = new Map();
  for (const row of data.top_scorers) byKey.set(scorerKey(row.player, row.team), row);
  const changedGoals = [];

  for (const goal of goals) {
    const key = scorerKey(goal.player, goal.team);
    let row = byKey.get(key);
    if (!row) {
      row = data.top_scorers.find(x => normalizeTextKey(x.player) === normalizeTextKey(goal.player));
      if (row) byKey.set(key, row);
    }
    if (!row) {
      row = { rank: data.top_scorers.length + 1, player: goal.player, team: goal.team, goals: 0, assists: 0, minutes: "—" };
      data.top_scorers.push(row);
      byKey.set(key, row);
    }
    row.team = row.team || goal.team;
    row.goals = Number(row.goals || 0) + 1;
    row.note = `最近进球：${match.home} vs ${match.away}${goal.minute ? `，${goal.minute}'` : ""}。`;
    changedGoals.push(goal);
  }

  data.top_scorers = rankTopScorers(data.top_scorers);
  data.top_scorers_source = `射手榜随 ESPN scoring plays 自动刷新；最后更新 ${shortBJT(new Date()).replace(" BJT", "")}。`;
  match.actual.scorer_update_pending = false;
  match.actual.scorers_updated = true;
  match.actual.scorer_update_status = goals.length ? "updated" : "no_open_play_goals";
  match.actual.scorer_update_at = formatBJT(new Date());
  return { changed: before !== JSON.stringify(data.top_scorers) || goals.length === 0, goals: changedGoals };
}
function shouldTryScorerUpdate(match) {
  if (!UPDATE_TOP_SCORERS || !actualFinished(match)) return false;
  if (match.actual?.scorers_updated) return false;
  if (match.actual?.scorer_update_pending) return true;
  if (SCORER_CATCHUP) return true;
  const cutoff = catchupCutoffMs();
  if (Number.isFinite(cutoff)) {
    const kickoff = parseBjDateTime(match.kickoff_local);
    return Number.isFinite(kickoff) && kickoff >= cutoff;
  }
  return false;
}

function appendUpdateLog(data, scoreUpdates, scorerUpdates) {
  data.update_log = Array.isArray(data.update_log) ? data.update_log : [];
  for (const u of scoreUpdates) {
    const suffix = u.needsManual ? "；90分钟比分待补全。" : "。";
    data.update_log.push({ time: shortBJT(new Date()).replace(" BJT", ""), text: `淘汰赛更新：${u.home} ${u.score} ${u.away}，Ray ${u.ray >= 0 ? "+" : ""}${u.ray}，GPT ${u.gpt >= 0 ? "+" : ""}${u.gpt}${suffix}` });
  }
  for (const s of scorerUpdates) {
    if (s.goals.length) {
      data.update_log.push({ time: shortBJT(new Date()).replace(" BJT", ""), text: `射手榜更新：${s.match.home} vs ${s.match.away}，录入 ${s.goals.map(g => `${g.player}（${g.team}）`).join("、")} 进球。` });
    } else if (s.needsManual) {
      data.update_log.push({ time: shortBJT(new Date()).replace(" BJT", ""), text: `射手榜待核对：${s.match.home} vs ${s.match.away} 已有进球，但 ESPN scoring plays 暂未解析出进球者。` });
    }
  }
  if (UPDATE_LOG_LIMIT > 0 && data.update_log.length > UPDATE_LOG_LIMIT) data.update_log = data.update_log.slice(-UPDATE_LOG_LIMIT);
}
function applyTotals(data, updates) {
  const rayAdd = updates.reduce((s,u)=>s+Number(u.ray||0),0), gptAdd = updates.reduce((s,u)=>s+Number(u.gpt||0),0);
  if (!rayAdd && !gptAdd) return;
  data.score_summary = data.score_summary || { ray_total: 0, gpt_total: 0 };
  data.score_summary.ray_total = Number(data.score_summary.ray_total || 0) + rayAdd;
  data.score_summary.gpt_total = Number(data.score_summary.gpt_total || 0) + gptAdd;
  const r = data.score_summary.ray_total, g = data.score_summary.gpt_total;
  data.score_summary.leader_comment = r === g ? `Ray 与 GPT 5.5 战成 ${r}:${g}。` : r > g ? `Ray 以 ${r}:${g} 领先 GPT 5.5。` : `GPT 5.5 以 ${g}:${r} 领先 Ray。`;
}
function refreshHeadline(data, updates, scorerUpdates) {
  if (updates.length) {
    const last = updates[updates.length - 1];
    data.headline = `淘汰赛更新：${last.home} ${last.score} ${last.away}`;
    data.brief = `最新淘汰赛已结算：${updates.map(u => `${u.home} ${u.score} ${u.away}，Ray ${u.ray >= 0 ? "+" : ""}${u.ray}，GPT ${u.gpt >= 0 ? "+" : ""}${u.gpt}`).join("；")}。`;
    return;
  }
  if (scorerUpdates.some(x => x.goals.length)) {
    const last = scorerUpdates.filter(x => x.goals.length).at(-1);
    data.brief = `射手榜已随最新比赛刷新：${last.goals.map(g => `${g.player}（${g.team}）`).join("、")}。`;
  }
}
function validate(data) {
  const banned = ["自动" + "简写版", "本场" + "采用" + "人工" + "裁定", "人工" + "裁定", "人工" + "约定"];
  const text = JSON.stringify(data);
  const found = banned.filter(x => text.includes(x));
  if (found.length) throw new Error(`Banned public phrase(s): ${found.join(", ")}`);
  for (const match of data.knockout_matches || []) {
    const a = match.actual || {};
    if (!a.advancing_team || !scoreComplete(a.final_score)) continue;
    if (!match.manual_points) throw new Error(`Finished match missing manual_points/provisional points: ${match.id}`);
    if (needsRegulationScore(a.method) && !scoreComplete(a.regulation_score) && !match.manual_points.provisional) {
      throw new Error(`Extra-time/penalty match missing regulation_score without provisional flag: ${match.id}`);
    }
  }
}

async function main() {
  const dataFile = path.resolve(DATA_PATH);
  const originalText = fs.readFileSync(dataFile, "utf8");
  const data = JSON.parse(originalText);
  if (data.phase !== "knockout") {
    console.log("Not a knockout data file; no update performed.");
    return;
  }
  const oldTotals = { ray: Number(data.score_summary?.ray_total || 0), gpt: Number(data.score_summary?.gpt_total || 0) };
  const scoreboard = await loadScoreboard();
  const events = (scoreboard.events || []).map(normalizeEvent).filter(e => e.completed);
  const eventByKey = new Map(events.map(e => [matchKey(e.home, e.away), e]));
  const eventById = new Map(events.map(e => [String(e.espn_id || ""), e]));
  const summaryCache = new Map();
  async function summaryFor(event) {
    if (!event?.espn_id) return null;
    if (!summaryCache.has(event.espn_id)) summaryCache.set(event.espn_id, await loadEventSummary(event.espn_id));
    return summaryCache.get(event.espn_id);
  }
  function findEvent(match) {
    return eventById.get(String(match.espn_id || "")) || eventByKey.get(matchKey(match.home, match.away));
  }

  const scoreUpdates = [];
  for (const match of data.knockout_matches || []) {
    if (fullyPointSettled(match)) continue;
    const event = findEvent(match);
    if (!event) continue;
    const needSummary = needsRegulationScore(event.method) || UPDATE_TOP_SCORERS;
    if (needSummary) enrichEventFromSummary(event, await summaryFor(event));
    const update = updateOneMatch(data, match, event);
    if (update) scoreUpdates.push(update);
  }

  const scorerUpdates = [];
  if (UPDATE_TOP_SCORERS) {
    for (const match of data.knockout_matches || []) {
      if (!shouldTryScorerUpdate(match)) continue;
      const event = findEvent(match);
      if (!event) continue;
      const summary = await summaryFor(event);
      if (summary) enrichEventFromSummary(event, summary);
      const result = updateTopScorersForMatch(data, match, event, summary);
      if (result.changed || result.goals.length) scorerUpdates.push({ match, goals: result.goals, needsManual: match.actual?.scorer_update_status === "needs_manual_goal_scorers" });
    }
  }

  if (!scoreUpdates.length && !scorerUpdates.length) {
    console.log("No completed knockout matches or top-scorer changes to update.");
    return;
  }
  applyTotals(data, scoreUpdates);
  appendUpdateLog(data, scoreUpdates, scorerUpdates);
  refreshHeadline(data, scoreUpdates, scorerUpdates);
  data.meta = data.meta || {};
  data.meta.updated_at = formatBJT(new Date());
  data.meta.version = `knockout-auto-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0,12)}`;
  validate(data);
  if (Number(data.score_summary.ray_total) < oldTotals.ray || Number(data.score_summary.gpt_total) < oldTotals.gpt) throw new Error("Refusing to publish: total decreased.");
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(`Updated ${scoreUpdates.length} knockout match(es), ${scorerUpdates.length} top-scorer item(s).`);
}
main().catch(err => { console.error(err); process.exit(1); });
