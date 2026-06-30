#!/usr/bin/env node
/*
  Safe auto-update knockout match results in data.json from ESPN scoreboard.
  Handles 90 minutes, extra time and penalty shootouts without inventing a winner
  from a tied open-play score.
*/
const fs = require("node:fs");
const path = require("node:path");
const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const DATA_PATH = process.env.DATA_PATH || "data.json";
const UPDATE_LOG_LIMIT = Number(process.env.UPDATE_LOG_LIMIT || 24);
const BJT_TIME_ZONE = "Asia/Shanghai";
const TEAM_ZH = {
  "South Africa":"南非", "Canada":"加拿大", "Brazil":"巴西", "Japan":"日本", "Germany":"德国", "Paraguay":"巴拉圭",
  "Netherlands":"荷兰", "Morocco":"摩洛哥", "Ivory Coast":"科特迪瓦", "Côte d'Ivoire":"科特迪瓦", "Norway":"挪威",
  "France":"法国", "Sweden":"瑞典", "Mexico":"墨西哥", "Ecuador":"厄瓜多尔", "England":"英格兰", "DR Congo":"刚果（金）",
  "Congo DR":"刚果（金）", "Belgium":"比利时", "Senegal":"塞内加尔", "United States":"美国", "USA":"美国",
  "Bosnia and Herzegovina":"波黑", "Bosnia-Herzegovina":"波黑", "Spain":"西班牙", "Austria":"奥地利", "Portugal":"葡萄牙",
  "Croatia":"克罗地亚", "Switzerland":"瑞士", "Algeria":"阿尔及利亚", "Australia":"澳大利亚", "Egypt":"埃及",
  "Argentina":"阿根廷", "Cape Verde":"佛得角", "Cabo Verde":"佛得角", "Colombia":"哥伦比亚", "Ghana":"加纳"
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
    espn_id: String(event.id || ""), completed, home: homeTeam, away: awayTeam,
    final_score: final, regulation_score: regulation,
    extra_time_score: method === "extra_time" || method === "penalties" ? final : null,
    penalties_score: scoreComplete(penalties) ? penalties : null,
    advancing_team: advancing,
    method,
    kickoff_bjt: shortBJT(event.date),
    status_text: statusText(competition, event)
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
function actualFinished(match) { return !!(match.actual && match.actual.advancing_team && scoreComplete(match.actual.final_score)); }
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
  if (scoreComplete(match.actual.penalties_score)) b.penalties_score = match.actual.penalties_score;
  const next = match.actual.next_match || (b.note && b.note.includes("对阵") ? b.note.replace(/^胜者/, match.actual.advancing_team) : "");
  b.note = next ? `${match.actual.advancing_team}通过${methodLabel(match.actual.method)}晋级，${next}` : `${match.actual.advancing_team}通过${methodLabel(match.actual.method)}晋级`;
}
function updateOneMatch(data, match, event) {
  if (actualFinished(match)) return null;
  if (!scoreComplete(event.final_score)) return null;
  match.status = "已结束";
  match.espn_id = event.espn_id || match.espn_id;
  match.actual = match.actual || {};
  match.actual.method = event.method || "90";
  match.actual.final_score = event.final_score;
  match.actual.advancing_team = event.advancing_team;
  if (scoreComplete(event.regulation_score)) match.actual.regulation_score = event.regulation_score;
  else if (match.actual.method === "90") match.actual.regulation_score = event.final_score;
  if (scoreComplete(event.extra_time_score)) match.actual.extra_time_score = event.extra_time_score;
  if (scoreComplete(event.penalties_score)) match.actual.penalties_score = event.penalties_score;
  if (!match.actual.advancing_team) {
    match.review = `${match.home} ${scoreLabel(event.final_score)} ${match.away}。比赛已结束，但比分仍为平局；需要补充加时/点球信息后才能确认晋级队。`;
    return { id: match.id, home: match.home, away: match.away, score: scoreLabel(event.final_score), ray: 0, gpt: 0, needsManual: true };
  }
  const b = findBracketEntry(data, match);
  if (b?.note && !match.actual.next_match) match.actual.next_match = nextMatchTextFromNote(b.note, match.actual.advancing_team);
  const pts = calculateKnockoutPoints(match);
  if (pts) match.manual_points = pts;
  const pathText = match.actual.method === "penalties" && scoreComplete(match.actual.penalties_score)
    ? `点球大战 ${scoreLabel(match.actual.penalties_score)}`
    : methodLabel(match.actual.method);
  const nextSentence = match.actual.next_match
    ? (/^对阵/.test(String(match.actual.next_match)) ? `下一轮将${match.actual.next_match}。` : `${match.actual.next_match}。`)
    : "";
  match.review = `${match.home} ${scoreLabel(match.actual.final_score)} ${match.away}${match.actual.method === "penalties" ? `，${pathText}` : ""}，${match.actual.advancing_team}晋级。${nextSentence}${pts ? pts.explanation : "本场计分待确认。"}`;
  updateBracket(data, match);
  return { id: match.id, home: match.home, away: match.away, score: publicScore(match), ray: pts?.ray || 0, gpt: pts?.gpt || 0 };
}
function appendUpdateLog(data, updates) {
  data.update_log = Array.isArray(data.update_log) ? data.update_log : [];
  for (const u of updates) data.update_log.push({ time: shortBJT(new Date()).replace(" BJT", ""), text: `淘汰赛更新：${u.home} ${u.score} ${u.away}，Ray +${u.ray}，GPT +${u.gpt}。` });
  if (UPDATE_LOG_LIMIT > 0 && data.update_log.length > UPDATE_LOG_LIMIT) data.update_log = data.update_log.slice(-UPDATE_LOG_LIMIT);
}
function applyTotals(data, updates) {
  const rayAdd = updates.reduce((s,u)=>s+Number(u.ray||0),0), gptAdd = updates.reduce((s,u)=>s+Number(u.gpt||0),0);
  data.score_summary = data.score_summary || { ray_total: 0, gpt_total: 0 };
  data.score_summary.ray_total = Number(data.score_summary.ray_total || 0) + rayAdd;
  data.score_summary.gpt_total = Number(data.score_summary.gpt_total || 0) + gptAdd;
  const r = data.score_summary.ray_total, g = data.score_summary.gpt_total;
  data.score_summary.leader_comment = r === g ? `Ray 与 GPT 5.5 战成 ${r}:${g}。` : r > g ? `Ray 以 ${r}:${g} 领先 GPT 5.5。` : `GPT 5.5 以 ${g}:${r} 领先 Ray。`;
}
function refreshHeadline(data, updates) {
  if (!updates.length) return;
  const last = updates[updates.length - 1];
  data.headline = `淘汰赛更新：${last.home} ${last.score} ${last.away}`;
  data.brief = `最新淘汰赛已结算：${updates.map(u => `${u.home} ${u.score} ${u.away}，Ray +${u.ray}，GPT +${u.gpt}`).join("；")}。`;
}
function validate(data) {
  const banned = ["自动" + "简写版", "本场" + "采用" + "人工" + "裁定", "人工" + "裁定", "人工" + "约定"];
  const text = JSON.stringify(data);
  const found = banned.filter(x => text.includes(x));
  if (found.length) throw new Error(`Banned public phrase(s): ${found.join(", ")}`);
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
  const updates = [];
  for (const match of data.knockout_matches || []) {
    if (actualFinished(match)) continue;
    const event = eventById.get(String(match.espn_id || "")) || eventByKey.get(matchKey(match.home, match.away));
    if (!event) continue;
    const update = updateOneMatch(data, match, event);
    if (update) updates.push(update);
  }
  if (!updates.length) { console.log("No completed knockout matches to update."); return; }
  applyTotals(data, updates);
  appendUpdateLog(data, updates);
  refreshHeadline(data, updates);
  data.meta = data.meta || {};
  data.meta.updated_at = formatBJT(new Date());
  data.meta.version = `knockout-auto-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0,12)}`;
  validate(data);
  if (Number(data.score_summary.ray_total) < oldTotals.ray || Number(data.score_summary.gpt_total) < oldTotals.gpt) throw new Error("Refusing to publish: total decreased.");
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(`Updated ${updates.length} knockout match(es).`);
}
main().catch(err => { console.error(err); process.exit(1); });
