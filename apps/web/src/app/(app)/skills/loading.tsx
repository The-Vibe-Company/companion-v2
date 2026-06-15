import { Icon } from "@/components/Icon";

const ROW_WIDTHS = ["84%", "62%", "74%", "51%", "68%", "79%", "57%", "70%"];

export default function Loading() {
  return (
    <div className="app app--skills skel-shell" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading skills...</span>
      <aside className="side" aria-hidden="true">
        <div className="side__brand">
          <div className="side__toggle skel__iconbtn">
            <Icon name="panel-left-open" size={14} />
          </div>
          <div className="brandmark skel__brandmark" />
          <div className="skel__brandmeta">
            <div className="skel skel--brandname" />
            <div className="skel skel--brandsub" />
          </div>
          <div className="side__search skel__iconbtn">
            <Icon name="search" size={14} />
          </div>
        </div>
        <nav className="side__nav" aria-label="Primary">
          <div className="navitem">
            <span className="navitem__ico">
              <Icon name="user" />
            </span>
            <span className="navitem__label skel skel--navlabel" />
            <span className="navitem__count skel skel--count" />
          </div>
          <div className="side__grouplabel">Workspace</div>
          <div className="navitem navitem--active">
            <span className="navitem__ico">
              <Icon name="package" />
            </span>
            <span className="navitem__label skel skel--navlabel" />
            <span className="navitem__count skel skel--count" />
          </div>
          <div className="navitem navitem--muted">
            <span className="navitem__ico">
              <Icon name="square-stack" />
            </span>
            <span className="navitem__label skel skel--navlabel skel--short" />
            <span className="navitem__soon">soon</span>
          </div>
        </nav>
        <div className="side__foot side__foot--btn skel__foot">
          <Icon name="settings" size={14} />
          <span className="side__foot__label skel skel--navlabel" />
          <span className="side__foot__role skel skel--role" />
        </div>
      </aside>
      <div className="main" aria-hidden="true">
        <div className="sh">
          <h2 className="sh__title">Skills</h2>
          <span className="sh__count tnum">0</span>
          <span className="sh__spacer" />
          <div className="btn-primary skel__upload">
            <Icon name="upload" size={14} />
            <span className="skel skel--button" />
          </div>
        </div>
        <div className="cmdbar">
          <div className="pillset">
            <div className="pill is-on">
              <span className="skel skel--pill" />
            </div>
            <div className="pill">
              <span className="skel skel--pill skel--short" />
            </div>
            <div className="pill">
              <span className="skel skel--pill" />
            </div>
            <div className="pill">
              <span className="skel skel--pill skel--wide" />
            </div>
          </div>
          <span className="sh__spacer" />
          <div className="sh__iconbtn">
            <Icon name="filter" size={14} />
          </div>
        </div>
        <div className="clist">
          <div className="chead">
            <span />
            <span>Skill</span>
            <span>Visibility</span>
            <span>Version</span>
            <span className="r">Stars</span>
            <span className="r">Updated</span>
          </div>
          {ROW_WIDTHS.map((width, i) => (
            <div className="crow skel__row" key={width}>
              <span className="vdot vdot--unknown" />
              <span className="crow__name">
                <span className="skel" style={{ width }} />
              </span>
              <span className="crow__scope">
                <Icon name={i % 3 === 0 ? "building-2" : i % 3 === 1 ? "users" : "lock"} size={13} />
                <span className="skel skel--visibility" />
              </span>
              <span className="ver skel skel--version" />
              <span className="r skel skel--stars" />
              <span className="r skel skel--updated" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
