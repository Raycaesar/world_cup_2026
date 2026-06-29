#!/usr/bin/env node
/*
  Safe auto-update knockout match results in data.json from ESPN scoreboard.
  This replaces the group-stage updater after the archive split.
*/
const fs = require("node:fs");
const path = require("node:path");
const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const DATA_PATH = process.env.DATA_PATH || "data.json";
const UPDATE_LOG_LIMIT = Number(process.env.UPDATE_LOG_LIMIT || 20);
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
function shortBJT(dateLike) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: BJT_TIME_ZONE, month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false }).formatToParts(date);
  const get = t => parts.find(p => p.type === t)?.value || "";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")} BJT`;
}
function formatBJT(dateLike) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: BJT_TIME_ZONE, year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false }).formatToParts(date);
  const get = t => parts.find(p => p.type === t)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} BJT`;
}
function teamName(competitor) { return normalizeName(competitor?.team?.displayName || competitor?.team?.name || competitor?.team?.shortDisplayName || ""); }
function inferMethod(competition, event, home, away) {
  const status = [competition.status?.type?.detail, competition.status?.type?.shortDetail, competition.status?.type?.name, event.status?.type?.detail, event.status?.type?.shortDetail].filter(Boolean).join(" ").toLowerCase();
  const shootHome = home?.shootoutScore ?? home?.curatedRank?.shootoutScore;
  const shootAway = away?.shootoutScore ?? away?.curatedRank?.shootoutScore;
  if (status.includes("pen") || shootHome !== undefined || shootAway !== undefined) return "penalties";
  if (status.includes("aet") || status.includes("extra")) return "extra_time";
  return "90";
}
function normalizeEvent(event) {
  const competition = event.competitions?.[0] || {};
  const competitors = competition.competitors || [];
  const home = competitors.find(c => c.homeAway === "home") || competitors[0] || {};
  const away = competitors.find(c => c.homeAway === "away") || competitors[1] || {};
  const statusType = competition.status?.type || event.status?.type || {};
  const completed = statusType.state === "post" || statusType.completed === true;
  const hs = Number(home.score ?? NaN);
  const as = Number(away.score ?? NaN);
  return {
    espn_id: String(event.id || ""), completed, home: teamName(home), away: teamName(away),
    home_score: Number.isFinite(hs) ? hs : null, away_score: Number.isFinite(as) ? as : null,
    method: inferMethod(competition, event, home, away), kickoff_bjt: shortBJT(event.date)
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
function scoreComplete(score) { return score && score.home_score !== null && score.home_score !== undefined && score.away_score !== null && score.away_score !== undefined; }
function actualFinished(match) { return match.actual && match.actual.advancing_team && scoreComplete(match.actual.final_score); }
function winner(home, away, homeTeam, awayTeam) { if (home > away) return homeTeam; if (away > home) return awayTeam; return null; }
function methodLabel(method) { return method === "90" ? "90分钟" : method === "extra_time" || method === "extra" ? "加时" : method === "penalties" ? "点球" : "未定"; }
function predictionDetailPoints(pred, actual) {
  const predMethod = pred.method === "extra" ? "extra_time" : pred.method;
  const actualMethod = actual.method === "extra" ? "extra_time" : actual.method;
  if (predMethod !== actualMethod) return 0;
  let pts = 1;
  const ps = pred.regulation_score || {};
  const as = actual.regulation_score || {};
  if (ps.home_score === as.home_score && ps.away_score === as.away_score) pts += 1;
  return pts;
}
function calculateKnockoutPoints(match) {
  const actual = match.actual || {};
  if (!actual.advancing_team || !actual.method || !scoreComplete(actual.regulation_score)) return null;
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
function updateOneMatch(match, event) {
  if (actualFinished(match)) return null;
  const final = { home_score: event.home_score, away_score: event.away_score };
  if (!scoreComplete(final)) return null;
  const advancing = winner(final.home_score, final.away_score, match.home, match.away);
  const method = event.method || "90";
  match.status = "已结束";
  match.espn_id = event.espn_id || match.espn_id;
  match.actual = match.actual || {};
  match.actual.method = method;
  match.actual.final_score = final;
  match.actual.advancing_team = advancing;
  if (method === "90") match.actual.regulation_score = final;
  if (!scoreComplete(match.actual.regulation_score)) {
    match.review = `${match.home} ${final.home_score}:${final.away_score} ${match.away}。比赛已结束，但需要手动补充90分钟比分与晋级方式后再计分。`;
    return { id: match.id, home: match.home, away: match.away, score: `${final.home_score}:${final.away_score}`, ray: 0, gpt: 0, needsManual: true };
  }
  const pts = calculateKnockoutPoints(match);
  if (pts) match.manual_points = pts;
  match.review = `${match.home} ${final.home_score}:${final.away_score} ${match.away}，${advancing || "胜者"}通过${methodLabel(method)}晋级。${pts ? pts.explanation : "本场计分待确认。"}`;
  return { id: match.id, home: match.home, away: match.away, score: `${final.home_score}:${final.away_score}`, ray: pts?.ray || 0, gpt: pts?.gpt || 0 };
}
function appendUpdateLog(data, updates) {
  data.update_log = Array.isArray(data.update_log) ? data.update_log : [];
  for (const u of updates) data.update_log.push({ time: shortBJT(new Date()).replace(" BJT", ""), text: `自动更新：${u.home} ${u.score} ${u.away}，Ray +${u.ray}，GPT +${u.gpt}。` });
  if (UPDATE_LOG_LIMIT > 0 && data.update_log.length > UPDATE_LOG_LIMIT) data.update_log = data.update_log.slice(-UPDATE_LOG_LIMIT);
}
function applyTotals(data, updates) {
  const rayAdd = updates.reduce((s,u)=>s+Number(u.ray||0),0), gptAdd = updates.reduce((s,u)=>s+Number(u.gpt||0),0);
  data.score_summary = data.score_summary || { ray_total: 0, gpt_total: 0 };
  data.score_summary.ray_total = Number(data.score_summary.ray_total || 0) + rayAdd;
  data.score_summary.gpt_total = Number(data.score_summary.gpt_total || 0) + gptAdd;
  const r = data.score_summary.ray_total, g = data.score_summary.gpt_total;
  data.score_summary.leader_comment = r === g ? "Ray 与 GPT 5.5 战平。" : r > g ? `Ray 以 ${r}:${g} 领先 GPT 5.5。` : `GPT 5.5 以 ${g}:${r} 领先 Ray。`;
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
  const updates = [];
  for (const match of data.knockout_matches || []) {
    if (actualFinished(match)) continue;
    const event = eventByKey.get(matchKey(match.home, match.away));
    if (!event) continue;
    const update = updateOneMatch(match, event);
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
