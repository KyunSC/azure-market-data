/**
 * CME equity-index futures the prop mode can trade.
 *
 * Research datasets are ETF bars (QQQ, SPY) because that is where the
 * historical GEX lives. Prop mode prices them as futures by scaling with the
 * ETF→futures conversion ratio — the same ratio the GEX calculator uses to put
 * QQQ strikes on the NQ chart. That ignores basis drift and rolls, which is
 * why the UI labels it a proxy. Live-plane `NQ=F` / `ES=F` bars need no scale.
 */

export const CONTRACTS = {
  NQ: { id: 'NQ', label: 'NQ (E-mini Nasdaq)', family: 'NQ', micro: false, pointValue: 20, tickSize: 0.25 },
  MNQ: { id: 'MNQ', label: 'MNQ (Micro Nasdaq)', family: 'NQ', micro: true, pointValue: 2, tickSize: 0.25 },
  ES: { id: 'ES', label: 'ES (E-mini S&P)', family: 'ES', micro: false, pointValue: 50, tickSize: 0.25 },
  MES: { id: 'MES', label: 'MES (Micro S&P)', family: 'ES', micro: true, pointValue: 5, tickSize: 0.25 },
}

/** Which futures family a dataset symbol maps to, and whether it is a proxy. */
const SYMBOL_FAMILY = {
  'NQ=F': { family: 'NQ', proxy: false },
  'ES=F': { family: 'ES', proxy: false },
  QQQ: { family: 'NQ', proxy: true },
  SPY: { family: 'ES', proxy: true },
}

/** Fallback ETF→futures ratios, used until `/api/gamma` supplies a live one. */
export const DEFAULT_RATIO = { QQQ: 41.2, SPY: 10.05 }

export const FUTURES_LIVE_SYMBOLS = ['NQ=F', 'ES=F']

export function symbolFamily(symbol) {
  return SYMBOL_FAMILY[symbol] || null
}

export function contractsForSymbol(symbol) {
  const fam = symbolFamily(symbol)
  return fam ? Object.values(CONTRACTS).filter((c) => c.family === fam.family) : []
}

export function isFuturesCapable(ds) {
  return Boolean(ds && symbolFamily(ds.symbol))
}

/** Plan limits are quoted in minis; a micro counts one tenth. */
export function maxContracts(contract, maxMinis) {
  return contract.micro ? maxMinis * 10 : maxMinis
}
