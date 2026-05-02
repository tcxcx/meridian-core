import { MirosharkNotFoundPanel } from '../../../packages/ui/src/components/not-found-panel.jsx'

export default function NotFound() {
  return (
    <MirosharkNotFoundPanel
      href="/"
      label="Return to setup"
      title="Command route not found."
      copy="Return to setup."
      projectId="qT0L8TGSHpf4rnpGbBUr"
      eyebrow="404 // Operator route missing"
    />
  )
}
