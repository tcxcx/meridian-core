export function SetupProgress({ steps, activeStep, complete = {}, progress = 0 }) {
  return (
    <div className="ms-card">
      <div className="ms-card-head">
        <div className="ms-card-head-l">
          <span className="ms-chip">SET</span>
          <span className="ms-card-eyebrow">Setup Progress</span>
        </div>
        <span className="ms-card-head-r">{progress}%</span>
      </div>
      <div className="ms-card-title">Setup</div>
      <p className="ms-card-copy">
        Finish each step in order.
      </p>
      <div className="ms-progress-track" aria-hidden="true">
        <div className="ms-progress-fill" style={{ width: `${progress}%` }} />
      </div>
      <div className="ms-progress-list">
        {steps.map((step, index) => {
          const done = Boolean(complete[step.key])
          const current = activeStep === step.key
          return (
            <a
              key={step.key}
              href={step.href || '#'}
              className={`ms-progress-link${done ? ' is-complete' : ''}${current ? ' is-current' : ''}`}
            >
              <span className="ms-progress-index">{done ? '✓' : index + 1}</span>
              <span className="ms-progress-body">
                <strong>{step.label}</strong>
                <span className="ms-progress-description">{step.description}</span>
              </span>
              <span className="ms-progress-state">{current ? 'live' : done ? 'done' : 'pending'}</span>
            </a>
          )
        })}
      </div>
    </div>
  )
}
