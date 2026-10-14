// Atualiza o calendário (fixtures.json) a partir do football-data.org. Corre no GitHub Actions.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { analyze, MODEL_VERSION } from "./model.ts";

// Competições do plano gratuito do football-data.org (código = identificador na API)
export const COMPETITIONS = [
  { id: "CL", name: "UEFA Champions League", country: "Europa" },
  { id: "PL", name: "Premier League", country: "Inglaterra" },
  { id: "ELC", name: "Championship", country: "Inglaterra" },
  { id: "PD", name: "La Liga", country: "Espanha" },
  { id: "BL1", name: "Bundesliga", country: "Alemanha" },
  { id: "SA", name: "Serie A", country: "Itália" },
  { id: "DED", name: "Eredivisie", country: "Países Baixos" },
  { id: "PPL", name: "Primeira Liga", country: "Portugal" },
  { id: "BSA", name: "Brasileirão Série A", country: "Brasil" },
  { id: "FL1", name: "Ligue 1", country: "França" },
];
const BASE = "https://api.football-data.org/v4";
const FINAL = new Set(["FT"]);
const WINDOW_DAYS = 7, FORM_N = 12, H = 3600e3, PACE_MS = 7000; // 10 pedidos/min no plano gratuito

// Estados da API -> códigos usados pelo app
export const STATUS_MAP = { SCHEDULED: "TBD", TIMED: "NS", IN_PLAY: "LIVE", PAUSED: "HT", EXTRA_TIME: "ET",
  PENALTY_SHOOTOUT: "P", FINISHED: "FT", SUSPENDED: "SUSP", POSTPONED: "PST", CANCELLED: "CANC", AWARDED: "AWD" };

export function normalize(x, comp) {
  const status = STATUS_MAP[x.status] ?? x.status;
  return {
    id: String(x.id), competition_id: comp.id,
    competitions: { name: comp.name, country: comp.country },
    home_team_id: x.homeTeam.id, away_team_id: x.awayTeam.id,
    home_team: x.homeTeam.name ?? x.homeTeam.shortName, away_team: x.awayTeam.name ?? x.awayTeam.shortName,
    home_logo: x.homeTeam.crest ?? null, away_logo: x.awayTeam.crest ?? null,
    kickoff_utc: new Date(x.utcDate).toISOString(),
    time_confirmed: status !== "TBD",
    status,
    home_goals: x.score?.fullTime?.home ?? null, away_goals: x.score?.fullTime?.away ?? null,
  };
}

const TRACK = ["kickoff_utc", "time_confirmed", "status", "home_goals", "away_goals"];

