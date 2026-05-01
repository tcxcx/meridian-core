import { mirosharkBrand, mirosharkSteps } from '../brand/miroshark-brand'
import { SummaryGrid } from '../components/summary-grid'
import { SetupProgress } from '../components/setup-progress'
import { TerminalCard } from '../components/terminal-card'
import { TerminalShell } from '../components/terminal-shell'

const meta = {
  title: 'Brand/Brand Book',
  parameters: {
    layout: 'fullscreen',
  },
}

export default meta

export const Overview = {
  render: () => (
    <TerminalShell
      subtitle="design contract mirrored from DESIGN.md"
      status={[
        { label: 'operator', value: 'manual' },
        { label: 'surface', value: 'storybook' },
        { label: 'design', value: 'live' },
      ]}
      rail={
        <>
          <TerminalCard chip="DNA" eyebrow="Brand Principles" title="What MiroShark should feel like">
            <ul className="ms-demo-stack">
              {mirosharkBrand.principles.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </TerminalCard>
          <TerminalCard chip="COL" eyebrow="Color System" title="Single-voltage command palette">
            <SummaryGrid
              items={Object.entries(mirosharkBrand.colors).map(([label, value]) => [label, value])}
            />
          </TerminalCard>
        </>
      }
      stage={
        <>
          <TerminalCard
            chip="ACT 0"
            eyebrow="Overview"
            right="operator-first"
            title="Graph-native swarm trading terminal"
            copy={mirosharkBrand.description}
          >
            <SummaryGrid
              items={[
                ['Display font', mirosharkBrand.typography.displayXl.join(', ')],
                ['Body font', mirosharkBrand.typography.bodyMono.join(', ')],
                ['Primary rail', mirosharkBrand.colors.operatorBlue],
                ['Base surface', mirosharkBrand.colors.paper],
              ]}
            />
          </TerminalCard>
          <SetupProgress
            steps={mirosharkSteps.map((step) => ({ ...step, href: '#' }))}
            activeStep="treasury"
            complete={{ workspace: true, trading: true }}
            progress={40}
          />
        </>
      }
    />
  ),
}

