import { SummaryGrid } from '../components/summary-grid'
import { TerminalCard } from '../components/terminal-card'
import { TerminalShell } from '../components/terminal-shell'

const meta = {
  title: 'Terminal/Primitives',
  parameters: {
    layout: 'fullscreen',
  },
}

export default meta

export const ShellAndCards = {
  render: () => (
    <TerminalShell
      subtitle="shared ui specimen"
      status={[
        { label: 'signal', value: 'online' },
        { label: 'router', value: 'online' },
        { label: 'openclaw', value: 'ready' },
      ]}
      rail={
        <>
          <TerminalCard chip="OPS" eyebrow="Operator Context" title="Compact support context">
            <dl className="ms-metric-list">
              <div className="ms-metric-row"><dt>Mode</dt><dd>manual</dd></div>
              <div className="ms-metric-row"><dt>Tenant</dt><dd>main</dd></div>
              <div className="ms-metric-row"><dt>Capital</dt><dd>$110.00</dd></div>
            </dl>
          </TerminalCard>
        </>
      }
      stage={
        <>
          <TerminalCard
            chip="ACT 1"
            eyebrow="Opportunity"
            right="live"
            title="One dominant live work surface"
            copy="The stage card should carry the current decision or ceremony. Support context belongs in the rail."
          >
            <SummaryGrid
              items={[
                ['Market', 'BTC > 150k in 2026'],
                ['Swarm verdict', 'No · 0.75 confidence'],
                ['Edge', '-1.65pp'],
                ['Deploy band', '$0.10 – $0.50'],
              ]}
            />
          </TerminalCard>
        </>
      }
    />
  ),
}

