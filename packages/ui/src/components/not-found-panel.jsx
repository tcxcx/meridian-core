import { MirosharkUnicornScene } from './unicorn-scene.jsx'

export function MirosharkNotFoundPanel({
  href = '/',
  label = 'Return home',
  title = 'Page not found.',
  copy = 'The route you requested is not part of the active MiroShark command surface.',
  projectId = 'qT0L8TGSHpf4rnpGbBUr',
  variant = 'not-found',
  eyebrow = '404 // Route missing',
}) {
  return (
    <MirosharkUnicornScene
      variant={variant}
      projectId={projectId}
      className="ms-not-found-scene"
      contentClassName="ms-not-found-content"
    >
      <main className="ms-not-found-shell">
        <section className="ms-not-found-panel">
          <div className="ms-not-found-eyebrow">{eyebrow}</div>
          <h1 className="ms-not-found-title">{title}</h1>
          <p className="ms-not-found-copy">{copy}</p>
          <a className="ms-not-found-action" href={href}>
            {label}
          </a>
        </section>
      </main>
    </MirosharkUnicornScene>
  )
}
