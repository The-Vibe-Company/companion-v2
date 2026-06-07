"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { acceptInvite, createOrg as createOrgRpc, setCurrentOrg } from "@/lib/org";
import type { OnboardingMode } from "./Onboarding";

/** Shell-level workspace actions shared by the Skills + Settings shells. */
export function useOrgActions() {
  const router = useRouter();
  const [onboarding, setOnboarding] = useState<OnboardingMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchOrg = async (id: string) => {
    setBusy(true);
    try {
      await setCurrentOrg(id);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createOrg = async (name: string, kind: "personal" | "team") => {
    setBusy(true);
    try {
      const { id } = await createOrgRpc(name, kind);
      await setCurrentOrg(id);
      setOnboarding(null);
      router.push("/skills");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const joinOrg = async (codeOrLink: string) => {
    const token = codeOrLink.includes("/join/")
      ? (codeOrLink.split("/join/").pop() ?? "").trim()
      : codeOrLink.trim();
    setBusy(true);
    try {
      const { orgId } = await acceptInvite(token);
      if (orgId) await setCurrentOrg(orgId);
      setOnboarding(null);
      router.push("/skills");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return { onboarding, setOnboarding, busy, error, setError, switchOrg, createOrg, joinOrg };
}
