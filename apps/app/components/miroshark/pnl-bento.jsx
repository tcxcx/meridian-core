'use client'

import { useMemo } from 'react'

function formatUsdShort(value) {
  const n = Number(value || 0)
  const abs = Math.abs(n)
  if (abs >= 1000) return `${n < 0 ? '-' : ''}$${(abs / 1000).toFixed(1)}k`
  return `${n < 0 ? '-' : ''}$${abs.toFixed(0)}`
}

function formatPnlSigned(value) {
  const n = Number(value || 0)
  return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

function buildEquitySeries(positions) {
  const settled = positions
    .filter((p) => p?.status === 'settled' && p.payout_usdc != null)
    .map((p) => ({
      ts: Number(p.updated_at || 0),
      pnl: Number(p.payout_usdc || 0) - Number(p.usdc_amount || 0),
    }))
    .sort((a, b) => a.ts - b.ts)
  let cum = 0
  return settled.map((s) => {
    cum += s.pnl
    return { ts: s.ts, equity: cum }
  })
}

function Sparkline({ series, width = 280, height = 84 }) {
  if (series.length < 2) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="pnl-spark is-empty">
        <text x={width / 2} y={height / 2 + 4} textAnchor="middle" className="pnl-spark-empty-copy">
          equity curve appears after first settled trade
        </text>
      </svg>
    )
  }
  const min = Math.min(...series.map((p) => p.equity), 0)
  const max = Math.max(...series.map((p) => p.equity), 0)
  const range = max - min || 1
  const xs = (i) => (i / (series.length - 1)) * (width - 8) + 4
  const ys = (v) => height - 4 - ((v - min) / range) * (height - 8)
  const d = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${xs(i).toFixed(1)},${ys(p.equity).toFixed(1)}`).join(' ')
  const last = series[series.length - 1].equity
  const tone = last > 0 ? 'pos' : last < 0 ? 'neg' : 'flat'
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={`pnl-spark tone-${tone}`}>
      <line x1="0" x2={width} y1={ys(0)} y2={ys(0)} className="pnl-spark-zero" />
      <path d={d} className="pnl-spark-line" fill="none" />
    </svg>
  )
}

export default function PnlBento({ positions }) {
  const stats = useMemo(() => {
    const settled = positions.filter((p) => p?.status === 'settled')
    const open = positions.filter((p) => p?.status === 'open' || p?.status === 'resolving')
    const wins = settled.filter((p) => Number(p.payout_usdc || 0) > Number(p.usdc_amount || 0))
    const losses = settled.filter((p) => Number(p.payout_usdc || 0) < Number(p.usdc_amount || 0))
    const totalStake = settled.reduce((s, p) => s + Number(p.usdc_amount || 0), 0)
    const totalPayout = settled.reduce((s, p) => s + Number(p.payout_usdc || 0), 0)
    const realized = totalPayout - totalStake
    const realizedPct = totalStake > 0 ? (realized / totalStake) * 100 : 0
    const winRate = settled.length > 0 ? (wins.length / settled.length) * 100 : 0
    const openStake = open.reduce((s, p) => s + Number(p.usdc_amount || 0), 0)
    const pnls = settled.map((p) => Number(p.payout_usdc || 0) - Number(p.usdc_amount || 0))
    const maxDD = pnls.length ? Math.abs(Math.min(0, ...pnls)) : 0
    return {
      realized, realizedPct, winRate,
      wins: wins.length, losses: losses.length,
      open: open.length, openStake,
      settled: settled.length, maxDD,
    }
  }, [positions])

  const series = useMemo(() => buildEquitySeries(positions), [positions])
  const tone = stats.realized > 0 ? 'pos' : stats.realized < 0 ? 'neg' : 'flat'

  return (
    <section className="pnl-bento">
      <header className="pnl-bento-head">
        <span className="lean-section-label">PNL · realized</span>
        <span className="pnl-bento-head-r">
          <strong className={`pnl-bento-total tone-${tone}`}>{formatPnlSigned(stats.realized)}</strong>
          <span className={`pnl-bento-pct tone-${tone}`}>
            {stats.realized >= 0 ? '+' : ''}{stats.realizedPct.toFixed(1)}%
          </span>
        </span>
      </header>
      <div className="pnl-bento-grid">
        <div className="pnl-bento-spark"><Sparkline series={series} /></div>
        <dl className="pnl-bento-kpis">
          <div className="pnl-bento-kpi"><dt>WINS</dt><dd>{stats.wins}<span>· {stats.winRate.toFixed(0)}%</span></dd></div>
          <div className="pnl-bento-kpi"><dt>LOSSES</dt><dd>{stats.losses}<span>· {(100 - stats.winRate).toFixed(0)}%</span></dd></div>
          <div className="pnl-bento-kpi"><dt>OPEN</dt><dd>{stats.open}<span>· {formatUsdShort(stats.openStake)}</span></dd></div>
          <div className="pnl-bento-kpi"><dt>SETTLED</dt><dd>{stats.settled}<span>· total</span></dd></div>
          <div className="pnl-bento-kpi"><dt>MAX DD</dt><dd>{formatUsdShort(stats.maxDD)}<span>· single</span></dd></div>
        </dl>
      </div>
    </section>
  )
}
