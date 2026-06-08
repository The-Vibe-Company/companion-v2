import { SettingsDrawer } from "@/components/org/SettingsDrawer";
import { loadSettingsPageData, type SettingsSearchParams } from "@/lib/settingsData";

export const dynamic = "force-dynamic";

export default async function InterceptedSettingsPage({
  searchParams,
}: {
  searchParams: SettingsSearchParams;
}) {
  const props = await loadSettingsPageData(searchParams);
  if (!props) {
    return (
      <div className="settings-drawer">
        <div className="settings-drawer__panel">
          <div className="og-set">
            <div className="og-set__top">
              <a className="og-set__back" href="/skills">
                Back to skills
              </a>
              <div className="og-set__crumb">
                <b>Companion</b>
              </div>
            </div>
            <div className="og-pane">
              <div className="og-pane__inner">
                <div className="empty">
                  <div className="empty__title">Couldn't load workspace</div>
                  <div className="empty__desc">
                    Refresh the page to try again. If the problem continues, check that the API and
                    database are reachable.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return <SettingsDrawer {...props} />;
}
