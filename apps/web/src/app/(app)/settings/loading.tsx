export default function Loading() {
  return (
    <div className="app">
      <aside className="side" />
      <div className="main">
        <div className="og-set">
          <div className="og-set__top">
            <div className="og-set__crumb">Settings</div>
          </div>
          <div className="og-set__body">
            <nav className="og-snav" />
            <div className="og-pane">
              <div className="og-pane__inner">
                <div className="og-pane__head">
                  <h2 className="og-pane__title">Members</h2>
                  <p className="og-pane__desc">Loading…</p>
                </div>
                <div className="og-mlist">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div className="og-mrow" key={i}>
                      <div
                        style={{
                          height: 16,
                          borderRadius: 4,
                          background: "var(--color-surface-raised)",
                          width: `${55 + ((i * 7) % 35)}%`,
                        }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
