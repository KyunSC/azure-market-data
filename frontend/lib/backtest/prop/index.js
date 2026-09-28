/**
 * Prop mode wiring: turns the store's `prop` settings into what the engine and
 * the account replay need. Kept here so the store, the worker and the tests
 * all derive the same instrument and plan from the same inputs.
 */

import { resolvePlan } from './firms'
import { CONTRACTS, DEFAULT_RATIO, symbolFamily, contractsForSymbol, maxContracts } from './contracts'
import { runProp } from './stats'

export const DEFAULT_PROP = {
  enabled: false,
  firm: 'lucid',
  plan: 'flex',
  size: '50k',
  dll: true,
  contract: 'MNQ',
  contracts: 2,
  commissionPerSide: 0.5,
  slippageTicks: 1,
  ratio: {},
  overrides: {},
}

/** Contract to use for `symbol`: the chosen one when it matches the symbol's
 *  family, else the same size class (mini/micro) of the right family. */
export function contractFor(prop, symbol) {
  const options = contractsForSymbol(symbol)
  if (!options.length) return null
  const chosen = CONTRACTS[prop.contract]
  return options.find((c) => c.id === chosen?.id) || options.find((c) => c.micro === Boolean(chosen?.micro)) || options[0]
}

export function ratioFor(prop, symbol) {
  const fam = symbolFamily(symbol)
  if (!fam?.proxy) return 1
  const r = Number(prop.ratio?.[symbol])
  return r > 0 ? r : DEFAULT_RATIO[symbol] || 1
}

/**
 * Everything a prop run needs, or `{ error }` when the dataset can't be traded
 * as futures. `costs` / `risk` are the terminal's own; prop mode overrides the
 * sizing, the account size and the flat-by rule, and leaves stops alone.
 */
export function propSetup({ prop, symbol, costs, risk }) {
  const contract = contractFor(prop, symbol)
  if (!contract) return { error: `${symbol} has no futures mapping — prop mode trades NQ/ES only` }
  const plan = resolvePlan(prop)
  const limit = maxContracts(contract, plan.maxMinis)
  const contracts = Math.max(1, Math.min(limit, Math.round(prop.contracts) || 1))
  const priceScale = ratioFor(prop, symbol)
  return {
    plan,
    contract,
    contracts,
    limit,
    priceScale,
    proxy: Boolean(symbolFamily(symbol)?.proxy),
    costs: {
      ...costs,
      initialCapital: plan.startBalance,
      instrument: {
        contract: contract.id,
        pointValue: contract.pointValue,
        tickSize: contract.tickSize,
        contracts,
        commissionPerSide: Number(prop.commissionPerSide) || 0,
        slippageTicks: Number(prop.slippageTicks) || 0,
        priceScale,
      },
    },
    risk: { ...risk, flatAtSessionEnd: true, flatByEt: plan.flatByEt },
  }
}

/** Adds `result.prop` when the run was configured with a plan. */
export function attachProp(result, dataset, config, opts = {}) {
  if (!config.prop || !result.barLo) return result
  result.prop = runProp({
    result,
    time: dataset.time,
    plan: config.prop,
    initialCapital: config.costs.initialCapital,
    ...opts,
  })
  return result
}
