import { mirosharkBrand } from '@miroshark/ui/brand'

const meta = {
  title: 'Docs/Design Contract',
  parameters: {
    layout: 'padded',
  },
}

export default meta

export const Contract = {
  render: () => (
    <div style={{ fontFamily: 'var(--ms-font-mono)', maxWidth: 920, margin: '0 auto', color: 'var(--ms-ink)' }}>
      <h1 style={{ fontFamily: 'var(--ms-font-sans)', fontSize: 42, marginBottom: 12 }}>MiroShark design contract</h1>
      <p style={{ lineHeight: 1.7 }}>
        Storybook, <code>DESIGN.md</code>, and the app should all describe the same product language: one console, one rail color,
        one operator-first hierarchy.
      </p>
      <pre style={{ border: '1px solid var(--ms-blue)', background: 'var(--ms-paper)', padding: 16, overflow: 'auto' }}>
        {JSON.stringify(mirosharkBrand, null, 2)}
      </pre>
    </div>
  ),
}
