'use client'

import { useEffect, useState } from 'react'

// Tiny client-side cache so we don't refetch the same address on every render
// across the page (AGENT panel + wallet popovers + position rows can all
// reference the same wallet).
const _clientCache = new Map()

function shortAddress(addr, head = 6, tail = 4) {
  const raw = String(addr || '')
  if (!raw) return '—'
  if (raw.length <= head + tail + 1) return raw
  return `${raw.slice(0, head)}…${raw.slice(-tail)}`
}

/**
 * EnsName — resolves an address (or name) to its ENS handle and renders it.
 * Falls back to a short address when no ENS name is set. Hover shows the full
 * address + key text records (description, telegram, miroshark.role).
 *
 * Props:
 *   address    — 0x… string. Either this or `name` is required.
 *   name       — known ENS name (skips resolution if provided + textRecords
 *                are not needed).
 *   showAddress — show "name (0xab…)" instead of just the name.
 *   className  — passthrough.
 */
export default function EnsName({ address, name: presetName, showAddress = false, className = '' }) {
  const initial = presetName ? { name: presetName, address, textRecords: {} } : null
  const [info, setInfo] = useState(() => {
    if (presetName) return initial
    if (address && _clientCache.has(address.toLowerCase())) {
      return _clientCache.get(address.toLowerCase())
    }
    return null
  })

  useEffect(() => {
    if (info?.name || presetName) return
    if (!address) return
    let cancelled = false
    const cacheKey = address.toLowerCase()
    if (_clientCache.has(cacheKey)) {
      setInfo(_clientCache.get(cacheKey))
      return
    }
    const params = new URLSearchParams({ address })
    fetch(`/api/ens/resolve?${params.toString()}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return
        const value = {
          name: json.name || null,
          address: json.address || address,
          textRecords: json.textRecords || {},
        }
        _clientCache.set(cacheKey, value)
        setInfo(value)
      })
      .catch(() => { /* leave info null → renders short address */ })
    return () => { cancelled = true }
  }, [address, info?.name, presetName])

  const ensName = info?.name || presetName || null
  const fullAddress = address || info?.address || ''
  const records = info?.textRecords || {}

  const tooltipParts = [fullAddress]
  if (records.description) tooltipParts.push(records.description)
  if (records['org.telegram']) tooltipParts.push(`tg ${records['org.telegram']}`)
  if (records['miroshark.role']) tooltipParts.push(records['miroshark.role'])
  if (records['agent.skills']) tooltipParts.push(`skills ${records['agent.skills']}`)
  const tooltip = tooltipParts.filter(Boolean).join(' · ')

  if (ensName) {
    return (
      <span className={`ens-name ${className}`} title={tooltip}>
        <span className="ens-name-label">{ensName}</span>
        {showAddress ? <span className="ens-name-addr">{shortAddress(fullAddress)}</span> : null}
      </span>
    )
  }

  return (
    <span className={`ens-name is-fallback ${className}`} title={fullAddress || ''}>
      {shortAddress(fullAddress)}
    </span>
  )
}
