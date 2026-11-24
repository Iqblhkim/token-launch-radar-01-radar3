// Token Radar model radar-3: every number on the board comes from the snapshot or from a
// stated assumption. Node 22, standard library only, no randomness, no clock: two runs write
// the same bytes.
//
// Value model: ln(market cap) of the protocols whose token trades is regressed on ln(TVL), then
// each extra term (7-day growth, years without a token, chain count, category) is tried and kept
// only if it lowers the held-out miss twice: leave-one-out and walk-forward (older listings
// predict newer ones). Token odds come from the peers' record, tested the same way (Brier).
// Farm verdicts price a plan with stated assumptions, which the dashboard lets a reader change.

export interface Protocol {
  slug: string; name: string; category: string | null; chains: string[]; tvl_usd: number;
  change_7d: number | null; mcap_usd: number | null; listed_at: string | null;
  gecko_id: string | null; symbol: string | null;
}
export interface Snapshot { as_of: string; source: string; floor_usd: number; protocols: Protocol[]; watchlist: string[] }

export function parseSnapshot(text: string): Snapshot {
  const s = JSON.parse(text) as Snapshot;
  if (!Array.isArray(s.protocols) || !Array.isArray(s.watchlist) || typeof s.floor_usd !== 'number') throw new Error('snapshot: protocols, watchlist and floor_usd are required');
  return s;
}

// ---------- small numeric helpers ----------
const ln = Math.log;
function median(a: number[]): number { const s = [...a].sort((x, y) => x - y); const n = s.length; return n === 0 ? NaN : n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2; }
function quantile(a: number[], q: number): number { const s = [...a].sort((x, y) => x - y); if (s.length === 0) return NaN; const p = (s.length - 1) * q; const lo = Math.floor(p); const hi = Math.ceil(p); return s[lo]! + (s[hi]! - s[lo]!) * (p - lo); }
function mean(a: number[]): number { return a.reduce((x, y) => x + y, 0) / a.length; }
function round(x: number, d = 4): number { const m = 10 ** d; return Math.round(x * m) / m; }

