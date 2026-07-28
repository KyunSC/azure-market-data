/**
 * Time-To-First-Data for the dashboard, with and without the localStorage
 * stale-while-revalidate layer.
 *
 *   node bench/measure_ttfd.mjs --url http://localhost:3000 \
 *        --delays 0,500,2000,10000,60000,163000 --trials 5
 *
 * TTFD = navigation start -> first ticker card showing a real price
 * (`.ticker-card .price` that is not `.unavailable`). That is the moment the
 * user sees data instead of a skeleton, which is what the cold-start claim is
 * actually about.
 *
 * Backend latency is injected with route interception rather than by waiting on
 * a real Render spin-down, so the same cold-start cost can be replayed exactly
 * across both arms and many trials. Sweeping the delay yields TTFD as a
 * function of backend latency; read the curve at the empirically measured
 * cold-start value (see bench/results/render_cold.csv) for the headline number.
 *
 * Arms:
 *   noswr  fresh browser context, empty localStorage -> must await the network
 *   swr    context pre-seeded with a cached payload  -> paints from localStorage
 */
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const argv = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map(s => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')])
)
const URL = argv.url || 'http://localhost:3000'
const DELAYS = (argv.delays || '0,2000,10000,60000,163000').split(',').map(Number)
const TRIALS = Number(argv.trials || 5)
const OUT = argv.out || 'bench/results/ttfd.csv'

const TICKERS = ['ES=F', 'NQ=F', 'SPY', 'QQQ', '^VIX', 'XEQT.TO',
                 'BTC-USD', 'ETH-USD', 'SOL-USD']
const CACHE_KEY = 'marketDataCache:' + TICKERS.join(',')

// Shape mirrors MarketDataResponse so the cached render path is identical to a
// live one -- same components, same formatting work.
const payload = {
  timestamp: '2026-07-22 03:00:00',
  tickers: TICKERS.map((symbol, i) => ({
    symbol, price: 100 + i * 37.5, previousClose: 99 + i * 37.5, volume: 1234567 + i,
  })),
}

const rows = ['arm,delay_ms,trial,ttfd_ms']
const browser = await chromium.launch({ channel: 'chrome' })

for (const delay of DELAYS) {
  for (const arm of ['noswr', 'swr']) {
    for (let t = 1; t <= TRIALS; t++) {
      // A brand-new context per trial: no HTTP cache, no localStorage, no
      // service worker carried over. This is what a first-time visitor gets.
      const ctx = await browser.newContext()

      await ctx.route('**/api/market**', async route => {
        if (delay) await new Promise(r => setTimeout(r, delay))
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(payload),
        })
      })

      if (arm === 'swr') {
        await ctx.addInitScript(([k, p]) => {
          localStorage.setItem(k, JSON.stringify({ payload: p, savedAt: Date.now() }))
        }, [CACHE_KEY, payload])
      }

      const page = await ctx.newPage()
      const started = Date.now()
      await page.goto(URL, { waitUntil: 'commit' })
      let ttfd
      try {
        await page.waitForSelector('.ticker-card .price:not(.unavailable)',
          { timeout: Math.max(delay * 2 + 60000, 90000) })
        ttfd = Date.now() - started
      } catch {
        ttfd = -1
      }
      rows.push(`${arm},${delay},${t},${ttfd}`)
      console.log(`  ${arm.padEnd(6)} delay=${String(delay).padStart(6)}ms ` +
                  `trial ${t}/${TRIALS}  ttfd=${ttfd}ms`)
      await ctx.close()
    }
  }
}

await browser.close()
writeFileSync(OUT, rows.join('\n') + '\n')
console.log(`\nwrote ${OUT}`)

// Median TTFD per (arm, delay), plus the delta the SWR layer buys.
const g = {}
for (const r of rows.slice(1)) {
  const [arm, delay, , ttfd] = r.split(',')
  if (Number(ttfd) < 0) continue
  ;(g[`${delay}|${arm}`] ??= []).push(Number(ttfd))
}
const med = xs => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]
console.log('\ndelay_ms   noswr_p50   swr_p50     saved')
console.log('-'.repeat(44))
for (const delay of DELAYS) {
  const a = g[`${delay}|noswr`], b = g[`${delay}|swr`]
  if (!a || !b) continue
  console.log(`${String(delay).padStart(8)} ${String(med(a) + 'ms').padStart(11)} ` +
              `${String(med(b) + 'ms').padStart(9)} ${String(med(a) - med(b) + 'ms').padStart(9)}`)
}
