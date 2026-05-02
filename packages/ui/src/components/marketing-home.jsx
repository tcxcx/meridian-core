import { MirosharkUnicornScene } from './unicorn-scene.jsx'

const SETUP_STEPS = [
  ['01', 'Connect wallets', 'Treasury stays separate from trading capital.'],
  ['02', 'Run swarm analysis', 'Agents debate prediction-market edge.'],
  ['03', 'Size positions', 'Budget each trade before execution.'],
  ['04', 'Automate with OpenClaw', 'Human operator stays in control.'],
]

const PROOF_ITEMS = [
  'Swarm graph',
  'Treasury custody',
  'Trading rail',
  'Circle wallet',
  'OpenClaw',
  'Portfolio ROI',
  'Alpha board',
  'Private setup',
]

function route(origin, path) {
  return origin ? `${origin}${path}` : path
}

export function MirosharkMarketingHome({ appOrigin = '' }) {
  const normalizedOrigin = String(appOrigin || '').replace(/\/$/, '')

  return (
    <MirosharkUnicornScene variant="marketing">
      <div className="mw-shell">
        <div className="mw-frame">
          <header className="mw-header mw-reveal" data-step="1">
            <div className="mw-brand">
              <div className="mw-brand-copy">
                <div className="mw-brand-mark mw-brand-title">MiroShark</div>
                <div className="mw-brand-sub">prediction market hedge fund terminal</div>
              </div>
            </div>
            <div className="mw-actions">
              <a className="mw-btn-secondary" href={route(normalizedOrigin, '/sign-in')}>Sign in</a>
              <a className="mw-btn-primary" href={route(normalizedOrigin, '/sign-up')}>Sign up</a>
            </div>
          </header>

          <main className="mw-main">
            <section className="mw-hero" id="product">
              <article className="mw-panel mw-reveal" data-step="2">
                <div className="mw-kicker-row">
                  <span className="mw-mini-kicker">Prediction markets</span>
                  <span className="mw-chip">Swarm intelligence</span>
                  <span className="mw-chip">Wallet custody</span>
                </div>
                <h1 className="mw-title">MiroShark</h1>
                <p className="mw-lede">
                  A private hedge-fund terminal for finding, sizing, and executing prediction-market trades.
                  Agent swarms research the market, the operator approves the move, and capital flows from
                  protected treasury wallets into controlled trading wallets.
                </p>
                <div className="mw-hero-actions">
                  <a className="mw-btn-primary" href={route(normalizedOrigin, '/sign-up')}>Start setup</a>
                  <a className="mw-btn-secondary" href={route(normalizedOrigin, '/sign-in')}>Open terminal</a>
                </div>

                <div className="mw-plain-points">
                  <span>One console for signals, wallets, and trades.</span>
                  <span>1-5% position sizing before execution.</span>
                  <span>ROI tracked before automation scales.</span>
                </div>
              </article>

              <aside className="mw-console mw-reveal" data-step="3" id="setup">
                <div className="mw-console-head">
                  <span className="mw-brand-mark">Setup Console</span>
                  <span className="mw-chip">/setup</span>
                </div>
                <div className="mw-console-body">
                  <h2 className="mw-console-title">From signal to position.</h2>
                  <p className="mw-console-copy">
                    MiroShark turns swarm research into a trade workflow: custody first, analysis second,
                    execution last.
                  </p>
                  <div className="mw-route-list">
                    {SETUP_STEPS.map(([index, label, copy]) => (
                      <div className="mw-route-item" key={index}>
                        <span className="mw-step-index">{index}</span>
                        <div className="mw-route-body">
                          <strong>{label}</strong>
                          <span>{copy}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </aside>
            </section>

            <section className="mw-proof-band mw-reveal" data-step="4" aria-label="MiroShark platform proof">
              <div className="mw-proof-track">
                {PROOF_ITEMS.concat(PROOF_ITEMS).map((item, index) => (
                  <span className="mw-proof-item" key={`${item}-${index}`}>{item}</span>
                ))}
              </div>
            </section>
          </main>

          <footer className="mw-footer-note">
            <span>MiroShark</span>
            <span>Swarm. Custody. Execution.</span>
          </footer>
        </div>
      </div>
    </MirosharkUnicornScene>
  )
}
