// Token Radar — the radar-2 model, written fresh from its specification.
//
// A snapshot of the protocol universe goes in; a ranked board of pre-token
// protocols comes out. The board is the watchlist (the floor, never a
// ceiling) plus every other rankable pre-token protocol the snapshot
// carries, ordered by the implied value the model assigns. Protocols whose
// token already trades are never ranked: the board shows the market's own
// price for them, in a separate live view.
//
// Implied value is a protocol's TVL priced by the market itself. The
// category multiple is the median market-cap-to-TVL ratio of the live-token
// protocols in the same category, measured in this very snapshot, shrunk
// toward the whole-market median when the category is thin, and clamped to
// five cents through one dollar per dollar of TVL. Three further factors
// shape it: a concave weekly-growth factor (one hot week is noisy), a
// maturity factor that rewards running for years with no token, and a
// logarithmic breadth factor for the number of chains. No protocol name is
// ever special-cased; the same arithmetic scores every row, and every
// constant is stated in the dashboard, where the page recomputes each row
// from the same figures.

/** One protocol entry from the sealed snapshot: exactly the ten fields it carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed snapshot document as a whole. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The tunable numbers of the model, as the dashboard states them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  category_multiple_floor: number;
  category_multiple_cap: number;
  min_category_observations: number;
  shrinkage_prior: number;
  breadth_weight: number;
}

/** One step of a farm plan: what to do, what it costs, how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A single row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    category_observations: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A board row in the compact form data.js carries, farm plans built in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  category_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
}

/** A protocol whose token already trades: the board shows the market's value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** One measured category multiple, for the dashboard's model panel. */
export interface CategoryMultipleRow {
  category: string;
  multiple: number;
  observations: number;
  source: 'category' | 'global';
}

/** Everything the dashboard renders: the board, the live set, and the model behind them. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  global_multiple: number;
  category_multiples: CategoryMultipleRow[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** The headline figures: watchlist slugs, board rows, early rows, live protocols. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** The measured multiples: the whole-market median and one entry per measured category. */
export interface CategoryMultiples {
  global: number;
  byCategory: Map<string, { multiple: number; observations: number; source: 'category' | 'global' }>;
}

/** Why a snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The model's constants, as the dashboard states them. */
export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  category_multiple_floor: 0.05,
  category_multiple_cap: 1.0,
  min_category_observations: 3,
  shrinkage_prior: 3,
  breadth_weight: 0.05,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

const MS_PER_DAY = 86_400_000;

/** A finite number, or `fallback` when the value is missing or not a number. */
function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Whole days from `listedAt` to `asOf`, never below zero; null when the
 * listing date is absent or unparsable. Dates are read as UTC midnights so
 * the count does not depend on the machine's timezone.
 */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  const span = Math.floor((end - start) / MS_PER_DAY);
  return span < 0 ? 0 : span;
}

/** A name ending in a release number is a pool of another protocol, not a protocol. */
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** Categories that are a wrapped, staked or bridged product of a token that already trades. */
const WRAPPED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
/** A whole word in a name that marks a wrapped or staked product of a token that already trades. */
const WRAPPED_NAME_WORD = /\b(wrapped|staked|staking)\b/i;
/** Exchange names a protocol name must not begin with. */
const EXCHANGE_NAME_START = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

/** Whether a protocol records no token at all: no market cap, no CoinGecko id, no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  const noMcap = p.mcap_usd === null;
  const noGecko = p.gecko_id === null;
  const noSymbol = p.symbol === null;
  return noMcap && noGecko && noSymbol;
}

/**
 * Whether a protocol is one the board may rank. This is the watchlist's own
 * rule, minus its TVL floor: pre-token, not a wrapped, staked or bridged
 * product of a token that already trades, not an exchange, not a versioned
 * pool. A protocol the list leaves out for being wrapped or staked is no
 * launch: ranking WBTC, Binance staked ETH or USDT0 as a token to come
 * would be ranking Bitcoin, ETH and USDT again. The snapshot carries no
 * parent-protocol field, so the rule runs on the category and the name,
 * exactly as the house's watchlist rule documents them.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (WRAPPED_CATEGORIES.has(p.category ?? '')) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (WRAPPED_NAME_WORD.test(p.name)) return false;
  if (EXCHANGE_NAME_START.test(p.name)) return false;
  return true;
}

/** The snapshot's protocols keyed by slug, for the watchlist lookup. */
function indexBySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  const index = new Map<string, SnapshotProtocol>();
  for (const p of protocols) index.set(p.slug, p);
  return index;
}

