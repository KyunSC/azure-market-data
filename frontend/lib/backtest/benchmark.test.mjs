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
