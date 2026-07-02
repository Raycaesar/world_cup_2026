const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const BJT_TIME_ZONE = "Asia/Shanghai";

const TEAM_ZH = {
  "South Africa":"南非", "Canada":"加拿大", "Brazil":"巴西", "Japan":"日本", "Germany":"德国", "Paraguay":"巴拉圭",
  "Netherlands":"荷兰", "Morocco":"摩洛哥", "Curacao":"库拉索", "Curaçao":"库拉索", "Ivory Coast":"科特迪瓦", "Côte d'Ivoire":"科特迪瓦",
  "Ecuador":"厄瓜多尔", "Sweden":"瑞典", "Tunisia":"突尼斯", "Spain":"西班牙", "Cape Verde":"佛得角", "Cabo Verde":"佛得角",
  "Belgium":"比利时", "Egypt":"埃及", "Saudi Arabia":"沙特", "Uruguay":"乌拉圭", "Iran":"伊朗", "IR Iran":"伊朗",
  "New Zealand":"新西兰", "France":"法国", "Senegal":"塞内加尔", "Iraq":"伊拉克", "Norway":"挪威",
  "Argentina":"阿根廷", "Algeria":"阿尔及利亚", "Austria":"奥地利", "Jordan":"约旦", "England":"英格兰", "DR Congo":"刚果（金）",
  "Congo DR":"刚果（金）", "United States":"美国", "USA":"美国", "Bosnia and Herzegovina":"波黑", "Bosnia-Herzegovina":"波黑",
  "Portugal":"葡萄牙", "Croatia":"克罗地亚", "Switzerland":"瑞士", "Australia":"澳大利亚", "Colombia":"哥伦比亚", "Ghana":"加纳",
  "Mexico":"墨西哥"
};

function ymd(date) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function formatBJT(iso) {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: BJT_TIME_ZONE,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(iso));
  const get = type => parts.find(p => p.type === type)?.value || "";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")} BJT`;
}

