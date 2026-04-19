// Entropy Gauge — Shannon entropy across order book of selected market
const { useState, useEffect, useRef, useMemo } = React;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function EntropyGauge({ tick }) {
  // pulsing entropy reading 1.40 - 2.10
  const v = useMemo(() => {
    const t = tick / 16;
    const base = 1.78 + Math.sin(t) * 0.18 + Math.sin(t * 2.7) * 0.06;
    return Math.max(1.30, Math.min(2.20, base));
  }, [tick]);

  // history bars (60 ticks)
  const hist = useMemo(() => {
    const r = rng(7);
    const arr = [];
    for (let i = 0; i < 60; i++) {
      const t = (tick - (60 - i)) / 16;
      arr.push(1.78 + Math.sin(t) * 0.18 + Math.sin(t * 2.7) * 0.06 + (r() - 0.5) * 0.04);
    }
    return arr;
  }, [tick]);

  const frozen = v < 1.86;
  const min = 1.30, max = 2.20;
  const pct = ((v - min) / (max - min)) * 100;

  return (
    <div className="card card-tall">
      <div className="card-h">
        <span className="card-h-l">▣ E-01 · SHANNON ENTROPY</span>
        <span className="card-h-r">MARKET: NK-SUMMIT-DEC · BIN 200</span>
      </div>
      <div className="entropy-body">
        <div className="entropy-readout">
          <div className="big-num">
            {v.toFixed(3)}
            <span className="big-cur">█</span>
          </div>
          <div className="big-label">BITS / SHANNON</div>
          <div className={"verdict " + (frozen ? 'verdict-freeze' : 'verdict-live')}>
            {frozen ? '◆ FROZEN  ·  H < 1.86' : '◇ ACTIVE  ·  H ≥ 1.86'}
          </div>

          <table className="kv">
            <tbody>
              <tr><td>WINDOW</td><td>200 trades</td></tr>
              <tr><td>SAMPLE</td><td>1.2s</td></tr>
              <tr><td>ASK / BID</td><td>0.3712 / 0.3708</td></tr>
              <tr><td>SPREAD</td><td>4 bps</td></tr>
              <tr><td>VAR / σ</td><td>0.0014 / 0.038</td></tr>
              <tr><td>SIGNAL</td><td className="mono-blue">{frozen ? 'CRYO · TIER 2' : 'NOMINAL'}</td></tr>
            </tbody>
          </table>
        </div>

        <div className="gauge-col">
          <div className="gauge-rail">
            <div className="gauge-fill" style={{ height: pct + '%' }} />
            <div className="gauge-marks">
              {[2.20, 2.00, 1.86, 1.60, 1.30].map((m, i) => (
                <div key={i} className="gauge-mark" style={{ bottom: ((m - min)/(max-min)) * 100 + '%' }}>
                  <span className={m === 1.86 ? 'mk-thr' : ''}>{m.toFixed(2)} {m === 1.86 ? '◀ THR' : ''}</span>
                </div>
              ))}
            </div>
            <div className="gauge-needle" style={{ bottom: pct + '%' }}>
              <span>━━ {v.toFixed(3)}</span>
            </div>
          </div>
        </div>

        <div className="hist-col">
          <div className="hist-h">H(t) · last 60 ticks ━━━━━</div>
          <div className="hist-bars">
            {hist.map((h, i) => {
              const p = ((h - min) / (max - min)) * 100;
              return (
                <div key={i} className={"hist-bar " + (h < 1.86 ? 'cold' : '')} style={{ height: p + '%' }} />
              );
            })}
          </div>
          <div className="hist-axis">
            <span>−60s</span>
            <span>−30s</span>
            <span>NOW</span>
          </div>

          <div className="book">
            <div className="book-h">ORDER BOOK · 8 LEVELS</div>
            <div className="book-cols">
              <div className="book-side">
                {[0.3716,0.3715,0.3714,0.3713,0.3712,0.3711,0.3710,0.3709].map((p,i) => (
                  <div className="book-row" key={i}>
                    <span>{p.toFixed(4)}</span>
                    <span className="book-bar"><span style={{ width: (10 + (i*7)%70) + '%' }}/></span>
                    <span>{200 + (i*131)%900}</span>
                  </div>
                ))}
              </div>
              <div className="book-mid">━━━━━━━━━━</div>
              <div className="book-side bid">
                {[0.3708,0.3707,0.3706,0.3705,0.3704,0.3703,0.3702,0.3701].map((p,i) => (
                  <div className="book-row" key={i}>
                    <span>{p.toFixed(4)}</span>
                    <span className="book-bar bid-bar"><span style={{ width: (15 + (i*11)%70) + '%' }}/></span>
                    <span>{180 + (i*97)%780}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

window.EntropyGauge = EntropyGauge;