// results: [{comp, ok, fixtures?: normalized[], error?}]
export function buildData({ prev, results, now = new Date(), windowDays = WINDOW_DAYS }) {
  const t = now.getTime(), start = t - 24 * H, end = t + windowDays * 86400e3;
  const prevById = new Map((prev?.matches ?? []).map((m) => [m.id, m]));
  const okIds = new Set(results.filter((r) => r.ok).map((r) => r.comp.id));

  // Forma recente por equipa (IDs de equipa são globais): só jogos terminados
  const form = new Map();
  for (const r of results) if (r.ok) for (const f of r.fixtures) {
    if (!FINAL.has(f.status) || f.home_goals == null || f.away_goals == null) continue;
    const d = Date.parse(f.kickoff_utc);
    (form.get(f.home_team_id) ?? form.set(f.home_team_id, []).get(f.home_team_id)).push({ d, gf: f.home_goals, ga: f.away_goals });
    (form.get(f.away_team_id) ?? form.set(f.away_team_id, []).get(f.away_team_id)).push({ d, gf: f.away_goals, ga: f.home_goals });
  }
  const last = (id) => (form.get(id) ?? []).sort((a, b) => b.d - a.d).slice(0, FORM_N).map(({ gf, ga }) => ({ gf, ga }));

  const matches = [], changes = [];
  const seen = new Set();
  for (const r of results) if (r.ok) for (const f of r.fixtures) {
    const k = Date.parse(f.kickoff_utc);
    if (!(k >= start && k <= end) || seen.has(f.id)) continue;
    seen.add(f.id);
    const old = prevById.get(f.id);
    if (old) for (const fld of TRACK) {
      const a = old[fld] ?? null, b = f[fld] ?? null;
      const same = a === b || (fld === "kickoff_utc" && Date.parse(a) === Date.parse(b));
      if (!same) changes.push({ id: f.id, match: `${f.home_team} vs ${f.away_team}`, field: fld, old: a, new: b, at: now.toISOString() });
    }
    let analysis = null, analysis_note = null;
    if (["NS", "TBD"].includes(f.status)) {
      const res = analyze({ home: last(f.home_team_id), away: last(f.away_team_id) });
      if (res.ok) analysis = { model_version: MODEL_VERSION, created_at: now.toISOString(), result: res };
      else analysis_note = res.reason;
    }
    matches.push({ ...f, analysis, analysis_note, updated_at: now.toISOString(), source: "football-data.org" });
  }
  // Ligas que falharam: mantém o que já estava guardado (nunca apaga por falha)
  for (const m of prev?.matches ?? []) {
    if (okIds.has(m.competition_id) || seen.has(m.id)) continue;
    if (Date.parse(m.kickoff_utc) >= start) matches.push({ ...m, stale: true });
  }
  matches.sort((a, b) => a.kickoff_utc.localeCompare(b.kickoff_utc));
  const anyOk = okIds.size > 0;
  return {
    generatedAt: now.toISOString(),
    lastSuccessAt: anyOk ? now.toISOString() : prev?.lastSuccessAt ?? null,
    windowDays,
    leagues: results.map((r) => ({ id: r.comp.id, name: r.comp.name, ok: r.ok, count: r.ok ? r.fixtures.filter((f) => seen.has(f.id)).length : 0, error: r.error ?? null })),
    matches,
    changes: [...(prev?.changes ?? []), ...changes].slice(-200),
  };
}

async function fetchLeague(comp, key, sleep) {
  const url = `${BASE}/competitions/${comp.id}/matches`;
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(url, { headers: { "X-Auth-Token": key } });
      if (r.status === 429) return { limit: true };
      if (!r.ok) {
        let msg = ""; try { msg = (await r.json()).message ?? ""; } catch {}
        throw new Error(`HTTP ${r.status} ${msg}`.trim());
      }
      const j = await r.json();
      return { fixtures: (j.matches ?? []).map((x) => normalize(x, comp)) };
    } catch (e) { lastErr = e; if (i < 3) await sleep(1000 * 2 ** (i - 1)); }
  }
  throw lastErr;
}

export async function main({ key = process.env.FOOTBALL_API_KEY, now = new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), file = "fixtures.json", paceMs = PACE_MS } = {}) {
  if (!key) throw new Error("Falta o segredo FOOTBALL_API_KEY.");
  let prev = null;
  try { prev = JSON.parse(await readFile(file, "utf8")); } catch {}
  const results = []; let stop = false, first = true;
  for (const comp of COMPETITIONS) {
    if (stop) { results.push({ comp, ok: false, error: "ignorada: limite de pedidos da API" }); continue; }
    if (!first) await sleep(paceMs); // respeita o limite de pedidos por minuto
    first = false;
    try {
      const r = await fetchLeague(comp, key, sleep);
      if (r.limit) { stop = true; results.push({ comp, ok: false, error: "limite de pedidos da API atingido" }); continue; }
      results.push({ comp, ok: true, fixtures: r.fixtures });
    } catch (e) { results.push({ comp, ok: false, error: String(e.message ?? e) }); }
  }
  const data = buildData({ prev, results, now });
  await writeFile(file, JSON.stringify(data));
  const bad = data.leagues.filter((l) => !l.ok);
  console.log(`Jogos: ${data.matches.length} | ligas com erro: ${bad.length}`);
  bad.forEach((l) => console.log(` - ${l.name}: ${l.error}`));
  if (!results.some((r) => r.ok)) process.exitCode = 1; // nenhuma liga atualizada: falha visível no Actions
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
