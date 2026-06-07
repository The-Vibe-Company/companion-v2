import { Icon } from "../Icon";

export function SettingsOnlySidebar() {
  return (
    <aside className="side" aria-label="Settings">
      <div className="side__nav">
        <div className="navitem navitem--active navitem--static">
          <span className="navitem__ico">
            <Icon name="settings" />
          </span>
          Settings
        </div>
      </div>
    </aside>
  );
}
