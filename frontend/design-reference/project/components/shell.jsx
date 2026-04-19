// Shell: sidebar + main pane + status bar + ticker
const { useState, useEffect, useRef, useMemo } = React;

const TOOLS = [
  { id: 'entropy',  code: 'E-01', name: 'ENTROPY GAUGE',  desc: 'shannon entropy / order book' },
  { id: 'cryo',     code: 'C-02', name: 'CRYO SCANNER',   desc: 'frozen market detection' },
  { id: 'topology', code: 'T-03', name: 'TOPOLOGY MAP',   desc: 'cross-venue price deltas' },
];

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function fmtTime(d) {
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}
function fmtDate(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
}

function Cursor() {
  return <span className="cursor">█</span>;
}

function StatusBar({ tool, latency, equity }) {
  const now = useNow(1000);
  return (
    <div className="statusbar">
      <div className="sb-left">
        <span className="sb-cell sb-on">● LIVE</span>
        <span className="sb-cell">SESSION 47</span>
        <span className="sb-cell">USR @1743116</span>
        <span className="sb-cell">TOOL {tool.toUpperCase()}</span>
      </div>
      <div className="sb-right">
        <span className="sb-cell">PMK {latency.pmk}ms</span>
        <span className="sb-cell">KSH {latency.ksh}ms</span>
        <span className="sb-cell">ORC {latency.orc}ms</span>
        <span className="sb-cell">CHN {latency.chn}ms</span>
        <span className="sb-cell sb-eq">EQ ${equity.toLocaleString()}</span>
        <span className="sb-cell">{fmtDate(now)} {fmtTime(now)}</span>
      </div>
    </div>
  );
}

function Ticker({ items }) {
  return (
    <div className="ticker">
      <div className="ticker-tag">FEED</div>
      <div className="ticker-rail">
        <div className="ticker-track">
          {[...items, ...items].map((it, i) => (
            <span key={i} className="tk">
              <span className={"tk-mark " + (it.dir === 'up' ? 'up' : it.dir === 'dn' ? 'dn' : 'flat')}>
                {it.dir === 'up' ? '▲' : it.dir === 'dn' ? '▼' : '■'}
              </span>
              <span className="tk-sym">{it.sym}</span>
              <span className="tk-px">{it.px}</span>
              <span className={"tk-d " + (it.dir === 'up' ? 'up' : 'dn')}>{it.d}</span>
              <span className="tk-sep">·</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function Sidebar({ active, onPick, alerts }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <div className="m-row"><span>▮▮▯▯</span><span>▯▮▮▯</span></div>
          <div className="m-row"><span>▯▮▮▮</span><span>▮▯▯▮</span></div>
        </div>
        <div className="brand-text">
          <div className="brand-name">MIROSHARK</div>
          <div className="brand-sub">TERMINAL · v0.4.7</div>
        </div>
      </div>

      <div className="side-section">
        <div className="side-h">DETECTORS · 03/08</div>
        <ul className="tools">
          {TOOLS.map(t => (
            <li
              key={t.id}
              className={"tool " + (active === t.id ? 'is-active' : '')}
              onClick={() => onPick(t.id)}
            >
              <div className="tool-row">
                <span className="tool-code">{t.code}</span>
                <span className="tool-name">{t.name}</span>
                <span className="tool-dot">●</span>
              </div>
              <div className="tool-desc">{t.desc}</div>
            </li>
          ))}
          {/* offline detectors */}
          {[
            ['M-04','MEMPOOL WATCH'],
            ['P-05','PROPAGATION'],
            ['F-06','FLOW PRESSURE'],
            ['O-07','ORACLE LAG'],
            ['X-08','CLUSTER SCAN'],
          ].map(([code, name]) => (
            <li key={code} className="tool tool-off">
              <div className="tool-row">
                <span className="tool-code">{code}</span>
                <span className="tool-name">{name}</span>
                <span className="tool-dot off">○</span>
              </div>
              <div className="tool-desc">— offline · queued</div>
            </li>
          ))}
        </ul>
      </div>

      <div className="side-section">
        <div className="side-h">ALERTS · {alerts.length}</div>
        <ul className="alerts">
          {alerts.map((a, i) => (
            <li key={i} className={"alert sev-" + a.sev}>
              <div className="alert-time">{a.t}</div>
              <div className="alert-msg">{a.msg}</div>
            </li>
          ))}
        </ul>
      </div>

      <div className="side-foot">
        <div className="foot-row"><span>BUILT WITH</span><span className="mono-blue">CLAUDE OPUS 4.7</span></div>
        <div className="foot-row"><span>STACK</span><span>VPS · $25/mo</span></div>
        <div className="foot-row"><span>UPTIME</span><span>04d 11h 38m</span></div>
      </div>
    </aside>
  );
}

Object.assign(window, { TOOLS, useNow, fmtTime, fmtDate, pad, Cursor, StatusBar, Ticker, Sidebar });
