import {
  CompanionProviderError,
  CompanionRuntimeTransitionError,
  sanitizeCompanionRuntimeError,
} from "@companion/core";
import { BoxRuntimeConfigurationError, BoxRuntimeProviderError } from "./boxCompanionRuntime";

/**
 * Line for a failure this surface does not model. Storage, database, and unexpected adapter errors
 * carry internal text, so only the recognized runtime failures explain themselves to an operator.
 */
export const COMPANION_RUNTIME_UNKNOWN_ERROR =
  "This Companion could not be started. Try again, and check the API logs if it keeps failing.";

/**
 * One operator-readable line for a lifecycle failure, stored on the Companion and returned by the
 * failing request. Configuration, Box, and Pi failures keep their own wording so an operator can
 * tell a missing `COMPANION_BOX_API_KEY` from a Box rejection or a Pi that never came up.
 */
export function companionRuntimeErrorMessage(error: unknown): string {
  if (
    error instanceof BoxRuntimeConfigurationError
    || error instanceof BoxRuntimeProviderError
    || error instanceof CompanionProviderError
    || error instanceof CompanionRuntimeTransitionError
  ) {
    return sanitizeCompanionRuntimeError(error.message) || COMPANION_RUNTIME_UNKNOWN_ERROR;
  }
  return COMPANION_RUNTIME_UNKNOWN_ERROR;
}

/** Failures whose message is safe to return verbatim in the response body. */
export function isBoxRuntimeFailure(error: unknown): boolean {
  return error instanceof BoxRuntimeConfigurationError
    || error instanceof BoxRuntimeProviderError;
}
