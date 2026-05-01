export function SummaryGrid({ items }) {
  return (
    <div className="ms-summary-grid">
      {items.map(([label, value]) => (
        <div key={label} className="ms-summary-card">
          <div className="ms-summary-label">{label}</div>
          <div className="ms-summary-value">{value}</div>
        </div>
      ))}
    </div>
  )
}