/** Ridge least squares (intercept unpenalised) by Gaussian elimination: deterministic. */
function ridge(X: number[][], y: number[], lambda = 1e-6): number[] {
  const p = X[0]!.length; const A: number[][] = Array.from({ length: p }, () => new Array<number>(p + 1).fill(0));
  for (let r = 0; r < X.length; r++) for (let i = 0; i < p; i++) { for (let j = 0; j < p; j++) A[i]![j]! += X[r]![i]! * X[r]![j]!; A[i]![p]! += X[r]![i]! * y[r]!; }
  for (let i = 1; i < p; i++) A[i]![i]! += lambda * X.length;
  for (let c = 0; c < p; c++) {
    let piv = c; for (let r = c + 1; r < p; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r;
    [A[c], A[piv]] = [A[piv]!, A[c]!];
    const d = A[c]![c]!; if (Math.abs(d) < 1e-12) continue;
    for (let j = c; j <= p; j++) A[c]![j]! /= d;
    for (let r = 0; r < p; r++) if (r !== c) { const f = A[r]![c]!; if (f !== 0) for (let j = c; j <= p; j++) A[r]![j]! -= f * A[c]![j]!; }
  }
  return A.map((row) => row[p]!);
}

// ---------- classification: the house rule, restated from the snapshot's own fields ----------
const EXCLUDED_CATEGORY = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIX = /^(binance|coinbase|bybit|kraken|bitget|okx|bitfinex|gemini)/i;
const VERSION_END = /\s(?:v\d+|\d+\.\d+)$/i;
const WRAPPED_WORD = /\b(?:wrapped|staked|staking)\b/i;

export type Group = 'ranked' | 'trades' | 'token_no_mcap' | 'set_aside';
function setAsideReason(p: Protocol): string | null {
  if (p.category !== null && EXCLUDED_CATEGORY.has(p.category)) return `category ${p.category}`;
  if (EXCHANGE_PREFIX.test(p.name)) return 'exchange product';
  if (VERSION_END.test(p.name)) return 'versioned pool';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped or staked product';
  return null;
}
const noToken = (p: Protocol): boolean => p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
const trades = (p: Protocol): boolean => p.mcap_usd !== null && p.mcap_usd > 0;

function ageDays(p: Protocol, asOf: string): number | null {
  if (p.listed_at === null) return null;
  const d = (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${p.listed_at}T00:00:00Z`)) / 86_400_000;
  return d >= 1 ? Math.round(d) : null;
}

// ---------- value model ----------
type Term = 'growth' | 'age' | 'chains' | 'category';
const TERMS: Term[] = ['growth', 'age', 'chains', 'category'];
interface Obs { p: Protocol; y: number; lt: number; g: number; la: number; lc: number; cat: string; listed: number; }
function obs(p: Protocol, asOf: string): Obs | null {
  const a = ageDays(p, asOf); if (!trades(p) || p.tvl_usd <= 0 || a === null) return null;
  return { p, y: ln(p.mcap_usd!), lt: ln(p.tvl_usd), g: Math.max(-50, Math.min(100, p.change_7d ?? 0)) / 100, la: ln(a), lc: ln(1 + p.chains.length), cat: p.category ?? 'none', listed: Date.parse(p.listed_at!) };
}
function row(o: { lt: number; g: number; la: number; lc: number }, terms: Term[]): number[] {
  const r = [1, o.lt];
  if (terms.includes('growth')) r.push(o.g);
  if (terms.includes('age')) r.push(o.la);
  if (terms.includes('chains')) r.push(o.lc);
  return r;
}
interface Fit { b: number[]; terms: Term[]; adj: Map<string, number> }
function fit(train: Obs[], terms: Term[]): Fit {
  const X = train.map((o) => row(o, terms)); const y = train.map((o) => o.y);
  const b = ridge(X, y); const adj = new Map<string, number>();
  if (terms.includes('category')) {
    const sums = new Map<string, [number, number]>();
    train.forEach((o, i) => { const e = X[i]!.reduce((s, v, j) => s + v * b[j]!, 0); const [s, n] = sums.get(o.cat) ?? [0, 0]; sums.set(o.cat, [s + (o.y - e), n + 1]); });
    for (const [c, [s, n]] of [...sums.entries()].sort((a, z) => (a[0] < z[0] ? -1 : 1))) adj.set(c, s / (n + 4));
  }
  return { b, terms, adj };
}
function predict(f: Fit, o: { lt: number; g: number; la: number; lc: number; cat: string }): number {
  return row(o, f.terms).reduce((s, v, j) => s + v * f.b[j]!, 0) + (f.adj.get(o.cat) ?? 0);
}
interface Score { loo: number; wf: number; looMean: number; wfMean: number; looRes: number[] }
function score(data: Obs[], terms: Term[]): Score {
  const res: number[] = [];
  for (let i = 0; i < data.length; i++) res.push(data[i]!.y - predict(fit(data.filter((_, j) => j !== i), terms), data[i]!));
  const order = [...data].sort((a, z) => a.listed - z.listed || (a.p.slug < z.p.slug ? -1 : 1)); const wres: number[] = [];
  for (let i = Math.floor(order.length / 3); i < order.length; i++) wres.push(order[i]!.y - predict(fit(order.slice(0, i), terms), order[i]!));
  const ab = (a: number[]) => a.map(Math.abs);
  return { loo: Math.exp(median(ab(res))), wf: Math.exp(median(ab(wres))), looMean: Math.exp(mean(ab(res))), wfMean: Math.exp(mean(ab(wres))), looRes: res };
}
function scoreConst(data: Obs[]): { loo: number; wf: number } {
  const lm = (rows: Obs[]) => median(rows.map((o) => o.y - o.lt));
  const res = data.map((o, i) => o.y - o.lt - lm(data.filter((_, j) => j !== i)));
  const order = [...data].sort((a, z) => a.listed - z.listed || (a.p.slug < z.p.slug ? -1 : 1)); const w: number[] = [];
  for (let i = Math.floor(order.length / 3); i < order.length; i++) w.push(order[i]!.y - order[i]!.lt - lm(order.slice(0, i)));
  return { loo: Math.exp(median(res.map(Math.abs))), wf: Math.exp(median(w.map(Math.abs))) };
}
export interface TermRow { term: string; loo: number; wf: number; verdict: 'kept' | 'tested, not kept' | 'baseline' }

// ---------- token odds (logistic on the peers' record) ----------
function logistic(X: number[][], y: number[], iters = 25): number[] {
  const p = X[0]!.length; let b = new Array<number>(p).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array<number>(p).fill(0); const H: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
    for (let r = 0; r < X.length; r++) {
      const z = X[r]!.reduce((s, v, j) => s + v * b[j]!, 0); const pr = 1 / (1 + Math.exp(-z)); const w = pr * (1 - pr) + 1e-9;
      for (let i = 0; i < p; i++) { g[i]! += (y[r]! - pr) * X[r]![i]!; for (let j = 0; j < p; j++) H[i]![j]! += w * X[r]![i]! * X[r]![j]!; }
    }
    for (let i = 1; i < p; i++) { H[i]![i]! += 0.5; g[i]! -= 0.5 * b[i]!; }
    const step = ridge(H.map((r) => [...r]), g, 0); // solve H s = g via the same elimination
    b = b.map((v, i) => v + step[i]!);
  }
  return b;
}
const sig = (z: number): number => 1 / (1 + Math.exp(-z));

// ---------- farm economics: stated assumptions, editable on the page ----------
export const ASSUMPTIONS = { deposit_usd: 1000, horizon_weeks: 12, airdrop_share: 0.3, apy: 0.045 };
const GAS_USD: Record<string, number> = { Ethereum: 6, Base: 0.1, Arbitrum: 0.25, Optimism: 0.1, Polygon: 0.05, Solana: 0.01, Binance: 0.3, Avalanche: 0.3, Mantle: 0.1, Linea: 0.2, Scroll: 0.2, Sonic: 0.05, 'zkSync Era': 0.2, Plasma: 0.05, Monad: 0.05, Hyperliquid: 0.05 };
function cheapestChain(p: Protocol): { chain: string; gas: number } {
  let best = { chain: p.chains[0] ?? 'Ethereum', gas: GAS_USD[p.chains[0] ?? 'Ethereum'] ?? 0.5 };
  for (const c of p.chains) { const g = GAS_USD[c] ?? 0.5; if (g < best.gas) best = { chain: c, gas: g }; }
  return best;
}
export function farmMath(implied: number, odds: number, tvl: number, gas: number, a = ASSUMPTIONS) {
  const txs = 6 + a.horizon_weeks;
  const gasCost = txs * gas; const carry = a.deposit_usd * a.apy * a.horizon_weeks / 52;
  // The airdrop pool (odds x implied x share) is split among active farmers.
  // The farmer count grows sublinearly with TVL (sqrt): airdrop farming rewards
  // activity and points, not a strict share of total TVL, so a $1,000 deposit in
  // a $2.7B protocol is still an active farmer, not a 0.00004% owner. A farmer's
  // weight scales with deposit relative to the $1,000 reference deposit.
  const farmers = 2500 * Math.sqrt(Math.max(1, tvl / 1e6));
  const reward = odds * implied * a.airdrop_share / farmers * (a.deposit_usd / 1000);
  const net = reward - gasCost - carry; const hours = (20 + 10 * a.horizon_weeks + 15) / 60;
  const verdict = net >= Math.max(25, 0.03 * a.deposit_usd) ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP';
  return { txs, gas_cost: gasCost, carry, reward, net, hours, net_per_hour: net / hours, verdict };
}
const ACTION: Record<string, string> = {
  Lending: 'Supply the stablecoin side of a market and keep the receipt token',
  Dexs: 'Add liquidity to the deepest pool in a range you can leave alone',
  Yield: 'Deposit into the main vault and keep the shares',
  'Yield Aggregator': 'Deposit into the main vault and keep the shares',
  'Risk Curators': 'Deposit into one curated vault and keep the shares',
  'Onchain Capital Allocator': 'Deposit into one managed vault and keep the shares',
  RWA: 'Mint or buy the protocol\'s tokenised asset in the smallest allowed size and hold it',
  CDP: 'Open a position at a safe collateral ratio and mint a small amount of its stablecoin',
  Derivatives: 'Open a small position and trade the same size a few times a week',
  'Basis Trading': 'Deposit into the basis vault and keep the shares',
};
function farmSteps(p: Protocol, f: ReturnType<typeof farmMath>, chain: string, gas: number, a = ASSUMPTIONS): string[] {
  const act = ACTION[p.category ?? ''] ?? 'Use the protocol\'s main product in the smallest size it allows and keep the position open';
  const g = (n: number) => `$${(n * gas).toFixed(n * gas < 1 ? 2 : 0)}`;
  return [
    `Use a fresh wallet that holds only the farm funds, and keep its seed phrase offline. Cost: ${g(1)} of gas for the first transaction on ${chain}. Time: 5 minutes.`,
    `${act} on ${chain}: ${p.name}. Put in $${a.deposit_usd.toLocaleString('en-US')}, or less if its minimum is lower. Cost: the deposit stays yours, plus about ${g(3)} of gas to set up. Time: 20 minutes.`,
    `Every week, use the product once more (add, rebalance or trade a little) so the wallet shows steady use. Cost: about ${g(1)} of gas a week, ${g(a.horizon_weeks)} over ${a.horizon_weeks} weeks. Time: 10 minutes a week.`,
    `Hold the position for the ${a.horizon_weeks} weeks so it counts in more than one snapshot of activity. Cost: about $${f.carry.toFixed(0)} of lost interest at ${(a.apy * 100).toFixed(1)}% a year. Time: ${a.horizon_weeks} weeks.`,
    `Check the protocol's own points or rewards page each month and its TVL: if TVL falls more than 30% below today's $${(p.tvl_usd / 1e6).toFixed(0)}M or your points stop growing, unwind. Cost: no fee to check. Time: 10 minutes a month.`,
    `Claim only from the link the protocol itself publishes, and never pay to claim. Close the position when you are done. Cost: about ${g(2)} of gas to exit. Time: 15 minutes.`,
    `Expected result at the stated assumptions: about $${f.reward.toFixed(0)} of reward against $${(f.gas_cost + f.carry).toFixed(0)} of costs, a net of ${f.net >= 0 ? '' : '-'}$${Math.abs(f.net).toFixed(0)}, so the verdict is ${f.verdict}. Cost: nothing to read. Time: 2 minutes.`,
  ];
}

// ---------- the radar ----------
export interface BoardRow {
  rank: number; slug: string; name: string; category: string | null; chains: string[]; tvl_usd: number; change_7d: number | null;
  mcap_usd: number | null; listed_at: string | null; gecko_id: string | null; symbol: string | null; token_status: string; age_days: number | null;
  implied_value_usd: number; implied_low_usd: number; implied_high_usd: number; token_odds: number; on_watchlist: boolean;
  model: { predicted_ln: number; terms: Record<string, number> };
  farm: { chain: string; gas_usd: number; reward_usd: number; cost_usd: number; net_usd: number; net_per_hour: number; verdict: string };
  farm_steps: string[];
}
export interface Radar {
  as_of: string; model_name: string; n_fit: number; n_age: number; coefficients: Record<string, number>; terms: TermRow[];
  final_terms: string[]; miss: { loo: number; wf: number; baseline_loo: number; baseline_wf: number };
  coverage: { p25_p75: number; p10_p90: number };
  odds: { n: number; base_rate: number; rows: { model: string; loo_brier: number; wf_brier: number; verdict: string }[]; chosen: string; coef: number[] };
  assumptions: typeof ASSUMPTIONS; accounting: Record<string, number>; set_aside: Record<string, number>;
  early_size: number; live_size: number; watchlist_size: number; total_implied_usd: number;
  live: { slug: string; name: string; category: string | null; tvl_usd: number; mcap_usd: number }[];
  verdicts: Record<string, number>; checksum: string;
}

export function buildRadar(snap: Snapshot): { board: BoardRow[]; radar: Radar } {
  const P = [...snap.protocols].sort((a, z) => (a.slug < z.slug ? -1 : 1));
  const watch = new Set(snap.watchlist);
  // 1) value model on the traded protocols
  const data = P.map((p) => obs(p, snap.as_of)).filter((o): o is Obs => o !== null);
  const base = score(data, []); const cm = scoreConst(data);
  const terms: TermRow[] = [{ term: 'one fixed multiple of TVL', loo: round(cm.loo, 3), wf: round(cm.wf, 3), verdict: 'baseline' }, { term: 'TVL, fitted exponent', loo: round(base.loo, 3), wf: round(base.wf, 3), verdict: 'kept' }];
  const alone = new Map<Term, Score>();
  for (const t of TERMS) { const s = score(data, [t]); alone.set(t, s); }
  let chosen: Term[] = []; let cur = base;
  for (let round_ = 0; round_ < TERMS.length; round_++) {
    let best: { t: Term; s: Score } | null = null;
    for (const t of TERMS) if (!chosen.includes(t)) { const s = score(data, [...chosen, t]); if (s.loo < cur.loo * 0.985 && s.wf < cur.wf * 0.985 && (best === null || s.loo * s.wf < best.s.loo * best.s.wf)) best = { t, s }; }
    if (best === null) break; chosen = [...chosen, best.t]; cur = best.s;
  }
  for (const t of TERMS) { const s = alone.get(t)!; terms.push({ term: t, loo: round(s.loo, 3), wf: round(s.wf, 3), verdict: chosen.includes(t) ? 'kept' : 'tested, not kept' }); }
  const final = fit(data, chosen);
  const res = cur.looRes; const shift = median(res);
  const lo = (i: number) => quantile(res.filter((_, j) => j !== i), 0.25); const hi = (i: number) => quantile(res.filter((_, j) => j !== i), 0.75);
  const lo10 = (i: number) => quantile(res.filter((_, j) => j !== i), 0.1); const hi10 = (i: number) => quantile(res.filter((_, j) => j !== i), 0.9);
  const cov = (l: (i: number) => number, h: (i: number) => number) => mean(res.map((r, i) => (r >= l(i) && r <= h(i) ? 1 : 0)));
  const qLo = quantile(res, 0.25) - shift; const qHi = quantile(res, 0.75) - shift;

  // 2) token odds from the peers' record
  const peers = P.filter((p) => setAsideReason(p) === null && ageDays(p, snap.as_of) !== null && p.tvl_usd > 0);
  const lab = (p: Protocol) => (trades(p) || p.gecko_id !== null ? 1 : 0);
  const feats = (p: Protocol, kind: string): number[] => kind === 'base rate' ? [1] : kind === 'age' ? [1, ln(ageDays(p, snap.as_of)!)] : kind === 'tvl' ? [1, ln(p.tvl_usd)] : [1, ln(ageDays(p, snap.as_of)!), ln(p.tvl_usd)];
  const kinds = ['base rate', 'age', 'tvl', 'age + tvl'];
  const brier = (kind: string, walk: boolean): number => {
    const idx = peers.map((_, i) => i); const ord = [...idx].sort((a, z) => Date.parse(peers[a]!.listed_at!) - Date.parse(peers[z]!.listed_at!) || a - z);
    const test = walk ? ord.slice(Math.floor(ord.length / 3)) : idx; let s = 0;
    for (const i of test) {
      const train = walk ? ord.slice(0, ord.indexOf(i)) : idx.filter((j) => j !== i);
      const b = logistic(train.map((j) => feats(peers[j]!, kind)), train.map((j) => lab(peers[j]!)));
      s += (sig(feats(peers[i]!, kind).reduce((a, v, j) => a + v * b[j]!, 0)) - lab(peers[i]!)) ** 2;
    }
    return s / test.length;
  };
  const baseRate = mean(peers.map(lab));
  const oddsRows = kinds.map((k) => ({ model: k, loo_brier: round(brier(k, false), 4), wf_brier: round(brier(k, true), 4), verdict: '' }));
  const b0 = oddsRows[0]!; let pick = b0;
  for (const r of oddsRows.slice(1)) if (r.loo_brier < pick.loo_brier * 0.99 && r.wf_brier < pick.wf_brier * 0.99) pick = r;
  for (const r of oddsRows) r.verdict = r === pick ? 'kept' : r === b0 ? 'baseline' : 'tested, not kept';
  const oddsB = logistic(peers.map((p) => feats(p, pick.model)), peers.map(lab));
  const odds = (p: Protocol): number => { const a = ageDays(p, snap.as_of); if (a === null && pick.model.includes('age')) return Math.min(0.97, Math.max(0.03, baseRate)); const f = feats(p, pick.model); return Math.min(0.97, Math.max(0.03, sig(f.reduce((s, v, j) => s + v * (oddsB[j] ?? 0), 0)))); };

  // 3) rows: every ranked pre-token protocol
  const acct: Record<string, number> = { ranked: 0, trades: 0, token_no_mcap: 0, set_aside: 0 }; const setAside: Record<string, number> = {};
  const live: Radar['live'] = []; const rows: Omit<BoardRow, 'rank'>[] = []; const medAge = ln(median(P.map((p) => ageDays(p, snap.as_of)).filter((a): a is number => a !== null)));
  for (const p of P) {
    if (trades(p)) { acct.trades!++; live.push({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd! }); continue; }
    if (!noToken(p)) { acct.token_no_mcap!++; continue; }
    const why = setAsideReason(p);
    if (why !== null) { acct.set_aside!++; setAside[why] = (setAside[why] ?? 0) + 1; continue; }
    acct.ranked!++;
    const a = ageDays(p, snap.as_of); const o = { lt: ln(Math.max(1, p.tvl_usd)), g: Math.max(-50, Math.min(100, p.change_7d ?? 0)) / 100, la: a === null ? medAge : ln(a), lc: ln(1 + p.chains.length), cat: p.category ?? 'none' };
    const pred = predict(final, o) + shift; const v = Math.max(1, Math.round(Math.exp(pred)));
    const od = odds(p); const { chain, gas } = cheapestChain(p); const fm = farmMath(v, od, p.tvl_usd, gas);
    const contrib: Record<string, number> = { tvl: round(final.b[1]! * o.lt, 3) };
    if (chosen.includes('growth')) contrib.growth = round(final.b[2]! * o.g, 3);
    rows.push({
      slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, change_7d: p.change_7d, mcap_usd: null, listed_at: p.listed_at, gecko_id: null, symbol: null,
      token_status: 'pre-token', age_days: a, implied_value_usd: v, implied_low_usd: Math.max(1, Math.round(Math.exp(pred + qLo))), implied_high_usd: Math.round(Math.exp(pred + qHi)), token_odds: round(od, 3), on_watchlist: watch.has(p.slug),
      model: { predicted_ln: round(pred, 4), terms: contrib }, farm: { chain, gas_usd: gas, reward_usd: round(fm.reward, 2), cost_usd: round(fm.gas_cost + fm.carry, 2), net_usd: round(fm.net, 2), net_per_hour: round(fm.net_per_hour, 2), verdict: fm.verdict },
      farm_steps: farmSteps(p, fm, chain, gas),
    });
  }
  rows.sort((a, z) => z.implied_value_usd - a.implied_value_usd || (a.slug < z.slug ? -1 : 1));
  const board: BoardRow[] = rows.map((r, i) => ({ rank: i + 1, ...r }));
  const verdicts: Record<string, number> = { FARM: 0, MARGINAL: 0, SKIP: 0 }; for (const r of board) verdicts[r.farm.verdict]!++;
  let h = 2166136261; for (const r of board) for (const ch of `${r.rank}|${r.slug}|${r.implied_value_usd}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const coefNames = ['intercept', 'ln_tvl', ...(chosen.includes('growth') ? ['growth_7d'] : []), ...(chosen.includes('age') ? ['ln_age'] : []), ...(chosen.includes('chains') ? ['ln_chains'] : [])];
  const radar: Radar = {
    as_of: snap.as_of, model_name: 'radar-3', n_fit: data.length, n_age: data.length,
    coefficients: Object.fromEntries(coefNames.map((n, i) => [n, round(final.b[i]!, 4)])), terms, final_terms: ['ln_tvl', ...chosen],
    miss: { loo: round(cur.loo, 3), wf: round(cur.wf, 3), baseline_loo: round(cm.loo, 3), baseline_wf: round(cm.wf, 3) },
    coverage: { p25_p75: round(cov(lo, hi), 3), p10_p90: round(cov(lo10, hi10), 3) },
    odds: { n: peers.length, base_rate: round(baseRate, 3), rows: oddsRows, chosen: pick.model, coef: oddsB.map((x) => round(x, 4)) },
    assumptions: ASSUMPTIONS, accounting: { total: P.length, ...acct }, set_aside: setAside,
    early_size: board.filter((r) => !r.on_watchlist).length, live_size: acct.trades!, watchlist_size: snap.watchlist.length,
    total_implied_usd: board.reduce((s, r) => s + r.implied_value_usd, 0), live: live.sort((a, z) => z.mcap_usd - a.mcap_usd), verdicts, checksum: h.toString(16).padStart(8, '0'),
  };
  return { board, radar };
}

/** The gate's own checks on a board, restated: null when it passes. */
export function boardIssue(board: BoardRow[], snap: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `${board.length} rows, need 100 to 4000`;
  const known = new Set(snap.protocols.map((p) => p.slug)); const seen = new Set<string>();
  for (let i = 0; i < board.length; i++) {
    const r = board[i]!;
    if (!known.has(r.slug) || seen.has(r.slug)) return `row ${i + 1}: slug ${r.slug} is invented or repeated`; seen.add(r.slug);
    if (r.rank !== i + 1) return `row ${i + 1}: rank ${r.rank}`;
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd < 1 || r.implied_value_usd > 1e14) return `row ${i + 1}: implied value`;
    if (i > 0 && r.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1}: value rises`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12 || r.farm_steps.some((s) => s.trim().length < 20 || s.trim().length > 600)) return `row ${i + 1}: farm_steps`;
  }
  for (const s of snap.watchlist) if (!seen.has(s)) return `watchlist slug ${s} missing`;
  if (new Set(board.map((r) => r.implied_value_usd)).size < 2) return 'all values equal';
  return null;
}

export function dataScript(radar: Radar, board: BoardRow[] = []): string {
  return `window.RADAR = ${JSON.stringify({ radar, rows: board })};\n`;
}