function teamName(competitor) {
  const raw = competitor?.team?.displayName || competitor?.team?.name || competitor?.team?.shortDisplayName || "";
  return TEAM_ZH[raw] || raw;
}
function numberOrNull(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function scoreComplete(score) { return score && score.home_score !== null && score.home_score !== undefined && score.away_score !== null && score.away_score !== undefined; }
function makeScore(home, away) { return { home_score: home, away_score: away }; }
function scoreLabel(score) { return scoreComplete(score) ? `${score.home_score}:${score.away_score}` : ""; }
function readShootoutScore(competitor) {
  const candidates = [competitor?.shootoutScore, competitor?.shootout_score, competitor?.curatedRank?.shootoutScore, competitor?.curatedRank?.shootout_score];
  for (const value of candidates) {
    const n = numberOrNull(value);
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
  const hs = sumFirst(lineValues(home), 2);
  const as = sumFirst(lineValues(away), 2);
  return hs === null || as === null ? null : makeScore(hs, as);
}
function statusText(competition, event) {
  return [competition.status?.displayClock, competition.status?.type?.detail, competition.status?.type?.shortDetail, competition.status?.type?.name, event.status?.type?.detail, event.status?.type?.shortDetail, event.status?.type?.name].filter(Boolean).join(" ");
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
function winnerFrom(homeScore, awayScore, homeTeam, awayTeam) {
  if (homeScore > awayScore) return homeTeam;
  if (awayScore > homeScore) return awayTeam;
  return "";
}
function methodLabel(method) {
  return method === "90" ? "90分钟" : method === "extra_time" ? "加时" : method === "penalties" ? "点球" : "";
}
function normalizeEvent(event) {
  const competition = event.competitions?.[0] || {};
  const competitors = competition.competitors || [];
  const home = competitors.find(c => c.homeAway === "home") || competitors[0] || {};
  const away = competitors.find(c => c.homeAway === "away") || competitors[1] || {};
  const statusType = competition.status?.type || event.status?.type || {};
  const state = statusType.state || "pre";
  const isPre = state === "pre";
  const isLive = state === "in";
  const homeTeam = teamName(home), awayTeam = teamName(away);
  const final_score = { home_score: isPre ? null : numberOrNull(home.score), away_score: isPre ? null : numberOrNull(away.score) };
  const regulation_score = readRegulationScore(home, away);
  const penalties_score = { home_score: readShootoutScore(home), away_score: readShootoutScore(away) };
  const method = inferMethod(competition, event, home, away);
  let winner = "";
  if (method === "penalties" && scoreComplete(penalties_score)) winner = winnerFrom(penalties_score.home_score, penalties_score.away_score, homeTeam, awayTeam);
  if (!winner && scoreComplete(final_score)) winner = winnerFrom(final_score.home_score, final_score.away_score, homeTeam, awayTeam);
  const markedWinner = competitors.find(c => c.winner === true);
  if (!winner && markedWinner) winner = teamName(markedWinner);

  let score_text = scoreComplete(final_score) ? `${homeTeam} ${scoreLabel(final_score)} ${awayTeam}` : `${homeTeam} vs ${awayTeam}`;
  const shootout_text = scoreComplete(penalties_score) ? `点球 ${scoreLabel(penalties_score)}` : "";
  if (method === "extra_time") score_text += "，加时";
  if (method === "penalties") score_text += shootout_text ? `，${shootout_text}` : "，点球大战";

  return {
    id: event.id,
    tag: isLive ? "LIVE" : isPre ? "NEXT" : "FT",
    state,
    method,
    method_label: methodLabel(method),
    home: homeTeam,
    away: awayTeam,
    home_score: final_score.home_score,
    away_score: final_score.away_score,
    regulation_home_score: regulation_score?.home_score ?? null,
    regulation_away_score: regulation_score?.away_score ?? null,
    penalties_home_score: penalties_score.home_score,
    penalties_away_score: penalties_score.away_score,
    score_text,
    shootout_text,
    winner,
    status_text: isLive
      ? (competition.status?.displayClock || statusType.detail || statusType.shortDetail || "Live")
      : state === "post" ? (winner ? `${winner}晋级` : "FT") : "",
    kickoff_bjt: formatBJT(event.date),
    kickoff_ts: event.date ? new Date(event.date).getTime() : 0
  };
}

function pickTickerMatches(matches) {
  const now = Date.now();
  const live = matches
    .filter(m => m.state === "in")
    .sort((a, b) => a.kickoff_ts - b.kickoff_ts)
    .slice(0, 3);
  const next = matches
    .filter(m => m.state === "pre" && m.kickoff_ts >= now - 20 * 60 * 1000)
    .sort((a, b) => a.kickoff_ts - b.kickoff_ts)
    .slice(0, 5);
  const justFinal = matches
    .filter(m => m.state === "post" && m.kickoff_ts >= now - 8 * 60 * 60 * 1000)
    .sort((a, b) => b.kickoff_ts - a.kickoff_ts)
    .slice(0, 2);
  return [...live, ...justFinal, ...next].slice(0, 6);
}

export async function onRequestGet() {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "max-age=20, stale-while-revalidate=20"
  };

  try {
    const now = new Date();
    const start = new Date(now.getTime() - 12 * 60 * 60 * 1000);
    const end = new Date(now.getTime() + 36 * 60 * 60 * 1000);
    const url = `${ESPN_SCOREBOARD}?limit=80&dates=${ymd(start)}-${ymd(end)}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`ESPN scoreboard failed: ${res.status}`);

    const data = await res.json();
    const matches = pickTickerMatches((data.events || []).map(normalizeEvent));

    return new Response(JSON.stringify({
      updated_at: new Date().toISOString(),
      source: "espn-fifa-world-scoreboard-live-next-finals",
      matches
    }), { headers });
  } catch (error) {
    return new Response(JSON.stringify({
      updated_at: new Date().toISOString(),
      source: "espn-fifa-world-scoreboard-live-next-finals",
      matches: [],
      error: "live_source_unavailable"
    }), { headers });
  }
}
