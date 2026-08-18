import {
  RuntimeHandoffError,
  RuntimeShutdownError,
} from "./errors";
import {
  LeaseAuthorizationDeniedError,
  LeaseFenceLostError,
  LeaseRenewalError,
} from "./leaseSession";
import {
  RuntimeStoreIndeterminateError,
  RuntimeStoreSerializationError,
} from "./store";

/** Errors that represent executor control/fencing and must never be reclassified as provider I/O. */
export function mustAbandonRuntimeExecution(error: unknown): boolean {
  return error instanceof LeaseFenceLostError
    || error instanceof LeaseRenewalError
    || error instanceof LeaseAuthorizationDeniedError
    || error instanceof RuntimeStoreSerializationError
    || error instanceof RuntimeStoreIndeterminateError
    || error instanceof RuntimeHandoffError
    || error instanceof RuntimeShutdownError;
}
