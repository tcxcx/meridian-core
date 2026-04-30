export const DEFAULT_SIGNERS = [
  { id: -1, label: 'Owner A', role: 'owner', email: 'owner@miroshark' },
  { id: 1, label: 'Admin B', role: 'admin', email: 'admin@miroshark' },
  { id: 2, label: 'Device Key', role: 'device', email: 'device@miroshark' },
]

const DEFAULTS = {
  maxWeight: 1000,
  majorityFraction: 0.51,
}

export function rebalanceWeights(signers, override, config = {}) {
  const { maxWeight } = { ...DEFAULTS, ...config }
  const activeSignerIds = signers.filter((signer) => signer.role !== 'member').map((signer) => signer.id)
  if (!activeSignerIds.length) return {}

  const next = {}
  if (override) {
    const clamped = Math.max(0, Math.min(maxWeight, Number(override.weight || 0)))
    next[override.id] = clamped
    const remaining = maxWeight - clamped
    const others = activeSignerIds.filter((id) => id !== override.id)
    const each = others.length ? Math.floor(remaining / others.length) : 0
    for (const id of others) next[id] = each
    return next
  }

  const each = Math.floor(maxWeight / activeSignerIds.length)
  for (const id of activeSignerIds) next[id] = each
  return next
}

export function computeThreshold(weights, config = {}) {
  const { majorityFraction } = { ...DEFAULTS, ...config }
  const values = Object.values(weights || {}).map((value) => Number(value || 0))
  const totalWeight = values.reduce((sum, value) => sum + value, 0)
  const threshold = totalWeight > 0 ? Math.floor(totalWeight * majorityFraction) : 0
  const thresholdPct = totalWeight > 0 ? Math.round((threshold / totalWeight) * 100) : 0
  return {
    threshold,
    thresholdPct,
    totalWeight,
    signerCount: values.length,
  }
}

export function weightToPct(weight, maxWeight = 1000) {
  return Math.round((Number(weight || 0) / maxWeight) * 100)
}

export function normalizeWeights(signers, weights) {
  const next = {}
  for (const signer of signers) {
    next[signer.id] = Number(weights?.[signer.id] || 0)
  }
  return next
}
