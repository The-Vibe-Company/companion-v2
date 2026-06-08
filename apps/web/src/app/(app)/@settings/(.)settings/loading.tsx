export default function Loading() {
  return (
    <div className="settings-drawer settings-drawer--loading" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading settings…</span>
      <div className="settings-drawer__panel" aria-hidden="true">
        <div className="og-set">
          <div className="og-set__top">
            <div className="og-set__back skel skel--settings-back" />
            <div className="skel skel--settings-crumb" />
          </div>
          <div className="og-set__body">
            <nav className="og-snav">
              <div className="og-snav__label">Workspace</div>
              <div className="og-snav__item is-active">
                <span className="og-snav__av" />
                <span className="skel skel--settings-nav" />
              </div>
              <div className="og-snav__item">
                <span className="skel skel--settings-icon" />
                <span className="skel skel--settings-nav" />
              </div>
              <div className="og-snav__item">
                <span className="skel skel--settings-icon" />
                <span className="skel skel--settings-nav" />
              </div>
            </nav>
            <div className="og-pane">
              <div className="og-pane__inner">
                <div className="og-pane__head">
                  <div className="skel skel--settings-title" />
                  <div className="skel skel--settings-desc" />
                </div>
                <div className="og-mlist">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div className="og-mrow" key={i}>
                      <div className="skel" style={{ width: `${58 + ((i * 9) % 28)}%` }} />
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
