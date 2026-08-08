import { redirect } from "next/navigation";
import { LandingPage } from "@/components/landing/LandingPage";
import { AuthUnavailable } from "@/components/org/WorkspaceLoadError";
import { loadServerAuth } from "@/lib/serverAuth";

export default async function Home() {
  const authState = await loadServerAuth();
  if (authState.status === "authenticated") redirect("/skills");
  if (authState.status === "unavailable") return <AuthUnavailable />;
  return <LandingPage />;
}
