import fs from "node:fs";
const KEY = process.env.FOOTBALL_API_KEY, BASE = process.env.FD_BASE || "https://api.football-data.org/v4", GAP = Number(process.env.FD_GAP_MS ?? 6500);
const FILE = "fixtures.json";
const norm = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(path) {
  try {
    const r = await fetch(BASE + path, { headers: { "X-Auth-Token": KEY } });
    await sleep(GAP);
    if (!r.ok) { console.log("aviso:", path, r.status); return null; }
    return await r.json();
  } catch (e) { console.log("aviso:", path, e.message); return null; }
}
try {
  if (!KEY) { console.log("sem FOOTBALL_API_KEY: nada a fazer"); process.exit(0); }
  const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const games = [...(data.matches || []), ...(data.history || [])];
  const comps = [...new Set(games.map(g => g.competition_id).filter(Boolean))];
  const now = new Date(), y = now.getUTCFullYear(), cur = now.getUTCMonth() >= 6 ? y : y - 1;
  const pool = {};
  for (const c of comps) {
    const seasons = c === "BSA" ? [y, y - 1] : [cur, cur - 1];
    pool[c] = [];
    for (const sn of seasons) {
      const j = await get(`/competitions/${c}/matches?season=${sn}&status=FINISHED`);
      for (const m of j?.matches || []) if (m.score?.fullTime?.home != null && !(m.id && pool[c].some(p => p.id === m.id))) pool[c].push(m);
    }
    pool[c].sort((a, b) => Date.parse(b.utcDate) - Date.parse(a.utcDate));
    console.log(c, pool[c].length, "jogos terminados");
  }
  const names = t => [t.name, t.shortName, t.tla].map(norm).filter(Boolean);
  const sameTeam = (t, n) => names(t).includes(norm(n)) || (norm(n).length > 3 && names(t).some(x => x.length > 3 && (x.includes(norm(n)) || norm(n).includes(x))));
  const item = (x, own) => ({ h: x.homeTeam.shortName || x.homeTeam.name, a: x.awayTeam.shortName || x.awayTeam.name, hg: x.score.fullTime.home, ag: x.score.fullTime.away, hl: x.homeTeam.crest, al: x.awayTeam.crest, side: sameTeam(x.homeTeam, own) ? "h" : "a", date: x.utcDate });
  let n = 0;
  for (const g of games) {
    const list = pool[g.competition_id] || [], t = Date.parse(g.kickoff_utc);
    const before = list.filter(x => Date.parse(x.utcDate) < t - 3600e3);
    const form = team => before.filter(x => sameTeam(x.homeTeam, team) || sameTeam(x.awayTeam, team)).slice(0, 5).map(x => item(x, team));
    const h2h = before.filter(x => (sameTeam(x.homeTeam, g.home_team) && sameTeam(x.awayTeam, g.away_team)) || (sameTeam(x.homeTeam, g.away_team) && sameTeam(x.awayTeam, g.home_team))).slice(0, 2).map(x => item(x, g.home_team));
    const recent = { home: form(g.home_team), away: form(g.away_team), h2h };
    if (recent.home.length || recent.away.length || recent.h2h.length) { g.recent = recent; n++; }
  }
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  console.log("recent acrescentado a", n, "de", games.length, "jogos");
} catch (e) { console.log("erro (ignorado):", e.message); }
