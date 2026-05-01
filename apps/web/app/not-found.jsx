import { MirosharkNotFoundPanel } from '../../../packages/ui/src/components/not-found-panel.jsx'

export default function NotFound() {
  return (
    <MirosharkNotFoundPanel
      href="/"
      label="Return home"
      title="This page drifted off the desk."
      copy="The public route you requested is not part of the active MiroShark surface. Return to the landing page and continue from the main entry."
      projectId="qT0L8TGSHpf4rnpGbBUr"
      eyebrow="404 // Public route missing"
    />
  )
}
