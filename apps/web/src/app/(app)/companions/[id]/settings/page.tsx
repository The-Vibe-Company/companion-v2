import CompanionsPage from "../../page";

export const dynamic = "force-dynamic";

export default async function CompanionSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return CompanionsPage({ searchParams: Promise.resolve({ settings: id }) });
}
