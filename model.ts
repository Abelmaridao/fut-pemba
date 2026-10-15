// Modelo estatístico "poisson-v2": puro, sem dependências, testável.
export const MODEL_VERSION = "poisson-v2";
export type Match = { gf: number; ga: number };
export type Input = { home: Match[]; away: Match[] };
const MIN_MATCHES = 5;      // sem isto não se apresenta previsão quantitativa
const SHRINK_K = 5;         // jogos "virtuais" da média da amostra (reduz extremos)
const HOME_ADV = 1.1;       // fator casa: λ_casa × 1.1, λ_fora ÷ 1.1
const HT_SHARE = 0.45;      // fração aproximada dos golos na 1.ª parte
const MIN10_SHARE = 0.10;   // fração aproximada dos golos nos primeiros 10 minutos
const MAXG = 10;

const fact = (n: number) => { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; };
export const pois = (k: number, l: number) => Math.exp(-l) * Math.pow(l, k) / fact(k);
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

function grid(lh: number, la: number) {
  const g: number[][] = []; let tot = 0;
  for (let i = 0; i <= MAXG; i++) { g[i] = []; for (let j = 0; j <= MAXG; j++) { g[i][j] = pois(i, lh) * pois(j, la); tot += g[i][j]; } }
  for (const row of g) for (let j = 0; j <= MAXG; j++) row[j] /= tot; // normaliza a truncagem
  return g;
}
function result1x2(g: number[][]) {
  let h = 0, d = 0, a = 0;
  g.forEach((row, i) => row.forEach((p, j) => { if (i > j) h += p; else if (i === j) d += p; else a += p; }));
  return { home: h, draw: d, away: a };
}

export type Analysis =
  | { ok: false; reason: string }
  | {
    ok: true; model: string;
    lambda: { home: number; away: number };
    result: { home: number; draw: number; away: number };
    totals: Record<string, number>;           // over_0_5 ... under_3_5
    btts: { yes: number; no: number };
    halftime: { home: number; draw: number; away: number };
    teamGoals: { home: Record<string, number>; away: Record<string, number> };
    exactScores: { score: string; p: number }[];
    firstToScore: { home: number; away: number; none: number };
    productiveHalf: { first: number; draw: number; second: number };
    bothHalves: { home: { yes: number; no: number }; away: { yes: number; no: number } };
    reach: { ge3: number; ge4: number; ge5: number; ge6: number };
    min10: { home: number; draw: number; away: number };
    quality: { homeMatches: number; awayMatches: number; level: "baixa" | "razoavel" | "boa" };
  };

export function analyze(inp: Input): Analysis {
  const valid = (m: Match) => Number.isFinite(m.gf) && Number.isFinite(m.ga) && m.gf >= 0 && m.ga >= 0;
  const H = inp.home.filter(valid), A = inp.away.filter(valid);
  if (H.length < MIN_MATCHES || A.length < MIN_MATCHES)
    return { ok: false, reason: `Dados insuficientes: são precisos pelo menos ${MIN_MATCHES} jogos recentes de cada equipa (tem ${H.length} e ${A.length}).` };

  const all = [...H, ...A];
  const mu = Math.max(0.3, all.reduce((s, m) => s + m.gf, 0) / all.length); // média de golos por equipa/jogo na amostra
  const str = (ms: Match[]) => {
    const n = ms.length, gf = ms.reduce((s, m) => s + m.gf, 0), ga = ms.reduce((s, m) => s + m.ga, 0);
    return { att: (gf + SHRINK_K * mu) / (n + SHRINK_K) / mu, def: (ga + SHRINK_K * mu) / (n + SHRINK_K) / mu };
  };
  const h = str(H), a = str(A);
  const lh = clamp(mu * h.att * a.def * HOME_ADV, 0.2, 4.5);
  const la = clamp(mu * a.att * h.def / HOME_ADV, 0.2, 4.5);
  const g = grid(lh, la);

  const total = (k: number, over: boolean) => { let p = 0; g.forEach((r, i) => r.forEach((q, j) => { if ((i + j > k) === over) p += q; })); return p; };
  const totals: Record<string, number> = {};
  for (const k of [0.5, 1.5, 2.5, 3.5]) totals[`over_${String(k).replace(".", "_")}`] = total(k, true);
  for (const k of [1.5, 2.5, 3.5]) totals[`under_${String(k).replace(".", "_")}`] = total(k, false);

  let yes = 0; g.forEach((r, i) => r.forEach((q, j) => { if (i > 0 && j > 0) yes += q; }));
  const tg = (l: number) => { const p0 = pois(0, l), p1 = pois(1, l), p2 = pois(2, l); return { "0": p0, "1": p1, "2": p2, "3+": 1 - p0 - p1 - p2 }; };
  const scores: { score: string; p: number }[] = [];
  g.forEach((r, i) => r.forEach((q, j) => scores.push({ score: `${i}-${j}`, p: q })));
  scores.sort((x, y) => y.p - x.p);
  const none = g[0][0];

  // Parte mais produtiva: golos da 1.ª vs 2.ª parte (Poisson independentes, taxa total × fração da parte)
  const lt = lh + la, h1 = HT_SHARE, h2 = 1 - HT_SHARE;
  let pf = 0, pd = 0, ps = 0, ptot = 0;
  for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) {
    const p = pois(i, lt * h1) * pois(j, lt * h2); ptot += p;
    if (i > j) pf += p; else if (i === j) pd += p; else ps += p;
  }
  // Uma equipa marca nas duas partes: P(≥1 na 1.ª) × P(≥1 na 2.ª)
  const both = (l: number) => { const y = (1 - Math.exp(-l * h1)) * (1 - Math.exp(-l * h2)); return { yes: y, no: 1 - y }; };
  // Alcance de golos: P(total ≥ n)
  const ge = (n: number) => { let p = 0; g.forEach((r, i) => r.forEach((q, j) => { if (i + j >= n) p += q; })); return p; };
  const nm = Math.min(H.length, A.length);

  return {
    ok: true, model: MODEL_VERSION, lambda: { home: lh, away: la },
    result: result1x2(g), totals, btts: { yes, no: 1 - yes },
    halftime: result1x2(grid(lh * HT_SHARE, la * HT_SHARE)),
    teamGoals: { home: tg(lh), away: tg(la) },
    exactScores: scores.slice(0, 5),
    productiveHalf: { first: pf / ptot, draw: pd / ptot, second: ps / ptot },
    bothHalves: { home: both(lh), away: both(la) },
    reach: { ge3: ge(3), ge4: ge(4), ge5: ge(5), ge6: ge(6) },
    min10: result1x2(grid(lh * MIN10_SHARE, la * MIN10_SHARE)),
    firstToScore: { home: (1 - none) * lh / (lh + la), away: (1 - none) * la / (lh + la), none },
    quality: { homeMatches: H.length, awayMatches: A.length, level: nm >= 10 ? "boa" : nm >= 7 ? "razoavel" : "baixa" },
  };
  }
