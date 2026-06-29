#!/usr/bin/env node
/*
  Publish pre-filed knockout predictions at scheduled Beijing time.
  It reveals entries from data.prediction_release_plan into data.knockout_matches.

  Default schedule: run daily at 10:00 UTC = 18:00 Beijing time.
  Test with: RELEASE_NOW=2026-06-29T10:00:00Z DATA_PATH=data.json node scripts/publish_predictions.js
*/
const fs = require("node:fs");
const path = require("node:path");

const DATA_PATH = process.env.DATA_PATH || "data.json";
const RELEASE_NOW = process.env.RELEASE_NOW ? new Date(process.env.RELEASE_NOW) : new Date();
const UPDATE_LOG_LIMIT = Number(process.env.UPDATE_LOG_LIMIT || 24);
const BJT_TIME_ZONE = "Asia/Shanghai";

function formatBJT(dateLike) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: BJT_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} BJT`;
}

function shortBJT(dateLike) {
  const full = formatBJT(dateLike);
  return full.slice(5, 16).replace("-", "-");
}

function parseKickoffKey(match) {
  const raw = String(match.kickoff_local || "");
  const m = raw.match(/(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return raw;
  return `${m[1]}${m[2]}${m[3]}${m[4]}`;
}

function normalizeMethod(method) {
  if (method === "extra") return "extra_time";
  return method || "90";
}

function normalizePrediction(pred) {
  if (!pred) return null;
  return {
    ...pred,
    method: normalizeMethod(pred.method),
    regulation_score: pred.regulation_score || { home_score: null, away_score: null }
  };
}

function makeMatch(entry, now) {
  return {
    id: entry.match_id,
    espn_id: entry.espn_id || null,
    round: entry.round || "32强",
    kickoff_local: entry.kickoff_local,
    home: entry.home,
    away: entry.away,
    venue: entry.venue || "",
    status: entry.status || "未开始",
    actual: {
      method: null,
      regulation_score: { home_score: null, away_score: null },
      final_score: { home_score: null, away_score: null },
      advancing_team: null
    },
    ray_prediction: normalizePrediction(entry.ray_prediction),
    gpt_prediction: normalizePrediction(entry.gpt_prediction),
    manual_points: null,
    review: "赛前预测。",
    predictions_published_at: formatBJT(now)
  };
}

function validate(data) {
  const banned = ["自动" + "简写版", "本场" + "采用" + "人工" + "裁定", "人工" + "裁定", "人工" + "约定", "Ray " + "14:3", "今日" + "暂时 0:0"];
  const text = JSON.stringify(data);
  const found = banned.filter(x => text.includes(x));
  if (found.length) throw new Error(`Banned public phrase(s): ${found.join(", ")}`);
}

function main() {
  const dataFile = path.resolve(DATA_PATH);
  const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  if (data.phase !== "knockout") {
    console.log("Not a knockout data file; no prediction release performed.");
    return;
  }

  const plan = Array.isArray(data.prediction_release_plan) ? data.prediction_release_plan : [];
  data.knockout_matches = Array.isArray(data.knockout_matches) ? data.knockout_matches : [];
  data.update_log = Array.isArray(data.update_log) ? data.update_log : [];

  const existingById = new Map(data.knockout_matches.map(m => [m.id, m]));
  const released = [];

  for (const entry of plan) {
    if (entry.published === true) continue;
    if (!entry.release_at_utc) continue;
    const releaseAt = new Date(entry.release_at_utc);
    if (Number.isNaN(releaseAt.getTime())) throw new Error(`Invalid release_at_utc for ${entry.match_id}: ${entry.release_at_utc}`);
    if (releaseAt.getTime() > RELEASE_NOW.getTime()) continue;

    const match = makeMatch(entry, RELEASE_NOW);
    const existing = existingById.get(match.id);
    if (existing) {
      Object.assign(existing, match, { actual: existing.actual || match.actual, manual_points: existing.manual_points ?? match.manual_points });
    } else {
      data.knockout_matches.push(match);
      existingById.set(match.id, match);
    }
    entry.published = true;
    entry.published_at_bjt = formatBJT(RELEASE_NOW);
    released.push(match);
  }

  if (!released.length) {
    console.log(`No predictions to publish at ${formatBJT(RELEASE_NOW)}.`);
    return;
  }

  data.knockout_matches.sort((a, b) => String(parseKickoffKey(a)).localeCompare(String(parseKickoffKey(b))));
  const groupText = released.map(m => `${m.home} vs ${m.away}`).join("、");
  data.headline = `淘汰赛预测发布：${groupText}`;
  data.brief = `北京时间 ${formatBJT(RELEASE_NOW)} 已发布 ${released.length} 场淘汰赛预测：${released.map(m => `${m.home} vs ${m.away}`).join("；")}。`;
  data.prediction_release_note = "预测池已录入，但页面只会显示已发布的比赛预测；每天北京时间18:00自动发布次日比赛。";
  data.update_log.push({ time: shortBJT(RELEASE_NOW), text: `发布次日淘汰赛预测：${groupText}。` });
  if (UPDATE_LOG_LIMIT > 0 && data.update_log.length > UPDATE_LOG_LIMIT) data.update_log = data.update_log.slice(-UPDATE_LOG_LIMIT);
  data.meta = data.meta || {};
  data.meta.updated_at = formatBJT(RELEASE_NOW);
  data.meta.version = `prediction-release-${RELEASE_NOW.toISOString().replace(/[-:T.Z]/g, "").slice(0, 12)}`;

  validate(data);
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(`Published ${released.length} prediction(s): ${groupText}`);
}

main();
