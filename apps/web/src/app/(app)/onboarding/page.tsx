import { redirect } from "next/navigation";
import type { OnboardingContextResponse } from "@companion/contracts";
import { serverApiFetch } from "@/lib/apiServer";
import { OnboardingFlow } from "@/components/onboarding/OnboardingFlow";
import type { OnboardingContext } from "@/lib/onboarding";

export const dynamic = "force-dynamic";

interface WhoAmI {
  userId: string;
  email: string;
  name: string;
  onboarded?: boolean;
}

export default async function OnboardingPage() {
  const whoami = await serverApiFetch<WhoAmI>("/v1/auth/whoami").catch(() => null);
  if (!whoami) redirect("/login");
  if (whoami.onboarded) redirect("/skills");

  const raw = await serverApiFetch<OnboardingContextResponse>("/v1/onboarding/context").catch(() => null);
  const context: OnboardingContext = raw
    ? {
        email: raw.email,
        domain: raw.domain,
        isPersonal: raw.is_personal,
        matchedOrgs: (raw.matched_orgs ?? []).map((org) => ({
          id: org.id,
          name: org.name,
          domain: org.domain,
          memberCount: org.member_count,
        })),
      }
    : { email: whoami.email, domain: null, isPersonal: false, matchedOrgs: [] };

  return <OnboardingFlow context={context} me={{ name: whoami.name, email: whoami.email }} />;
}
