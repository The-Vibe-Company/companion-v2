import { Icon } from "../Icon";

export function SettingsOnlySidebar() {
  return (
    <aside className="side">
      <nav className="side__nav" aria-label="Primary">
        <a className="navitem navitem--active" href="/settings" aria-current="page">
          <span className="navitem__ico">
            <Icon name="settings" />
          </span>
          Settings
        </a>
      </nav>
    </aside>
  );
}
