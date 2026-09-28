/**
 * Prop-firm account presets.
 *
 * Plain data, one array entry per account size, so a rule change is an edit
 * here rather than in the simulator. Every value can also be overridden from
 * the strategy panel: firms reprice often and run promotions, and the
 * published summaries disagree with each other.
 *
 * Lucid Trading, as of Sep 2026. lucidtrading.com blocks automated reads, so
 * these come from third-party summaries — verify before trusting a number:
 *   https://propfirm.compare/propfirm/lucid-trading
 *   https://tradetanto.com/learn/lucid-trading-rules-explained-every-plan-rule-and-limit
 *   https://proptradingvibes.com/blog/lucid-trading-payout-rules
 *
 * Conventions used by `account.js`:
 *   - drawdown 'eod'      threshold = peak end-of-day balance − maxLoss
 *     drawdown 'intraday' threshold = peak intraday equity − maxLoss
 *     Either stops trailing at start + lockOffset, and locks there after the
 *     first payout.
 *   - dailyLossLimit is soft: hitting it flattens you for the rest of the day.
 *   - consistency c: the best day may be at most c × the profit it is judged
 *     against (total profit in an evaluation, cycle profit when funded).
 *   - payoutFraction f: request f × profit above the starting balance.
 *     null: request everything above `buffer`.
 *   - arrays indexed by payout number repeat their last value.
 */

export const PROP_ASOF = 'Sep 2026'

export const SIZES = [
  { id: '25k', label: '25K', balance: 25000 },
  { id: '50k', label: '50K', balance: 50000 },
  { id: '100k', label: '100K', balance: 100000 },
  { id: '150k', label: '150K', balance: 150000 },
]

const STD_MAX_LOSS = [1000, 2000, 3000, 4500]
const STD_MAX_MINIS = [2, 4, 6, 10]
const STD_TARGET = [1250, 3000, 6000, 9000]
const STD_DLL = [600, 1200, 1800, 2700]
const STD_BUFFER = [26100, 52100, 103100, 154600]

export const FIRMS = {
  lucid: {
    id: 'lucid',
    label: 'Lucid Trading',
    url: 'https://lucidtrading.com',
    split: 0.9,
    minPayout: 500,
    lockOffset: 100,
    flatByEt: 16 * 60 + 45,
    plans: {
      flex: {
        id: 'flex',
        label: 'LucidFlex',
        blurb: 'EOD trailing, 50% eval consistency, no funded consistency. Payouts every 5 profitable days.',
        price: [50, 90, 170, 250],
        priceNoDll: [50, 90, 170, 250],
        activationFee: [0, 0, 0, 0],
        maxLoss: STD_MAX_LOSS,
        maxMinis: STD_MAX_MINIS,
        dailyLossLimit: STD_DLL,
        eval: { profitTarget: STD_TARGET, consistency: 0.5, minDays: 2 },
        funded: {
          drawdown: 'eod',
          consistency: 0,
          minDays: 5,
          minProfitDays: 5,
          minDayProfit: [100, 150, 200, 250],
          profitGoal: [0, 0, 0, 0],
          buffer: [0, 0, 0, 0],
          payoutFraction: 0.5,
          payoutCap: [[1000], [2000], [2500], [3000]],
          maxPayouts: 5,
        },
      },
      pro: {
        id: 'pro',
        label: 'LucidPro',
        blurb: 'EOD trailing, no eval consistency, 40% funded consistency, buffer before payouts.',
        price: [90, 115, 180, 245],
        priceNoDll: [90, 115, 180, 245],
        activationFee: [0, 0, 0, 0],
        maxLoss: STD_MAX_LOSS,
        maxMinis: STD_MAX_MINIS,
        dailyLossLimit: [null, 1200, 1800, 2700],
        eval: { profitTarget: STD_TARGET, consistency: 0, minDays: 1 },
        funded: {
          drawdown: 'eod',
          consistency: 0.4,
          minDays: 3,
          minProfitDays: 0,
          minDayProfit: [0, 0, 0, 0],
          profitGoal: [250, 500, 750, 1000],
          buffer: STD_BUFFER,
          payoutFraction: null,
          payoutCap: [[1000, 1500], [2000, 2500], [2500, 3000], [3000, 3500]],
          maxPayouts: 5,
        },
      },
      daily: {
        id: 'daily',
        label: 'LucidDaily',
        blurb: 'Funded drawdown trails intraday. Payout any day above the buffer; news trading not allowed (not modelled).',
        price: [80, 110, 185, 260],
        priceNoDll: [80, 110, 185, 260],
        activationFee: [0, 0, 0, 0],
        maxLoss: STD_MAX_LOSS,
        maxMinis: STD_MAX_MINIS,
        dailyLossLimit: STD_DLL,
        eval: { profitTarget: STD_TARGET, consistency: 0.5, minDays: 2 },
        funded: {
          drawdown: 'intraday',
          consistency: 0,
          minDays: 1,
          minProfitDays: 0,
          minDayProfit: [0, 0, 0, 0],
          profitGoal: [0, 0, 0, 0],
          buffer: STD_BUFFER,
          payoutFraction: null,
          payoutCap: [[null], [null], [null], [null]],
          maxPayouts: 1,
        },
      },
      direct: {
        id: 'direct',
        label: 'LucidDirect',
        blurb: 'Straight to funded — no evaluation. 20% consistency, profit goal and buffer per payout.',
        price: [329, 575, 705, 836],
        priceNoDll: [329, 575, 705, 836],
        activationFee: [0, 0, 0, 0],
        maxLoss: [1000, 2000, 3500, 5000],
        maxMinis: STD_MAX_MINIS,
        dailyLossLimit: [null, 1200, 2100, 3000],
        eval: null,
        funded: {
          drawdown: 'eod',
          consistency: 0.2,
          minDays: 5,
          minProfitDays: 0,
          minDayProfit: [0, 0, 0, 0],
          profitGoal: [[1500, 1500, 1500, 1250], [3000, 3000, 3000, 2500], [6000, 6000, 6000, 3500], [9000, 9000, 9000, 4500]],
          buffer: [26600, 52600, 103600, 155100],
          payoutFraction: null,
          payoutCap: [[1000, 1000, 1000, 1000], [2000, 2000, 2000, 2500], [2500, 2500, 2500, 3000], [3000, 3000, 3000, 3500]],
          maxPayouts: 5,
        },
      },
    },
  },
}