/**
 * The middle of a non-empty list: the middle value, or the mean of the two
 * middle ones when the count is even. A median, not a mean, so one outlier
 * token cannot set a category's price.
 */
function middleValue(values: number[]): number {
  const ordered = values.slice().sort((x, y) => x - y);
  const mid = ordered.length >> 1;
  if (ordered.length % 2 === 1) return ordered[mid]!;
  return (ordered[mid - 1]! + ordered[mid]!) / 2;
}

/** Round to four decimals, for the figures the board and the page both show. */
function round4dp(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * What the market pays for a dollar of TVL, by category, measured here, not
 * asserted. For each category with at least `min_category_observations`
 * live-token protocols, the median of their market-cap-to-TVL ratios, shrunk
 * toward the whole market's median by n / (n + prior) and clamped to
 * [floor, cap]. A category too thin to measure, or a protocol with no
 * category at all, takes the global median. Versioned pools are left out of
 * the measurement: a pool is not its category's own market, and its ratio
 * would price the category by another protocol's token.
 */
export function categoryMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): CategoryMultiples {
  const tradable = snapshot.protocols.filter((p) => {
    if (isPreToken(p)) return false;
    if (p.mcap_usd === null) return false;
    if (p.tvl_usd <= 0) return false;
    if (p.category === 'CEX') return false;
    if (VERSION_SUFFIX.test(p.name)) return false;
    return true;
  });
  const ratiosOf = (p: SnapshotProtocol): number => p.mcap_usd! / p.tvl_usd;
  const global = middleValue(tradable.map(ratiosOf));

  const perCategory = new Map<string, number[]>();
  for (const p of tradable) {
    const key = p.category ?? 'Other';
    const bucket = perCategory.get(key);
    if (bucket === undefined) perCategory.set(key, [ratiosOf(p)]);
    else bucket.push(ratiosOf(p));
  }

  const byCategory = new Map<string, { multiple: number; observations: number; source: 'category' | 'global' }>();
  for (const [category, values] of perCategory) {
    const n = values.length;
    if (n < model.min_category_observations) continue;
    const weight = n / (n + model.shrinkage_prior);
    const blended = weight * middleValue(values) + (1 - weight) * global;
    const clamped = Math.min(model.category_multiple_cap, Math.max(model.category_multiple_floor, blended));
    byCategory.set(category, { multiple: clamped, observations: n, source: 'category' });
  }
  return { global, byCategory };
}

/** The multiple one category gets: its measured multiple, or the global median when unmeasured. */
export function multipleFor(
  multiples: CategoryMultiples,
  category: string | null,
): { multiple: number; observations: number; source: 'category' | 'global' } {
  if (category !== null) {
    const measured = multiples.byCategory.get(category);
    if (measured !== undefined) return measured;
  }
  return { multiple: multiples.global, observations: 0, source: 'global' };
}

