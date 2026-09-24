/**
 * Market calendars. Equities, ETFs and index futures are annualised on the
 * 252-day / 390-minute regular session; crypto trades 24/7 and uses the full
 * 365-day / 1440-minute calendar with UTC-midnight daily closes (Yahoo's
 * convention for `*-USD` daily candles).
 */

export const CRYPTO_SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD']

export function isCrypto(symbol) {
  return typeof symbol === 'string' && /^[A-Z0-9]+-USD$/.test(symbol.toUpperCase())
}

export function calendarFor(symbol) {
  return isCrypto(symbol) ? { days: 365, minutesPerDay: 1440 } : { days: 252, minutesPerDay: 390 }
}
