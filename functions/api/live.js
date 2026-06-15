const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const BJT_TIME_ZONE = "Asia/Shanghai";

const TEAM_ZH = {
  "Germany": "德国",
  "Curacao": "库拉索",
  "Curaçao": "库拉索",
  "Netherlands": "荷兰",
  "Japan": "日本",
  "Ivory Coast": "科特迪瓦",
  "Côte d'Ivoire": "科特迪瓦",
  "Ecuador": "厄瓜多尔",
  "Sweden": "瑞典",
  "Tunisia": "突尼斯",
  "Spain": "西班牙",
  "Cape Verde": "佛得角",
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
  "Algeria": "阿尔及利亚"
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

function normalizeEvent(event) {
  const competition = event.competitions?.[0] || {};
  const competitors = competition.competitors || [];
  const home = competitors.find(c => c.homeAway === "home") || competitors[0] || {};
  const away = competitors.find(c => c.homeAway === "away") || competitors[1] || {};
  const statusType = competition.status?.type || event.status?.type || {};
  const state = statusType.state || "pre";
  const isPre = state === "pre";
  const isLive = state === "in";

  return {
    id: event.id,
    tag: isLive ? "LIVE" : isPre ? "NEXT" : "FT",
    state,
    home: teamName(home),
    away: teamName(away),
    home_score: isPre ? null : Number(home.score ?? 0),
    away_score: isPre ? null : Number(away.score ?? 0),
    status_text: isLive
      ? (competition.status?.displayClock || statusType.detail || statusType.shortDetail || "Live")
      : state === "post" ? "FT" : "",
    kickoff_bjt: formatBJT(event.date),
    kickoff_ts: event.date ? new Date(event.date).getTime() : 0
  };
}

function pickTickerMatches(matches) {
  const now = Date.now();
  const live = matches
    .filter(m => m.state === "in")
    .sort((a, b) => a.kickoff_ts - b.kickoff_ts)
    .slice(0, 2);

  const next = matches
    .filter(m => m.state === "pre" && m.kickoff_ts >= now - 20 * 60 * 1000)
    .sort((a, b) => a.kickoff_ts - b.kickoff_ts)
    .slice(0, 2);

  return [...live, ...next];
}

export async function onRequestGet() {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "max-age=20, stale-while-revalidate=20"
  };

  try {
    const now = new Date();
    const start = new Date(now.getTime() - 6 * 60 * 60 * 1000);
    const end = new Date(now.getTime() + 36 * 60 * 60 * 1000);
    const url = `${ESPN_SCOREBOARD}?limit=80&dates=${ymd(start)}-${ymd(end)}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`ESPN scoreboard failed: ${res.status}`);

    const data = await res.json();
    const matches = pickTickerMatches((data.events || []).map(normalizeEvent));

    return new Response(JSON.stringify({
      updated_at: new Date().toISOString(),
      source: "espn-fifa-world-scoreboard-filtered-live-next2",
      matches
    }), { headers });
  } catch (error) {
    return new Response(JSON.stringify({
      updated_at: new Date().toISOString(),
      source: "espn-fifa-world-scoreboard-filtered-live-next2",
      matches: [],
      error: "live_source_unavailable"
    }), { headers });
  }
}
