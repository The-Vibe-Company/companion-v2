/** Generic route feedback while access and workspace data are being resolved. */
export default function CompanionsLoading() {
  return (
    <div className="app app--skills companions-app skel-shell" aria-busy="true">
      <aside className="side" aria-hidden="true">
        <div className="side__brand">
          <span className="brandmark skel__brandmark" />
          <span className="skel__brandmeta">
            <span className="skel skel--brandname" />
            <span className="skel skel--brandsub" />
          </span>
        </div>
        <div className="modeseg">
          <span className="modeseg__btn"><span className="skel skel--navlabel" /></span>
          <span className="modeseg__btn"><span className="skel skel--navlabel" /></span>
        </div>
        <div className="side__nav">
          {[0, 1, 2].map((row) => (
            <span className="cmprow skel__row" key={row}>
              <span className="companions-avatar"><span className="skel skel--short" /></span>
              <span className="cmprow__body">
                <span className="skel skel--wide" />
                <span className="skel skel--navlabel" />
              </span>
            </span>
          ))}
          <span className="navitem navitem--bottom">
            <span className="skel skel--short" />
            <span className="skel skel--navlabel" />
          </span>
          <span className="navitem">
            <span className="skel skel--short" />
            <span className="skel skel--navlabel" />
          </span>
        </div>
      </aside>

      <main className="companions-main">
        <header className="companions-head">
          <span className="skel skel--brandname" />
          <span className="skel skel--button" />
        </header>
        <div className="companions-content">
          <div className="companions-list">
            {[0, 1, 2, 3].map((row) => (
              <div className="companions-row skel__row" key={row}>
                <span className="skel skel--wide" />
                <span className="skel skel--pill" />
                <span className="skel skel--updated" />
                <span className="skel skel--role" />
              </div>
            ))}
          </div>
        </div>
        <p className="sr-only" role="status">Loading workspace…</p>
      </main>
    </div>
  );
}
