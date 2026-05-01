export function TerminalShell({ brand = 'MIROSHARK', subtitle, status = [], rail, stage }) {
  return (
    <div className="ms-shell">
      <header className="ms-header">
        <div className="ms-brand-block">
          <div className="ms-brand-mark">{brand}</div>
          {subtitle ? <div className="ms-brand-sub">{subtitle}</div> : null}
        </div>
        <div className="ms-status-strip">
          {status.map((item) => (
            <span
              key={`${item.label}-${item.value || ''}`}
              className={`ms-status-pill${item.warn ? ' is-warn' : ''}`}
            >
              {item.value ? `${item.label} ${item.value}` : item.label}
            </span>
          ))}
        </div>
      </header>
      <main className="ms-grid">
        <aside className="ms-rail">{rail}</aside>
        <section className="ms-stage">{stage}</section>
      </main>
    </div>
  )
}