/** The four multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  multiples: CategoryMultiples,
): {
  implied: number;
  categoryMultiple: number;
  categoryObservations: number;
  categorySource: 'category' | 'global';
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  breadthMult: number;
  age: number | null;
} {
  const age = ageDays(asOf, protocol.listed_at);
  const priced = multipleFor(multiples, protocol.category);

  const rawGrowth = numOr(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  // Concave in the week's change: a single week is noisy, so doubling its
  // gain adds less than double the value, and a collapse costs less than the
  // week's loss in full.
  const growthMult = 1 + model.growth_weight * Math.sign(growthPct) * Math.sqrt(Math.abs(growthPct)) / 10;

  const ageUsed = age ?? model.unknown_age_days;
  const cappedAge = Math.min(Math.max(ageUsed, 0), model.maturity_days);
  const maturityMult = model.maturity_floor + (cappedAge / model.maturity_days) * model.maturity_range;

  // Distribution breadth, logarithmic: more chains reach more users, but the
  // tenth chain adds less than the second.
  const chainCount = Math.max(protocol.chains.length, 1);
  const breadthMult = 1 + model.breadth_weight * Math.log(chainCount);

  const rawValue = protocol.tvl_usd * priced.multiple * growthMult * maturityMult * breadthMult;
  const implied = Math.max(1, Math.round(rawValue));
  return {
    implied,
    categoryMultiple: priced.multiple,
    categoryObservations: priced.observations,
    categorySource: priced.source,
    growthPct,
    growthMult,
    maturityMult,
    breadthMult,
    age,
  };
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const multiples = categoryMultiples(snapshot, model);
  const index = indexBySlug(snapshot.protocols);

  const picked = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer
  // carries (it cannot, but the board's coverage is the gate's row and is
  // never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const found = index.get(slug);
    if (found !== undefined) picked.set(slug, found);
  }
  // The early radar: every other pre-token protocol the snapshot carries,
  // below the watchlist floor or outside the watchlist's categories. Never a
  // replacement for a watchlist row: a chosen protocol stays chosen.
  for (const p of snapshot.protocols) {
    if (picked.has(p.slug)) continue;
    if (!isRankable(p)) continue;
    picked.set(p.slug, p);
  }

  const scored = [...picked.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, model, multiples);
    return { protocol: p, value: v };
  });
  scored.sort((a, b) => b.value.implied - a.value.implied || (a.protocol.slug < b.protocol.slug ? -1 : a.protocol.slug > b.protocol.slug ? 1 : 0));

  return scored.map((s, i) => {
    const p = s.protocol;
    const v = s.value;
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: 'pre-token',
      age_days: v.age,
      implied_value_usd: v.implied,
      model: {
        category_multiple: round4dp(v.categoryMultiple),
        category_observations: v.categoryObservations,
        growth_pct: v.growthPct,
        growth_multiplier: round4dp(v.growthMult),
        maturity_multiplier: round4dp(v.maturityMult),
        breadth_multiplier: round4dp(v.breadthMult),
        age_days: v.age,
      },
      farm_steps: farmSteps(p, v.age).map(stepText),
    };
  });
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  const joined = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (joined.length > 600) return `${joined.slice(0, 596)}...`;
  if (joined.length < 20) return `${joined} Hold the position and check the protocol's own page.`;
  return joined;
}

/** The first chain a protocol names, or a neutral phrase. */
function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  const tvl = p.tvl_usd;
  if (tvl >= 5_000_000_000) return 250;
  if (tvl >= 1_000_000_000) return 150;
  if (tvl >= 100_000_000) return 100;
  return 50;
}

