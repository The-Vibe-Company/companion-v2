import { z } from "zod";
import { teamBrandColorSchema } from "./orgSettings";

/** A domain-access org surfaced during onboarding. The id is safe: join is re-verified server-side. */
export const onboardingMatchedOrgSchema = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string(),
  member_count: z.number().int().nonnegative(),
});
export type OnboardingMatchedOrg = z.infer<typeof onboardingMatchedOrgSchema>;

/** Response of `GET /v1/onboarding/context` — the email-domain classification driving the flow. */
export const onboardingContextSchema = z.object({
  email: z.string(),
  domain: z.string().nullable(),
  is_personal: z.boolean(),
  matched_orgs: z.array(onboardingMatchedOrgSchema).default([]),
});
export type OnboardingContextResponse = z.infer<typeof onboardingContextSchema>;

export const joinOnboardingOrgInputSchema = z.object({
  orgId: z.string().min(1),
});
export type JoinOnboardingOrgInput = z.infer<typeof joinOnboardingOrgInputSchema>;

/** Request body of `POST /v1/onboarding/create`. */
export const completeOnboardingInputSchema = z.object({
  org: z.object({
    name: z.string().min(1).max(120),
    domain: z.string().max(253).nullish(),
    autoJoin: z.boolean().default(false),
    color: teamBrandColorSchema.nullish(),
    logoUrl: z.string().url().max(2048).nullish(),
  }),
  invites: z.array(z.string().email()).max(50).default([]),
});
export type CompleteOnboardingInput = z.infer<typeof completeOnboardingInputSchema>;
