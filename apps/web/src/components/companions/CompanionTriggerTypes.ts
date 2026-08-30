import type {
  CompanionTrigger,
  CompanionTriggerTarget,
  CreateCompanionTriggerInput,
  UpdateCompanionTriggerInput,
} from "@companion/contracts";

/**
 * Temporary web-side compatibility boundary for Trigger v2.
 *
 * The API/contracts package is being extended in parallel with the web surface. Keeping the
 * additive fields here means the editor can render the frozen v2 UX without weakening the
 * existing contract types everywhere else. Once the shared package carries these fields, this
 * file can become aliases to those exports.
 */
export const COMPANION_TRIGGER_V2_PROVIDERS = [
  "webhook",
  "linear",
  "github",
  "custom",
] as const;

export type CompanionTriggerV2Provider = typeof COMPANION_TRIGGER_V2_PROVIDERS[number];
export type CompanionTriggerV2Mode = "notify" | "relay";
export type CompanionTriggerV2RegistrationStatus = "manual" | "registered" | "failed";

export type CompanionTriggerV2 = Omit<
  CompanionTrigger,
  "provider" | "registration_status"
> & {
  provider: CompanionTriggerV2Provider;
  registration_status: CompanionTriggerV2RegistrationStatus;
  /** Added by Trigger v2; optional while old API responses are still in flight. */
  mode?: CompanionTriggerV2Mode;
  provider_account_id?: string | null;
  remote_hook_account_id?: string | null;
  remote_hook_id?: string | null;
  last_registration_error?: string | null;
};

/** A credential-free account projection used only to choose an attached provider account. */
export interface CompanionTriggerAccountOption {
  id: string;
  provider: string;
  label: string;
}

/** Additive request shape sent by the Trigger v2 editor. */
export type CreateCompanionTriggerV2Input = Omit<
  CreateCompanionTriggerInput,
  "provider" | "target" | "enabled"
> & {
  provider: CompanionTriggerV2Provider;
  target?: CompanionTriggerTarget | null;
  enabled?: boolean;
  mode: CompanionTriggerV2Mode;
  provider_account_id?: string;
};

export type UpdateCompanionTriggerV2Input = Omit<
  UpdateCompanionTriggerInput,
  "provider" | "target" | "enabled"
> & {
  provider?: CompanionTriggerV2Provider;
  target?: CompanionTriggerTarget | null;
  enabled?: boolean;
  mode?: CompanionTriggerV2Mode;
  provider_account_id?: string | null;
};

