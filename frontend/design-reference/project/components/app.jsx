// Main app
const { useState, useEffect, useRef, useMemo } = React;

const TICKER_ITEMS = [
  { sym:'NK-SUMMIT',  px:'0.371', d:'+1.2%',  dir:'up' },
  { sym:'PLAT-12',    px:'0.082', d:'+18.4%', dir:'up' },
  { sym:'BTC-150',    px:'0.412', d:'-0.4%',  dir:'dn' },
  { sym:'LUNAR-GW',   px:'0.224', d:'+3.1%',  dir:'up' },
  { sym:'TYP-PAC',    px:'0.118', d:'+9.0%',  dir:'up' },
  { sym:'ECB-CUT',    px:'0.547', d:'+0.6%',  dir:'up' },
  { sym:'AMZN-SPLIT', px:'0.198', d:'+2.4%',  dir:'up' },
  { sym:'OIL-90',     px:'0.612', d:'-1.1%',  dir:'dn' },
  { sym:'TWN-INC',    px:'0.064', d:'+12.7%', dir:'up' },
  { sym:'GPT-IPO',    px:'0.288', d:'+0.3%',  dir:'flat' },
  { sym:'EQUITY',     px:'$19,796', d:'+1,302', dir:'up' },
  { sym:'SHARPE',     px:'2.86',  d:'rolling 30d', dir:'flat' },
];

const ALERTS = [
  { sev:2, t:'11:19:04 UTC', msg:'NK-SUMMIT cryo latched · tier 2' },
  { sev:2, t:'10:31:47 UTC', msg:'ECB-CUT cluster +2 wallets' },
  { sev:1, t:'09:55:12 UTC', msg:'LUNAR-GW entropy 1.74' },
  { sev:1, t:'09:12:30 UTC', msg:'AMZN-SPLIT mempool spike' },
  { sev:0, t:'08:42:51 UTC', msg:'PLAT-12 freeze · low vol' },
  { sev:0, t:'07:03:18 UTC', msg:'TYP-PAC accumulation +4w' },
];

function App() {
  const [tool, setTool] = useState(() => localStorage.getItem('miro.tool') || 'entropy');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 80);
    return () => clearInterval(id);
  }, []);

  useEffect(() => { localStorage.setItem('miro.tool', tool); }, [tool]);

  // jittery latencies
  const latency = useMemo(() => ({
    pmk: 28 + ((tick * 7) % 8),
    ksh: 16 + ((tick * 3) % 6),
    orc: 51 + ((tick * 5) % 9),
    chn: 12 + ((tick * 2) % 5),
  }), [Math.floor(tick / 4)]);

  return (
    <div className="app">
      <StatusBar tool={tool} latency={latency} equity={19796} />
      <Sidebar active={tool} onPick={setTool} alerts={ALERTS} />
      <main className="main" data-screen-label={tool.toUpperCase()}>
        {tool === 'entropy'  && <EntropyGauge tick={tick} />}
        {tool === 'cryo'     && <CryoScanner tick={tick} />}
        {tool === 'topology' && <TopologyMap tick={tick} />}
      </main>
      <Ticker items={TICKER_ITEMS} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