export const FIRM_LIST = Object.values(FIRMS)

const asList = (v) => (Array.isArray(v) ? v : [v])

/**
 * Flat, fully-resolved rules for one account — what the simulator and the UI
 * read. `overrides` uses the same flat keys, so an edited field simply wins.
 */
export function resolvePlan({ firm = 'lucid', plan = 'flex', size = '50k', dll = true, overrides = {} } = {}) {
  const f = FIRMS[firm] || FIRMS.lucid
  const p = f.plans[plan] || Object.values(f.plans)[0]
  const si = Math.max(0, SIZES.findIndex((s) => s.id === size))
  const start = SIZES[si].balance
  const fu = p.funded

  const base = {
    firm: f.id,
    firmLabel: f.label,
    plan: p.id,
    planLabel: p.label,
    size: SIZES[si].id,
    sizeLabel: SIZES[si].label,
    dll: Boolean(dll),
    startBalance: start,
    price: dll ? p.price[si] : p.priceNoDll[si],
    activationFee: p.activationFee[si],
    maxLoss: p.maxLoss[si],
    lockOffset: f.lockOffset,
    maxMinis: p.maxMinis[si],
    dailyLossLimit: dll ? p.dailyLossLimit[si] : null,
    flatByEt: f.flatByEt,
    hasEval: Boolean(p.eval),
    profitTarget: p.eval ? p.eval.profitTarget[si] : 0,
    evalConsistency: p.eval ? p.eval.consistency : 0,
    evalMinDays: p.eval ? p.eval.minDays : 0,
    fundedDrawdown: fu.drawdown,
    fundedConsistency: fu.consistency,
    fundedMinDays: fu.minDays,
    minProfitDays: fu.minProfitDays,
    minDayProfit: fu.minDayProfit[si],
    profitGoal: asList(fu.profitGoal[si]),
    buffer: fu.buffer[si],
    payoutFraction: fu.payoutFraction,
    payoutCap: asList(fu.payoutCap[si]),
    minPayout: f.minPayout,
    split: f.split,
    maxPayouts: fu.maxPayouts,
  }
  const out = { ...base }
  for (const [k, v] of Object.entries(overrides || {})) {
    if (!(k in base) || v === undefined || v === '') continue
    if (Array.isArray(base[k])) out[k] = asList(v)
    else out[k] = v
  }
  out.overridden = Object.keys(overrides || {}).filter((k) => k in base && JSON.stringify(out[k]) !== JSON.stringify(base[k]))
  return out
}

/** Value for payout number `k` (0-based) from a per-payout list. */
export function nth(list, k) {
  if (!list || !list.length) return null
  return list[Math.min(k, list.length - 1)]
}
