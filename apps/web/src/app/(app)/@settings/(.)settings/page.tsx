import { SettingsDrawer } from "@/components/org/SettingsDrawer";
import { loadSettingsPageData, type SettingsSearchParams } from "@/lib/settingsData";

export const dynamic = "force-dynamic";

export default async function InterceptedSettingsPage({
  searchParams,
}: {
  searchParams: SettingsSearchParams;
}) {
  const props = await loadSettingsPageData(searchParams);
  return <SettingsDrawer {...props} />;
}
