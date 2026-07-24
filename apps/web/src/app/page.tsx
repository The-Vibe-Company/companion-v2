import { redirect } from "next/navigation";
import { serverApiFetch } from "@/lib/apiServer";
import { LandingPage } from "@/components/landing/LandingPage";
import { projectsFeatureEnabled } from "@/lib/projectsFeature";

export default async function Home() {
  const user = await serverApiFetch<{ email: string }>("/v1/auth/whoami").catch(() => null);
  if (user) redirect(projectsFeatureEnabled(user.email) ? "/projects" : "/skills");
  return <LandingPage />;
}
