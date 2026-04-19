// Topology Map — cross-venue price deltas, COBE-inspired dot globe
const { useState, useEffect, useRef, useMemo } = React;

// Build a fibonacci-sphere of dots; project each frame with current rotation
function fibSphere(n) {
  const pts = [];
  const phi = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = phi * i;
    pts.push([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  return pts;
}

// Markers (lat/lon) — venue locations
const MARKERS = [
  { id:'PMK', name:'POLYMARKET',  lat: 40.71, lon:-74.00, px:'0.371', d:'+0.012' },
  { id:'KSH', name:'KALSHI',      lat: 38.90, lon:-77.04, px:'0.368', d:'-0.003' },
  { id:'BFR', name:'BETFAIR',     lat: 51.50, lon: -0.13, px:'0.374', d:'+0.006' },
  { id:'ORC', name:'ORACLE FEED', lat: 35.68, lon:139.69, px:'0.369', d:'+0.001' },
  { id:'CHN', name:'CHAIN RPC',   lat:  1.29, lon:103.85, px:'0.372', d:'+0.004' },
];

function llToXyz(lat, lon) {
  const phi = (90 - lat) * Math.PI / 180;
  const th  = (lon + 180) * Math.PI / 180;
  return [
    -Math.sin(phi) * Math.cos(th),
     Math.cos(phi),
     Math.sin(phi) * Math.sin(th),
  ];
}

function rotY(p, a) {
  const [x,y,z] = p;
  const c = Math.cos(a), s = Math.sin(a);
  return [c*x + s*z, y, -s*x + c*z];
}
function rotX(p, a) {
  const [x,y,z] = p;
  const c = Math.cos(a), s = Math.sin(a);
  return [x, c*y - s*z, s*y + c*z];
}

function Globe({ tick, size = 380 }) {
  const sphere = useMemo(() => fibSphere(900), []);
  const yaw = tick / 80;
  const pitch = -0.35;

  const projected = sphere.map(p => {
    const r = rotX(rotY(p, yaw), pitch);
    return r;
  });

  const r = size / 2;
  const cx = r, cy = r;

  // marker positions for current rotation
  const marks = MARKERS.map(mk => {
    const p = rotX(rotY(llToXyz(mk.lat, mk.lon), yaw), pitch);
    const visible = p[2] > -0.05;
    return {
      ...mk,
      x: cx + p[0] * r * 0.92,
      y: cy - p[1] * r * 0.92,
      z: p[2],
      visible,
    };
  });

  return (
    <div className="globe-wrap" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="globe-svg">
        {/* outer ring */}
        <circle cx={cx} cy={cy} r={r - 1} fill="#fff" stroke="#0000FF" strokeWidth="1" />
        {/* dot field (only front-facing) */}
        {projected.map((p, i) => {
          if (p[2] < -0.05) return null;
          // density falloff at limb
          const op = Math.max(0.05, p[2] * 0.9 + 0.1);
          const rad = 0.9 + p[2] * 0.6;
          return (
            <circle
              key={i}
              cx={cx + p[0] * r * 0.94}
              cy={cy - p[1] * r * 0.94}
              r={rad}
              fill="#0000FF"
              opacity={op}
            />
          );
        })}

        {/* arcs between visible markers */}
        {marks.map((a, i) =>
          marks.slice(i+1).map((b, j) => {
            if (!a.visible || !b.visible) return null;
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2 - 24;
            return (
              <path
                key={`${i}-${j}`}
                d={`M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`}
                stroke="#0000FF"
                strokeWidth="1"
                fill="none"
                opacity="0.45"
              />
            );
          })
        )}

        {/* markers */}
        {marks.filter(m => m.visible).map(m => (
          <g key={m.id}>
            <rect x={m.x - 22} y={m.y - 8} width="44" height="14" fill="#0000FF" />
            <text x={m.x} y={m.y + 2} textAnchor="middle" fill="#fff" fontSize="9" fontFamily="JetBrains Mono, monospace" letterSpacing="0.05em">{m.id}</text>
            <line x1={m.x} y1={m.y + 6} x2={m.x} y2={m.y + 14} stroke="#0000FF" strokeWidth="1" />
            <circle cx={m.x} cy={m.y + 16} r="2.5" fill="#0000FF" />
          </g>
        ))}
      </svg>

      <div className="globe-corner tl">N 40°42′ W 74°00′</div>
      <div className="globe-corner tr">YAW {(yaw % (Math.PI * 2)).toFixed(2)} rad</div>
      <div className="globe-corner bl">5 venues · 4 chains</div>
      <div className="globe-corner br">replay 1.0×</div>
    </div>
  );
}

function TopologyMap({ tick }) {
  // synthetic deltas
  const deltas = useMemo(() => {
    const t = tick / 30;
    return [
      { pair:'PMK ↔ KSH', d: (0.0028 + Math.sin(t)*0.001).toFixed(4),  lat:'31ms / 18ms',  arb:'+0.7%', dir:'up' },
      { pair:'PMK ↔ BFR', d: (0.0091 + Math.sin(t*1.3)*0.002).toFixed(4), lat:'31ms / 84ms',  arb:'+2.4%', dir:'up' },
      { pair:'PMK ↔ ORC', d: (0.0014 + Math.sin(t*0.7)*0.0008).toFixed(4), lat:'31ms / 54ms', arb:'+0.4%', dir:'flat' },
      { pair:'KSH ↔ BFR', d: (0.0068 + Math.sin(t*1.7)*0.0015).toFixed(4), lat:'18ms / 84ms', arb:'+1.8%', dir:'up' },
      { pair:'PMK ↔ CHN', d: (0.0021 + Math.sin(t*0.4)*0.0009).toFixed(4), lat:'31ms / 14ms', arb:'+0.5%', dir:'dn' },
    ];
  }, [tick]);

  return (
    <div className="card card-tall">
      <div className="card-h">
        <span className="card-h-l">◉ T-03 · CROSS-VENUE TOPOLOGY</span>
        <span className="card-h-r">5 NODES · 10 EDGES · WINDOW 60s</span>
      </div>

      <div className="topo-body">
        <div className="topo-globe-pane">
          <Globe tick={tick} size={420} />

          <div className="legend">
            <div className="lg-h">━━ NODE LEGEND ━━</div>
            {MARKERS.map(m => (
              <div key={m.id} className="lg-row">
                <span className="lg-id">{m.id}</span>
                <span className="lg-name">{m.name}</span>
                <span className="lg-px">{m.px}</span>
                <span className={"lg-d " + (m.d.startsWith('+') ? 'up' : 'dn')}>{m.d}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="topo-side">
          <div className="topo-block">
            <div className="block-h">EDGE Δ · LIVE</div>
            <table className="kv">
              <thead>
                <tr><th>PAIR</th><th>Δpx</th><th>LAT</th><th>ARB</th></tr>
              </thead>
              <tbody>
                {deltas.map((d, i) => (
                  <tr key={i}>
                    <td className="mono-blue">{d.pair}</td>
                    <td>{d.d}</td>
                    <td>{d.lat}</td>
                    <td className={d.dir === 'up' ? 'up' : d.dir === 'dn' ? 'dn' : ''}>{d.arb}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="topo-block">
            <div className="block-h">PROPAGATION TRACE</div>
            <pre className="trace">{`t+000ms  PMK quote 0.3712
t+014ms  CHN seal block #19284736
t+031ms  PMK API ack
t+054ms  ORC commits 0.3711
t+088ms  KSH mirrors 0.3708
t+142ms  BFR mirrors 0.3704
t+188ms  Δ window closed · 0.0008
─────────────────────────────
LEAD VENUE   · POLYMARKET
LATENCY MIN  · 14ms (chain)
LATENCY MAX  · 188ms (BFR)`}<span className="cursor">█</span></pre>
          </div>

          <div className="topo-block">
            <div className="block-h">COPY MIRROR · 6 OPEN</div>
            <table className="mirror">
              <tbody>
                {[
                  ['NK SUMMIT DEAL',  '+$788',  'entropy'],
                  ['LUNAR GATEWAY',   '+$918',  'cluster'],
                  ['TYPHOON PACIFIC', '+$889',  'mempool'],
                  ['BTC 150K MAR',    '+$661',  'topo'],
                  ['ECB CUT DEC',     '+$587',  'propagation'],
                  ['AMZN SPLIT',      '+$721',  'cryo'],
                ].map(([n,p,s]) => (
                  <tr key={n}>
                    <td>{n}</td>
                    <td className="up">{p}</td>
                    <td className="sig">{s}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

window.TopologyMap = TopologyMap;
window.Globe = Globe;
