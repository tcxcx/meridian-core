const DEFAULTS = {
  maxWeight: 1000,
  majorityFraction: 0.51,
}

const SIGNER_ROLES = new Set(['owner', 'admin', 'device', 'recovery', 'member'])

function slugifyLabel(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function createSignerId(prefix = 'signer') {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

export function createSigner(input = {}) {
  const email = String(input.email || '').trim().toLowerCase()
  const role = SIGNER_ROLES.has(input.role) ? input.role : 'admin'
  const label =
    String(input.label || '').trim() ||
    (role === 'owner' ? 'Treasury Owner' : role === 'recovery' ? 'Recovery Signer' : 'Additional Signer')

  return {
    id: String(input.id || createSignerId(slugifyLabel(label) || role)),
    label,
    role,
    email,
    status: input.status || (input.isBootstrap ? 'bootstrap' : 'draft'),
    invitationId: input.invitationId || null,
    invitedAt: input.invitedAt || null,
    acceptedAt: input.acceptedAt || null,
    isBootstrap: Boolean(input.isBootstrap),
  }
}

export function buildDefaultSigners(actor) {
  return [
    createSigner({
      id: 'bootstrap-owner',
      label: actor?.displayName || 'Treasury Owner',
      role: 'owner',
      email: actor?.email || '',
      status: 'bootstrap',
      isBootstrap: true,
    }),
  ]
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
  const normalizedWeights = weights || {}
  for (const signer of signers) {
    next[signer.id] = Number(normalizedWeights[signer.id] || 0)
  }
  return next
}

export function sanitizeSigners(signers, actor) {
  const fallback = buildDefaultSigners(actor)
  const source = Array.isArray(signers) && signers.length ? signers : fallback
  const sanitized = source
    .map((signer) => createSigner(signer))
    .filter((signer) => !['owner@miroshark', 'admin@miroshark', 'device@miroshark'].includes(String(signer.email || '').toLowerCase()))
    .filter((signer, index, all) => signer.email || signer.isBootstrap || index === 0)
    .filter((signer, index, all) => all.findIndex((candidate) => candidate.id === signer.id) === index)

  const bootstrapEmail = String(actor?.email || '').trim().toLowerCase()
  const bootstrap = sanitized.find((signer) => signer.isBootstrap)
  if (bootstrap) {
    bootstrap.role = 'owner'
    bootstrap.status = bootstrap.status === 'accepted' ? 'accepted' : 'bootstrap'
    if (bootstrapEmail) bootstrap.email = bootstrapEmail
    if (actor?.displayName) bootstrap.label = actor.displayName
  } else {
    sanitized.unshift(...fallback)
  }

  return sanitized
}

export function buildDefaultMultisigPlan(actor, existing) {
  const signers = sanitizeSigners(existing?.signers, actor)
  const baseWeights = normalizeWeights(signers, existing?.weights || rebalanceWeights(signers))
  const threshold = computeThreshold(baseWeights)
  return {
    signers,
    weights: baseWeights,
    ...threshold,
    updatedAt: existing?.updatedAt || null,
  }
}
