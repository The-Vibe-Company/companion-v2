import { Icon } from "@/components/Icon";

/** Immediate route feedback while the control-plane conversation list is being read. */
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
        <nav className="modeseg" aria-label="Workspace mode">
          <span className="modeseg__btn">
            <span className="modeseg__ico"><Icon name="layers" size={15} /></span>
            <span className="modeseg__label">Skills</span>
          </span>
          <span className="modeseg__btn is-active" aria-current="page">
            <span className="modeseg__ico"><Icon name="bot" size={15} /></span>
            <span className="modeseg__label">Companions</span>
          </span>
        </nav>
        <nav className="side__nav" aria-label="Loading conversations">
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
            <span className="navitem__ico"><Icon name="key-round" /></span>
            <span className="skel skel--navlabel" />
          </span>
          <span className="navitem">
            <span className="navitem__ico"><Icon name="archive" /></span>
            <span className="skel skel--navlabel" />
          </span>
        </nav>
      </aside>

      <main className="companions-main">
        <header className="companions-head">
          <h1>Companions</h1>
          <span className="skel skel--button" />
        </header>
        <div className="companions-content">
          <div className="companions-list">
            <div className="companions-row companions-row--head">
              <span>Companion</span>
              <span>Status</span>
              <span>Updated</span>
              <span>Access</span>
            </div>
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
        <p className="sr-only" role="status">Loading Companions…</p>
      </main>
    </div>
  );
}
