import { MirosharkUnicornScene } from '../../../packages/ui/src/components/unicorn-scene.jsx'

import WaitlistForm from '../components/waitlist-form'

const SETUP_STEPS = [
  ['01', 'Bootstrap the private room, operator identity, and collaborative state.'],
  ['02', 'Provision the Polygon treasury with passkeys, recovery, and signer expansion.'],
  ['03', 'Confirm the agent trading wallet and deployable Polygon Amoy budget.'],
  ['04', 'Attach OpenClaw so your own operator runtime can manage policy-bound execution.'],
]

const STORY_CARDS = [
  {
    kicker: 'User Story',
    title: 'Rehearse the market before capital moves.',
    copy:
      'MiroShark treats prediction markets like a live operating desk. Swarms debate, graph intelligence accumulates, and only then does the operator fund the agent path.',
    rows: [
      ['AXL mesh', 'Belief propagation over the swarm'],
      ['MiroFish graph', 'Scenario rehearsal engine'],
      ['Operator terminal', 'Human + AI accountability surface'],
    ],
  },
  {
    kicker: 'Custody Story',
    title: 'Treasury and trading are separated by design.',
    copy:
      'The setup route is not an afterthought. It is where passkeys, signer policy, modular treasury control, and the trading wallet split are established before any live operation.',
    rows: [
      ['Treasury', 'High-trust custody and recovery'],
      ['Trading wallet', 'Budgeted execution rail'],
      ['Provision rule', '10% treasury tranche by policy'],
    ],
  },
  {
    kicker: 'Automation Story',
    title: 'OpenClaw enters only after the rails are clean.',
    copy:
      'The public landing tells the same truth as the app: external automation is attached only after custody, funding, and operator permissions are explicit.',
    rows: [
      ['OpenClaw', 'Bring your own operator runtime'],
      ['Keeper policy', 'Position and replenishment guardrails'],
      ['Launch route', 'Only goes live after setup is green'],
    ],
  },
]

