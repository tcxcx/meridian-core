import { MirosharkNotFoundPanel } from '../../../packages/ui/src/components/not-found-panel.jsx'

export default function NotFound() {
  return (
    <MirosharkNotFoundPanel
      href="/"
      label="Return home"
      title="Page not found."
      copy="Return to MiroShark."
      projectId="qT0L8TGSHpf4rnpGbBUr"
      eyebrow="404 // Public route missing"
    />
  )
}
