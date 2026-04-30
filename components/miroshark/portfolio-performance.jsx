'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

function num(value) {
  return Number(value || 0)
}

function formatUsd(value, digits = 2) {
  return `$${num(value).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`
}

function formatPct(value) {
  const n = num(value)
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function formatMultiple(value) {
  return `${num(value).toFixed(2)}x`
}

function shorten(value, left = 6, right = 4) {
  const raw = String(value || '')
  if (!raw) return 'pending'
  if (raw.length <= left + right + 3) return raw
  return `${raw.slice(0, left)}…${raw.slice(-right)}`
}

function eventLabel(ts) {
  const date = new Date(num(ts) * 1000)
  if (Number.isNaN(date.getTime())) return 'now'
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function eventTime(ts) {
  const date = new Date(num(ts) * 1000)
  if (Number.isNaN(date.getTime())) return 'now'
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="portfolio-tooltip">
      <div className="portfolio-tooltip-title">{label}</div>
      <ul className="portfolio-tooltip-list">
        {payload.map((entry) => (
          <li key={entry.dataKey} className="portfolio-tooltip-item">
            <span className="portfolio-tooltip-key" style={{ color: entry.color }}>{entry.name}</span>
            <span>{formatUsd(entry.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function PortfolioPerformance({
  positions = [],
  treasury = {},
  trading = {},
  balances = {},
  pendingCreditBalance = 0,
  opsStagingBalance = 0,
}) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const settledPositions = useMemo(
    () => positions.filter((item) => item.status === 'settled'),
    [positions],
  )

  const metrics = useMemo(() => {
    const totalInvested = positions.reduce((sum, item) => sum + num(item.usdc_amount), 0)
    const settledInvested = settledPositions.reduce((sum, item) => sum + num(item.usdc_amount), 0)
    const realizedPayout = settledPositions.reduce((sum, item) => sum + num(item.payout_usdc), 0)
    const realizedPnl = realizedPayout - settledInvested
    const winCount = settledPositions.filter((item) => num(item.payout_usdc) > num(item.usdc_amount)).length
    const winRate = settledPositions.length ? (winCount / settledPositions.length) * 100 : 0
    const roi = settledInvested ? (realizedPnl / settledInvested) * 100 : 0
    const moic = settledInvested ? realizedPayout / settledInvested : 0
    const activeAtRisk = num(balances.deployed_at_risk)
    const tradingTarget = num(trading.target_balance_usdc)
    const deploymentPct = tradingTarget ? (activeAtRisk / tradingTarget) * 100 : 0

    return {
      totalInvested,
      settledInvested,
      realizedPayout,
      realizedPnl,
      winRate,
      roi,
      moic,
      activeAtRisk,
      deploymentPct,
    }
  }, [balances.deployed_at_risk, positions, settledPositions, trading.target_balance_usdc])

  const performanceSeries = useMemo(() => {
    const events = []

    positions.forEach((position) => {
      const stake = num(position.usdc_amount)
      const payout = num(position.payout_usdc)
      const openedAt = num(position.created_at || position.updated_at)
      const closedAt = num(position.updated_at || position.created_at)

      if (openedAt) {
        events.push({
          ts: openedAt,
          type: 'open',
          stake,
          payout: 0,
          id: position.position_id,
        })
      }

      if (['settled', 'failed'].includes(position.status)) {
        events.push({
          ts: closedAt,
          type: 'close',
          stake,
          payout,
          id: `${position.position_id}-close`,
        })
      }
    })

    events.sort((a, b) => a.ts - b.ts)

    let cumulativeInvested = 0
    let cumulativeReturned = 0
    let activeCapital = 0
    let realizedPnl = 0

    const rows = events.map((event, index) => {
      if (event.type === 'open') {
        cumulativeInvested += event.stake
        activeCapital += event.stake
      } else {
        cumulativeReturned += event.payout
        activeCapital = Math.max(0, activeCapital - event.stake)
        realizedPnl += event.payout - event.stake
      }

      return {
        key: `${event.id}-${index}`,
        label: eventLabel(event.ts),
        time: eventTime(event.ts),
        invested: Number(cumulativeInvested.toFixed(2)),
        returned: Number(cumulativeReturned.toFixed(2)),
        active: Number(activeCapital.toFixed(2)),
        pnl: Number(realizedPnl.toFixed(2)),
      }
    })

    if (!rows.length) {
      rows.push({
        key: 'baseline',
        label: 'Now',
        time: 'No executed positions yet',
        invested: 0,
        returned: 0,
        active: num(balances.deployed_at_risk),
        pnl: 0,
      })
    }

    const last = rows[rows.length - 1]
    rows.push({
      key: 'current',
      label: 'Now',
      time: 'Current wallet state',
      invested: last.invested,
      returned: last.returned,
      active: num(balances.deployed_at_risk),
      pnl: num(balances.realized_payout_total) - metrics.settledInvested,
    })

    return rows
  }, [balances.deployed_at_risk, balances.realized_payout_total, metrics.settledInvested, positions])

  const walletSeries = useMemo(() => ([
    {
      label: 'Treasury',
      value: num(treasury.gateway_balance_usdc),
      note: 'passkey vault',
    },
    {
      label: 'Trading',
      value: num(trading.available_to_deploy_usdc),
      note: 'agent dry powder',
    },
    {
      label: 'At Risk',
      value: num(balances.deployed_at_risk),
      note: 'live positions',
    },
    {
      label: 'Pending',
      value: num(pendingCreditBalance) + num(opsStagingBalance),
      note: 'settlement motion',
    },
  ]), [balances.deployed_at_risk, opsStagingBalance, pendingCreditBalance, trading.available_to_deploy_usdc, treasury.gateway_balance_usdc])

  return (
    <section className="stage-card portfolio-stage-card">
      <div className="card-head">
        <div className="card-head-l">
          <span className="act-chip">ACT 3B</span>
          <span className="card-eyebrow">Portfolio Performance</span>
        </div>
        <span className="card-head-r">roi</span>
      </div>

      <div className="section-head narrow">
        <div>
          <h3 className="section-title small">Portfolio investments over time</h3>
          <p className="graph-caption">Track capital, ROI, realized PnL, and wallet deployment across the treasury vault and agent trading rail.</p>
        </div>
      </div>

      <div className="portfolio-kpi-grid">
        <article className="portfolio-kpi-card">
          <span className="portfolio-kpi-label">Realized ROI</span>
          <strong className={`portfolio-kpi-value ${metrics.roi >= 0 ? 'is-up' : 'is-down'}`}>{formatPct(metrics.roi)}</strong>
          <span className="portfolio-kpi-meta">{formatMultiple(metrics.moic)} MOIC on settled capital</span>
        </article>
        <article className="portfolio-kpi-card">
          <span className="portfolio-kpi-label">Realized PnL</span>
          <strong className={`portfolio-kpi-value ${metrics.realizedPnl >= 0 ? 'is-up' : 'is-down'}`}>{formatUsd(metrics.realizedPnl)}</strong>
          <span className="portfolio-kpi-meta">{formatUsd(metrics.realizedPayout)} returned on {formatUsd(metrics.settledInvested)} settled</span>
        </article>
        <article className="portfolio-kpi-card">
          <span className="portfolio-kpi-label">Deployment Rate</span>
          <strong className="portfolio-kpi-value">{formatPct(metrics.deploymentPct)}</strong>
          <span className="portfolio-kpi-meta">{formatUsd(metrics.activeAtRisk)} currently at risk</span>
        </article>
        <article className="portfolio-kpi-card">
          <span className="portfolio-kpi-label">Win Rate</span>
          <strong className="portfolio-kpi-value">{formatPct(metrics.winRate)}</strong>
          <span className="portfolio-kpi-meta">{positions.length} lifetime positions tracked</span>
        </article>
      </div>

      <div className="portfolio-address-grid">
        <article className="portfolio-address-card">
          <div className="portfolio-address-head">
            <span>Treasury wallet</span>
            <span className="wallet-system-tag">vault</span>
          </div>
          <div className="portfolio-address-value">{treasury.address || 'pending'}</div>
          <div className="portfolio-address-meta">{shorten(treasury.address, 10, 8)} · fund this for reserve and profit sweeps</div>
        </article>
        <article className="portfolio-address-card">
          <div className="portfolio-address-head">
            <span>Agent trading wallet</span>
            <span className="wallet-system-tag">execution</span>
          </div>
          <div className="portfolio-address-value">{trading.address || 'pending'}</div>
          <div className="portfolio-address-meta">{shorten(trading.address, 10, 8)} · fund this for live position deployment</div>
        </article>
      </div>

      <div className="portfolio-chart-grid">
        <article className="portfolio-chart-card">
          <div className="portfolio-chart-head">
            <span>Capital curve</span>
            <span>{performanceSeries.length - 1} events</span>
          </div>
          <div className="portfolio-chart-wrap">
            {mounted ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={performanceSeries} margin={{ top: 10, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="rgba(0,0,255,0.12)" strokeDasharray="3 3" />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#0000ff' }} axisLine={{ stroke: '#0000ff' }} tickLine={{ stroke: '#0000ff' }} />
                  <YAxis tick={{ fontSize: 10, fill: '#0000ff' }} axisLine={{ stroke: '#0000ff' }} tickLine={{ stroke: '#0000ff' }} width={64} />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend wrapperStyle={{ fontSize: '11px', color: '#0000ff' }} />
                  <Area type="monotone" dataKey="active" name="Active capital" stroke="#0000ff" fill="rgba(0,0,255,0.18)" strokeWidth={2} />
                  <Area type="monotone" dataKey="returned" name="Returned capital" stroke="#067a1f" fill="rgba(6,122,31,0.14)" strokeWidth={2} />
                  <Line type="monotone" dataKey="pnl" name="Realized PnL" stroke="#c8102e" strokeWidth={2} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            ) : <div className="portfolio-chart-placeholder">Hydrating capital curve…</div>}
          </div>
        </article>

        <article className="portfolio-chart-card">
          <div className="portfolio-chart-head">
            <span>Wallet allocation now</span>
            <span>{formatUsd(num(treasury.gateway_balance_usdc) + num(trading.available_to_deploy_usdc) + num(balances.deployed_at_risk))}</span>
          </div>
          <div className="portfolio-chart-wrap compact">
            {mounted ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={walletSeries} margin={{ top: 10, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="rgba(0,0,255,0.12)" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#0000ff' }} axisLine={{ stroke: '#0000ff' }} tickLine={{ stroke: '#0000ff' }} />
                  <YAxis tick={{ fontSize: 10, fill: '#0000ff' }} axisLine={{ stroke: '#0000ff' }} tickLine={{ stroke: '#0000ff' }} width={64} />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar dataKey="value" name="USDC" fill="#0000ff" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <div className="portfolio-chart-placeholder">Hydrating wallet allocation…</div>}
          </div>
          <div className="portfolio-allocation-list">
            {walletSeries.map((row) => (
              <div key={row.label} className="portfolio-allocation-row">
                <span>{row.label}</span>
                <span>{formatUsd(row.value)}</span>
                <span>{row.note}</span>
              </div>
            ))}
          </div>
        </article>
      </div>
    </section>
  )
}
