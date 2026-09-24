import test from 'node:test'
import assert from 'node:assert/strict'
import { createJiti } from 'jiti'
const jiti = createJiti(import.meta.url)
const { dailyStrategy, compareBenchmark } = await jiti.import('./benchmark.js')
const epoch = date => Date.parse(date) / 1000

test('daily comparison uses identical dates, capital and return denominators', () => {
  const result = compareBenchmark(new Map([['2025-01-02', 2000], ['2025-01-03', 2200], ['2025-01-06', 2100]]), {
    priceBasis: 'adjusted-close', currency: 'USD', data: [
      { date: '2025-01-02', adjustedClose: 100 }, { date: '2025-01-03', adjustedClose: 105 }, { date: '2025-01-06', adjustedClose: 110 },
    ],
  })
  assert.ok(Math.abs(result.strategy.totalReturn - 0.05) < 1e-10)
  assert.ok(Math.abs(result.benchmark.totalReturn - 0.1) < 1e-10)
  assert.equal(result.points[0].strategy, 1)
  assert.equal(result.points[0].benchmark, 1)
  assert.ok(result.strategy.maxDd > 0)
  assert.equal(result.benchmark.maxDd, 0)
})

test('intraday observations use 16:00 Eastern closes and exclude after-hours/partial sessions', () => {
  const dataset = { interval: '5m', time: [
    epoch('2025-07-01T19:55:00Z'), epoch('2025-07-01T21:00:00Z'), epoch('2025-07-02T18:00:00Z'),
  ] }
  const observations = dailyStrategy(dataset, { windowStart: 0, windowEnd: 2, equity: [100, 999, 200] })
  assert.deepEqual([...observations], [['2025-07-01', 100]])
  const winter = dailyStrategy({ interval: '5m', time: [epoch('2025-01-02T20:55:00Z')] }, { windowStart: 0, windowEnd: 0, equity: [123] })
  assert.equal(winter.get('2025-01-02'), 123)
})

test('daily date labels stay on their UTC date; mismatched or invalid coverage fails', () => {
  const observations = dailyStrategy({ interval: '1d', time: [epoch('2025-01-02T00:00:00Z')] }, { windowStart: 0, windowEnd: 0, equity: [100] })
  assert.equal(observations.get('2025-01-02'), 100)
  assert.throws(() => compareBenchmark(observations, { priceBasis: 'adjusted-close', data: [] }), /two matching/)
  assert.throws(() => compareBenchmark(observations, { priceBasis: 'adjusted-close', data: [{ date: '2025-01-02', adjustedClose: -1 }] }), /Invalid/)
})

test('research marks before the closing bell remain available, without using after-hours prices', () => {
  const observations = dailyStrategy({ interval: '5m', time: [epoch('2025-07-01T19:40:00Z'), epoch('2025-07-01T21:00:00Z')] },
    { windowStart: 0, windowEnd: 1, equity: [110, 999] })
  assert.equal(observations.get('2025-07-01'), 110)
})

test('crypto marks close at 00:00 UTC and annualise on 365 days', async () => {
  const bars = ['2025-01-03T23:00:00Z', '2025-01-03T23:55:00Z', '2025-01-04T12:00:00Z', '2025-01-04T23:55:00Z', '2025-01-05T23:55:00Z']
  const observations = dailyStrategy({ symbol: 'BTC-USD', interval: '5m', time: bars.map(epoch) }, { windowStart: 0, windowEnd: 4, equity: [1, 100, 7, 102, 101] })
  assert.deepEqual([...observations], [['2025-01-03', 100], ['2025-01-04', 102], ['2025-01-05', 101]])
  const data = [{ date: '2025-01-03', adjustedClose: 100 }, { date: '2025-01-04', adjustedClose: 101 }, { date: '2025-01-05', adjustedClose: 99 }]
  const crypto = compareBenchmark(observations, { symbol: 'ETH-USD', priceBasis: 'adjusted-close', currency: 'USD', data }, 'BTC-USD')
  const equity = compareBenchmark(observations, { symbol: 'SPY', priceBasis: 'adjusted-close', currency: 'USD', data }, 'SPY')
  assert.ok(Math.abs(crypto.strategy.sharpe / equity.strategy.sharpe - Math.sqrt(365 / 252)) < 1e-10)
})

test('an equity strategy is not penalised for missing crypto weekend marks', () => {
  const observations = new Map([['2025-01-02', 100], ['2025-01-03', 101], ['2025-01-06', 103]])
  const payload = { symbol: 'BTC-USD', priceBasis: 'adjusted-close', currency: 'USD', data: [
    { date: '2025-01-02', adjustedClose: 100 }, { date: '2025-01-03', adjustedClose: 99 }, { date: '2025-01-04', adjustedClose: 98 },
    { date: '2025-01-05', adjustedClose: 97 }, { date: '2025-01-06', adjustedClose: 102 },
  ] }
  const result = compareBenchmark(observations, payload, 'SPY')
  assert.deepEqual(result.dates, ['2025-01-02', '2025-01-03', '2025-01-06'])
  assert.notEqual(result.strategy.sharpe, null)
  assert.equal(compareBenchmark(observations, payload, 'ETH-USD').strategy.sharpe, null)
})

test('crypto annualisation counts every bar of the 24/7 calendar', async () => {
  const { periodsPerYear } = await jiti.import('./metrics.js')
  assert.equal(periodsPerYear('5m', 'SPY'), 252 * 78)
  assert.equal(periodsPerYear('5m', 'BTC-USD'), 365 * 288)
  assert.equal(periodsPerYear('1d', 'ETH-USD'), 365)
  assert.equal(periodsPerYear('1d'), 252)
})
