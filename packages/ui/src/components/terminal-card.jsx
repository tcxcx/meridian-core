export function TerminalCard({
  chip,
  eyebrow,
  right,
  title,
  copy,
  children,
}) {
  return (
    <section className="ms-card">
      <div className="ms-card-head">
        <div className="ms-card-head-l">
          {chip ? <span className="ms-chip">{chip}</span> : null}
          {eyebrow ? <span className="ms-card-eyebrow">{eyebrow}</span> : null}
        </div>
        {right ? <span className="ms-card-head-r">{right}</span> : null}
      </div>
      {title ? <div className="ms-card-title">{title}</div> : null}
      {copy ? <p className="ms-card-copy">{copy}</p> : null}
      {children}
    </section>
  )
}

