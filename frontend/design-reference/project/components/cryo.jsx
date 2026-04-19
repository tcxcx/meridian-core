// Cryo Scanner — frozen market detection grid
const { useState, useEffect, useRef, useMemo } = React;

const MARKETS = [
  { sym:'PLAT-12',    name:'PLATINUM > $1200 BY DEC',         entropy:1.62, vol:'0.4k',  freeze:'08:42', tier:1, accum:'+3 wallets', px:'0.082' },
  { sym:'NK-SUMMIT',  name:'NK SUMMIT DEAL Q1',                entropy:1.81, vol:'14.8k', freeze:'11:19', tier:2, accum:'+1 wallet',  px:'0.371' },
  { sym:'LUNAR-GW',   name:'LUNAR GATEWAY DELAY',              entropy:1.74, vol:'6.2k',  freeze:'09:55', tier:2, accum:'+2 wallets', px:'0.224' },
  { sym:'TYP-PAC',    name:'TYPHOON PACIFIC LANDFALL',         entropy:1.58, vol:'2.1k',  freeze:'07:03', tier:1, accum:'+4 wallets', px:'0.118' },
  { sym:'BTC-150',    name:'BTC > $150K BY MAR',               entropy:1.92, vol:'88.4k', freeze:'—',     tier:0, accum:'normal',     px:'0.412' },
  { sym:'ECB-CUT',    name:'ECB RATE CUT IN DEC',              entropy:1.85, vol:'22.1k', freeze:'10:31', tier:2, accum:'+2 wallets', px:'0.547' },
  { sym:'AMZN-SPLIT', name:'AMZN STOCK SPLIT BY EOY',          entropy:1.79, vol:'4.8k',  freeze:'09:12', tier:2, accum:'+1 wallet',  px:'0.198' },
  { sym:'GPT-IPO',    name:'OPENAI IPO ANNOUNCE Q2',           entropy:1.94, vol:'31.0k', freeze:'—',     tier:0, accum:'normal',     px:'0.288' },
  { sym:'OIL-90',     name:'BRENT > $90 BY JAN',               entropy:1.88, vol:'19.7k', freeze:'—',     tier:0, accum:'normal',     px:'0.612' },
  { sym:'TWN-INC',    name:'TAIWAN INCURSION HEADLINE',        entropy:1.55, vol:'1.7k',  freeze:'06:18', tier:1, accum:'+5 wallets', px:'0.064' },
];

function tierBadge(t) {
  if (t === 0) return <span className="tier tier-0">━ NONE</span>;
  if (t === 1) return <span className="tier tier-1">◆ TIER 1</span>;
  return <span className="tier tier-2">◆ TIER 2</span>;
}

function CryoScanner({ tick }) {
  const [sel, setSel] = useState(0);
  const m = MARKETS[sel];

  const sparks = useMemo(() => {
    return MARKETS.map((mk, idx) => {
      const arr = [];
      for (let i = 0; i < 24; i++) {
        const t = (tick / 12) + idx + i * 0.4;
        const base = mk.tier > 0 ? 0.5 + Math.sin(t * 0.4) * 0.05 : 0.5 + Math.sin(t) * 0.3;
        arr.push(base);
      }
      return arr;
    });
  }, [tick]);

  return (
    <div className="card card-tall">
      <div className="card-h">
        <span className="card-h-l">❄ C-02 · CRYO SCANNER · 10 MARKETS</span>
        <span className="card-h-r">2 TIER-2 · 3 TIER-1 · LATENT COORD: ON</span>
      </div>

      <div className="cryo-body">
        <div className="cryo-table-wrap">
          <table className="cryo-table">
            <thead>
              <tr>
                <th>SYM</th><th>MARKET</th><th>H</th><th>VOL/H</th>
                <th>FROZEN</th><th>WALLETS</th><th>PX</th><th>SPARK</th><th>STATE</th>
              </tr>
            </thead>
            <tbody>
              {MARKETS.map((mk, i) => (
                <tr
                  key={mk.sym}
                  className={(i === sel ? 'sel ' : '') + (mk.tier === 2 ? 'row-t2' : mk.tier === 1 ? 'row-t1' : '')}
                  onClick={() => setSel(i)}
                >
                  <td className="mono-blue">{mk.sym}</td>
                  <td>{mk.name}</td>
                  <td>{mk.entropy.toFixed(2)}</td>
                  <td>{mk.vol}</td>
                  <td>{mk.freeze}</td>
                  <td>{mk.accum}</td>
                  <td>{mk.px}</td>
                  <td>
                    <svg viewBox="0 0 96 16" className="spark">
                      <polyline
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1"
                        points={sparks[i].map((v, x) => `${x * 4},${16 - v * 14}`).join(' ')}
                      />
                    </svg>
                  </td>
                  <td>{tierBadge(mk.tier)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="cryo-detail">
          <div className="cd-h">
            <div className="cd-sym">{m.sym}</div>
            <div className="cd-name">{m.name}</div>
          </div>

          <div className="freeze-block">
            <pre className="ascii">{`
   ╔══════════════════════╗
   ║      ◆  FROZEN  ◆    ║
   ║                      ║
   ║       H = ${m.entropy.toFixed(2)}      ║
   ║       Δ < 0.001       ║
   ║                      ║
   ║   ${m.accum.padEnd(18)} ║
   ╚══════════════════════╝
`}</pre>
          </div>

          <div className="cd-meta">
            <div className="kv-row"><span>VENUE</span><span>POLYMARKET</span></div>
            <div className="kv-row"><span>FROZEN @</span><span>{m.freeze}</span></div>
            <div className="kv-row"><span>STD DEV</span><span>0.0008</span></div>
            <div className="kv-row"><span>TICK GAP</span><span>4.7s avg</span></div>
            <div className="kv-row"><span>OBSERVER</span><span>cryo-d2</span></div>
            <div className="kv-row"><span>TIER</span><span>{tierBadge(m.tier)}</span></div>
          </div>

          <div className="cd-actions">
            <button className="btn btn-primary">▶ COPY TRADE</button>
            <button className="btn">+ WATCHLIST</button>
            <button className="btn">⤴ DISMISS</button>
          </div>

          <div className="cd-log">
            <div className="cd-log-h">DETECTOR LOG ━━━━</div>
            <div>{m.freeze} · entropy crossed 1.86 ▼</div>
            <div>{m.freeze} · 3 new wallets within 14s</div>
            <div>{m.freeze} · order book depth → 0.4×</div>
            <div>{m.freeze} · cross-venue Δ within 0.0009</div>
            <div className="mono-blue">{m.freeze} · CRYO LATCHED · tier {m.tier}<span className="cursor">█</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

window.CryoScanner = CryoScanner;
