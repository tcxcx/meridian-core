import { mirosharkSteps } from '../brand/miroshark-brand'
import { SummaryGrid } from '../components/summary-grid'
import { SetupProgress } from '../components/setup-progress'
import { TerminalCard } from '../components/terminal-card'
import { TerminalShell } from '../components/terminal-shell'

const meta = {
  title: 'Setup/Treasury Route',
  parameters: {
    layout: 'fullscreen',
  },
}

export default meta

export const TreasuryCeremony = {
  render: () => (
    <TerminalShell
      subtitle="setup route specimen"
      status={[
        { label: 'route', value: 'treasury' },
        { label: 'auth', value: 'clerk' },
        { label: 'setup', value: 'in progress', warn: true },
      ]}
      rail={
        <>
          <SetupProgress
            steps={mirosharkSteps.map((step) => ({ ...step, href: '#' }))}
            activeStep="treasury"
            complete={{ workspace: true }}
            progress={40}
          />
          <TerminalCard chip="OPS" eyebrow="Context" title="Operator">
            <dl className="ms-metric-list">
              <div className="ms-metric-row"><dt>User</dt><dd>owner@miroshark</dd></div>
              <div className="ms-metric-row"><dt>Persistence</dt><dd>database</dd></div>
              <div className="ms-metric-row"><dt>Workspace</dt><dd>Main Fund</dd></div>
            </dl>
          </TerminalCard>
        </>
      }
      stage={
        <TerminalCard
          chip="Step 2"
          eyebrow="Setup Route"
          right="/setup/treasury"
          title="Treasury"
          copy="Create custody."
        >
          <SummaryGrid
            items={[
              ['Funding mode', 'polygon-direct'],
              ['Treasury address', '0x0646FFe1…91eC69'],
              ['Registry plugin', 'pending'],
              ['Agent wallet', '0x0646FFe1…91eC69'],
            ]}
          />
          <div className="ms-note" style={{ marginTop: '10px' }}>
            Signer, invites, passkey.
          </div>
          <div className="ms-button-row" style={{ marginTop: '10px' }}>
            <button type="button" className="ms-btn-primary">Provision polygon mainnet treasury</button>
            <button type="button" className="ms-btn-secondary">Save signer plan</button>
          </div>
        </TerminalCard>
      }
    />
  ),
}