/** About what one transaction costs on the protocol's main chain, in dollars of gas. */
function gasFor(chain: string): number {
  if (chain === 'Ethereum') return 12;
  if (chain === 'Solana') return 1;
  return 4;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** A farm action: the category test, then the sentence it writes. Order is precedence. */
interface FarmAction {
  matches: (category: string) => boolean;
  sentence: (capital: number, name: string, chain: string) => string;
}

/**
 * The category's one action, in the words a farmer can follow. A table, not
 * a chain of branches: the first entry whose test matches wins. 'index' sits
 * before 'dex' because "Indexes" contains "dex", and an index token is not a
 * liquidity pool.
 */
const FARM_ACTIONS: FarmAction[] = [
  {
    matches: (c) => c.includes('lend') || c.includes('cdp') || c.includes('collateral'),
    sentence: (capital, name, chain) => `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`,
  },
  {
    matches: (c) => c.includes('index'),
    sentence: (capital, name, chain) => `Buy $${capital} of the ${name} index token on ${chain} and hold it.`,
  },
  {
    matches: (c) => c.includes('dex') || c.includes('yield') || c.includes('leveraged farm'),
    sentence: (capital, name, chain) => `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`,
  },
  {
    matches: (c) => c.includes('bridge'),
    sentence: (capital, name, chain) => `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`,
  },
  {
    matches: (c) => c.includes('staking') || c.includes('restak'),
    sentence: (capital, name, chain) => `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`,
  },
  {
    matches: (c) => c.includes('perpetual') || c.includes('derivative'),
    sentence: (capital, name, chain) => `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`,
  },
  {
    matches: (c) => c.includes('basis'),
    sentence: (capital, name, chain) => `Open a $${capital} delta-neutral basis position on ${name} on ${chain} and hold both legs.`,
  },
  {
    matches: (c) => c.includes('prediction'),
    sentence: (capital, name, chain) => `Fund $${capital} and place one market position on ${name}.`,
  },
  {
    matches: (c) => c.includes('curator') || c.includes('allocator'),
    sentence: (capital, name, chain) => `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`,
  },
  {
    matches: (c) => c.includes('chain') && !c.includes('onchain'),
    sentence: (capital, name, chain) => `Bridge $${capital} of USDC to ${chain} through ${name} and use its native apps.`,
  },
  {
    matches: (c) => c.includes('payment') || c.includes('card'),
    sentence: (capital, name, chain) => `Spend $${capital} through ${name} on ${chain} and keep the receipts.`,
  },
  {
    matches: (c) => c.includes('otc'),
    sentence: (capital, name, chain) => `Place a $${capital} OTC order through ${name} on ${chain} and settle it.`,
  },
  {
    matches: (c) => c.includes('liquidity manager') || c === 'farm',
    sentence: (capital, name, chain) => `Deposit $${capital} into a ${name} managed position on ${chain} and keep it open.`,
  },
  {
    matches: (c) => c.includes('governance'),
    sentence: (capital, name, chain) => `Lock $${capital} of voting power through ${name} on ${chain} and vote once.`,
  },
  {
    matches: (c) => c.includes('stable'),
    sentence: (capital, name, chain) => `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`,
  },
  {
    matches: (c) => c.includes('rwa'),
    sentence: (capital, name, chain) => `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`,
  },
  {
    matches: (c) => c.includes('insurance'),
    sentence: (capital, name, chain) => `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`,
  },
];

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const category = (p.category ?? '').toLowerCase();
  for (const entry of FARM_ACTIONS) {
    if (entry.matches(category)) return entry.sentence(capital, p.name, chain);
  }
  return `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time.
 * The plan is derived from the protocol's own record (category, chains, TVL,
 * age), never from a hand-written list of names. Gas is priced for the
 * protocol's main chain: Ethereum costs more than a cheap chain, so the same
 * action's cost line says so.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = firstChain(p);
  const capital = capitalFor(p);
  const gas = gasFor(chain);
  const hold = holdDaysFor(age);
  const mainAction = actionFor(p, capital, chain);
  const firstTxCost =
    chain === 'Ethereum' ? 'about $12 of gas for the first transaction' : 'under $3 of gas for the first transaction';
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: firstTxCost,
      time: '5 minutes',
    },
    {
      text: mainAction,
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  const tradable = snapshot.protocols.filter((p) => !isPreToken(p) && p.category !== 'CEX');
  tradable.sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd);
  return tradable.slice(0, LIVE_ROWS).map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd,
    change_7d: p.change_7d,
  }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    category_multiple: row.model.category_multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const multiples = categoryMultiples(snapshot, model);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const categoryRows: CategoryMultipleRow[] = [...multiples.byCategory.entries()]
    // Full precision, not rounded: the page recomputes every row from this
    // table, and a rounded multiple would recompute a different implied value
    // than board.json carries.
    .map(([category, v]) => ({ category, multiple: v.multiple, observations: v.observations, source: v.source }))
    .sort((a, b) => b.observations - a.observations || (a.category < b.category ? -1 : 1));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    global_multiple: multiples.global,
    category_multiples: categoryRows,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const doc = raw as Record<string, unknown>;
  if (typeof doc.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(doc.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof doc.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof doc.floor_usd !== 'number' || !Number.isSafeInteger(doc.floor_usd) || doc.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(doc.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(doc.watchlist) || doc.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols: SnapshotProtocol[] = doc.protocols.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    }
    const p = entry as Record<string, unknown>;
    const hasIdentity =
      typeof p.slug === 'string' && typeof p.name === 'string' && typeof p.tvl_usd === 'number' && Number.isFinite(p.tvl_usd);
    if (!hasIdentity) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    const finiteOrNull = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;
    return {
      slug: p.slug as string,
      name: p.name as string,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd as number,
      change_7d: finiteOrNull(p.change_7d),
      mcap_usd: finiteOrNull(p.mcap_usd),
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: doc.as_of,
    source: doc.source,
    floor_usd: doc.floor_usd,
    protocols,
    watchlist: doc.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const onBoard = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !onBoard.has(s));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} outranks row ${i} on implied value`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
