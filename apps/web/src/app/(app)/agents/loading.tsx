import { Icon } from "@/components/Icon";

const ROW_WIDTHS = ["78%", "56%", "70%", "48%", "64%", "74%", "52%"];
const GRID = { gridTemplateColumns: "minmax(200px,1fr) 92px 110px 96px 158px 92px", minWidth: 840 } as const;

export default function Loading() {
  return (
    <div className="app app--skills skel-shell" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading agents...</span>
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
          <div className="navitem navitem--active">
            <span className="navitem__ico">
              <Icon name="bot" />
            </span>
            <span className="navitem__label skel skel--navlabel" />
            <span className="navitem__count skel skel--count" />
          </div>
          <div className="navitem">
            <span className="navitem__ico">
              <Icon name="package" />
            </span>
            <span className="navitem__label skel skel--navlabel" />
            <span className="navitem__count skel skel--count" />
          </div>
          <div className="navitem">
            <span className="navitem__ico">
              <Icon name="archive" />
            </span>
            <span className="navitem__label skel skel--navlabel skel--short" />
            <span className="navitem__count skel skel--count" />
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
          <h2 className="sh__title">Agents</h2>
          <span className="sh__count tnum">0</span>
          <span className="sh__spacer" />
          <div className="btn-primary skel__upload">
            <Icon name="plus" size={14} />
            <span className="skel skel--button" />
          </div>
        </div>
        <div className="listbar">
          <span className="listbar__search">
            <Icon name="search" size={14} />
            <span className="skel skel--pill skel--wide" />
          </span>
          <span className="listbar__spacer" />
          <span className="listbar__sort">
            <Icon name="chevrons-up-down" size={13} />
            <span className="skel skel--pill" />
          </span>
        </div>
        <div className="clist">
          <div className="chead" style={GRID}>
            <span>Agent</span>
            <span>Status</span>
            <span>Client</span>
            <span>Model</span>
            <span>Skills</span>
            <span className="r">Last active</span>
          </div>
          {ROW_WIDTHS.map((width) => (
            <div className="crow skel__row" style={GRID} key={width}>
              <span className="crow__name">
                <span className="vdot vdot--unknown" />
                <span className="skel" style={{ width }} />
              </span>
              <span className="skel skel--visibility" />
              <span className="skel skel--visibility" />
              <span className="ver skel skel--version" />
              <span className="skel skel--stars" />
              <span className="r skel skel--updated" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