export default function WebHome() {
  const appOrigin = (process.env.NEXT_PUBLIC_APP_URL || 'http://127.0.0.1:3301').replace(/\/$/, '')

  return (
    <MirosharkUnicornScene variant="marketing">
      <div className="mw-shell">
        <div className="mw-frame">
          <header className="mw-header mw-reveal" data-step="1">
            <div className="mw-brand">
              <div className="mw-brand-copy">
                <div className="mw-brand-mark mw-brand-title">MiroShark</div>
                <div className="mw-brand-sub">graph-native prediction market hedge fund terminal</div>
              </div>
            </div>
            <nav className="mw-nav" aria-label="MiroShark sections">
              <a className="mw-link" href="#story">User story</a>
              <a className="mw-link" href="#setup">Setup route</a>
              <a className="mw-link" href="#waitlist">Waitlist</a>
            </nav>
            <div className="mw-actions">
              <a className="mw-btn-secondary" href={`${appOrigin}/sign-in`}>Sign in</a>
              <a className="mw-btn-primary" href={`${appOrigin}/sign-up`}>Sign up</a>
            </div>
          </header>

          <main className="mw-main">
            <section className="mw-hero">
              <article className="mw-panel mw-reveal" data-step="2">
                <div className="mw-kicker-row">
                  <span className="mw-mini-kicker">Private operator product</span>
                  <span className="mw-chip">Polygon-first</span>
                  <span className="mw-chip">Swarm-driven</span>
                </div>
                <h1 className="mw-title">Trade prediction markets from one living console.</h1>
                <p className="mw-lede">
                  MiroShark combines MiroFish graph analysis, treasury custody, agent trading rails, and operator automation into one product. Public landing, sign-in, setup, and terminal now all speak the same command language.
                </p>
                <div className="mw-hero-actions">
                  <a className="mw-btn-primary" href={`${appOrigin}/sign-up`}>Start private setup</a>
                  <a className="mw-btn-secondary" href={`${appOrigin}/setup/treasury`}>View treasury route</a>
                </div>

                <div className="mw-stat-grid">
                  <div className="mw-stat-card mw-reveal" data-step="3">
                    <div className="mw-stat-label">Main surface</div>
                    <div className="mw-stat-value">1</div>
                    <div className="mw-stat-copy">Landing, setup, and operator terminal now share one visual system and one chain-of-control story.</div>
                  </div>
                  <div className="mw-stat-card mw-reveal" data-step="4">
                    <div className="mw-stat-label">Core routes</div>
                    <div className="mw-stat-value">5</div>
                    <div className="mw-stat-copy">Workspace, treasury, trading, OpenClaw, launch. The setup flow is a first-class product route, not modal debris.</div>
                  </div>
                  <div className="mw-stat-card mw-reveal" data-step="5">
                    <div className="mw-stat-label">Execution thesis</div>
                    <div className="mw-stat-value">ROI</div>
                    <div className="mw-stat-copy">Swarm analysis exists to rank and deploy capital into real market opportunities, not to produce orphan research.</div>
                  </div>
                </div>
              </article>

              <aside className="mw-console mw-reveal" data-step="3" id="setup">
                <div className="mw-console-head">
                  <span className="mw-brand-mark">Setup Console</span>
                  <span className="mw-chip">/setup</span>
                </div>
                <div className="mw-console-body">
                  <h2 className="mw-console-title">A setup route only MiroShark has.</h2>
                  <p className="mw-console-copy">
                    Sendero-style auth entry, but with a fund-operator setup ceremony: treasury first, trading second, OpenClaw after policy, launch only after the rails are green.
                  </p>
                  <div className="mw-route-list">
                    {SETUP_STEPS.map(([index, copy]) => (
                      <div className="mw-route-item" key={index}>
                        <span className="mw-step-index">{index}</span>
                        <div className="mw-route-body">
                          <strong>Route {index}</strong>
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
                {[
                  'MiroFish swarm graph',
                  'Polygon treasury custody',
                  'Polygon Amoy execution rail',
                  'Circle modular wallet ceremony',
                  'OpenClaw operator runtime',
                  'Portfolio performance tracking',
                  'Prediction market alpha board',
                  'Private setup routes',
                ].concat([
                  'MiroFish swarm graph',
                  'Polygon treasury custody',
                  'Polygon Amoy execution rail',
                  'Circle modular wallet ceremony',
                  'OpenClaw operator runtime',
                  'Portfolio performance tracking',
                  'Prediction market alpha board',
                  'Private setup routes',
                ]).map((item, index) => (
                  <span className="mw-proof-item" key={`${item}-${index}`}>{item}</span>
                ))}
              </div>
            </section>

            <section className="mw-story-grid" id="story">
              {STORY_CARDS.map((card, index) => (
                <article className="mw-story-card mw-reveal" data-step={String(index + 2)} key={card.title}>
                  <div className="mw-card-kicker">{card.kicker}</div>
                  <h2 className="mw-story-title">{card.title}</h2>
                  <p className="mw-story-copy">{card.copy}</p>
                  <ul className="mw-story-list">
                    {card.rows.map(([label, value]) => (
                      <li key={label}>
                        <span>{label}</span>
                        <span>{value}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </section>

            <section className="mw-access-grid">
              <article className="mw-waitlist-card mw-reveal" data-step="4" id="waitlist">
                <div className="mw-card-kicker">Waitlist</div>
                <h2 className="mw-section-title">Request operator access.</h2>
                <p className="mw-section-copy">
                  This is not a mass-market product. The waitlist captures who wants the setup, what they want the agent to control, and where treasury/trading automation should begin.
                </p>
                <WaitlistForm />
              </article>

              <article className="mw-route-card mw-reveal" data-step="5">
                <div className="mw-card-kicker">Setup flow</div>
                <h2 className="mw-section-title">Landing to setup, no visual whiplash.</h2>
                <p className="mw-section-copy">
                  The public page and the authenticated setup now share the same full-bleed Unicorn scene and the same console grammar. The landing does not promise one product and then hand off to another.
                </p>
                <div className="mw-route-list">
                  <div className="mw-route-item">
                    <span className="mw-step-index">A</span>
                    <div className="mw-route-body">
                      <strong>Sign in or sign up</strong>
                      <span>Entry points route into the authenticated app, not to an unrelated marketing shell.</span>
                    </div>
                  </div>
                  <div className="mw-route-item">
                    <span className="mw-step-index">B</span>
                    <div className="mw-route-body">
                      <strong>Treasury ceremony</strong>
                      <span>Passkey and signer expansion live on `/setup/treasury`, not buried in the main terminal.</span>
                    </div>
                  </div>
                  <div className="mw-route-item">
                    <span className="mw-step-index">C</span>
                    <div className="mw-route-body">
                      <strong>Launch only after policy</strong>
                      <span>The operator terminal opens only after custody, trading rails, and external operator state are explicit.</span>
                    </div>
                  </div>
                </div>
              </article>
            </section>
          </main>

          <footer className="mw-footer-note">
            <span>MiroShark design system: blue-command brutalism, financial density, swarm theater.</span>
            <span>Public face, setup route, and terminal now share one scene and one grammar.</span>
          </footer>
        </div>
      </div>
    </MirosharkUnicornScene>
  )
}
