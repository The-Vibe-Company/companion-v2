import { SettingsApp } from "@/components/org/SettingsApp";
import { WorkspaceLoadError } from "@/components/org/WorkspaceLoadError";
import { loadSettingsPageData, type SettingsSearchParams } from "@/lib/settingsData";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: SettingsSearchParams;
}) {
  const props = await loadSettingsPageData(searchParams);
  if (!props) return <WorkspaceLoadError />;
  return <SettingsApp {...props} />;
}
