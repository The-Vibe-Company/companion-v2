import type {
  CompanionTrigger,
  CompanionTriggerMode,
  CompanionTriggerProvider,
  CompanionTriggerRegistrationStatus,
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
export type CompanionTriggerV2Provider = CompanionTriggerProvider;
export type CompanionTriggerV2Mode = CompanionTriggerMode;
export type CompanionTriggerV2RegistrationStatus = CompanionTriggerRegistrationStatus;
export type CompanionTriggerV2 = CompanionTrigger;

/** A credential-free member account projection shared by every Companion in the workspace. */
export interface CompanionTriggerAccountOption {
  id: string;
  provider: string;
  label: string;
  connected?: boolean;
}

/** Additive request shape sent by the Trigger v2 editor. */
export type CreateCompanionTriggerV2Input = CreateCompanionTriggerInput;
export type UpdateCompanionTriggerV2Input = UpdateCompanionTriggerInput;
