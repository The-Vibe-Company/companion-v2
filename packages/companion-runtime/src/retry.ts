export const RUNTIME_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export type IdempotentLifecycleCall =
  | "list_boxes"
  | "get_status"
  | "resume_box"
  | "stop_box"
  | "restart_pi"
  | "start_pi"
  | "stop_pi"
  | "apply_box_settings"
  | "apply_runtime_settings"
  | "request_delete"
  | "poll_delete"
  | "ack_events";

export type NonRetryableRuntimeCall = "create_box" | "prompt" | "decision";

export interface RetryClock {
  now(): Date;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export interface RetryableProviderError {
  retryable?: boolean;
  status?: number;
}

function retryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as RetryableProviderError;
  if (candidate.retryable === true) return true;
  return candidate.status === 408
    || candidate.status === 425
    || candidate.status === 429
    || (typeof candidate.status === "number" && candidate.status >= 500);
}

function jittered(base: number, sample: number): number {
  const bounded = Math.min(1, Math.max(0, Number.isFinite(sample) ? sample : 0.5));
  return Math.max(1, Math.round(base * (0.8 + (bounded * 0.4))));
}

/**
 * Run once immediately, then at most five retries on a known-idempotent provider operation.
 * Create and broker writes cannot be represented by `IdempotentLifecycleCall`.
 */
export async function retryIdempotentLifecycle<T>(input: {
  call: IdempotentLifecycleCall;
  operation(signal: AbortSignal | undefined): Promise<T>;
  clock: RetryClock;
  jitter: () => number;
  deadlineAt?: Date;
  signal?: AbortSignal;
  beforeAttempt?: () => Promise<void>;
}): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RUNTIME_RETRY_DELAYS_MS.length; attempt += 1) {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("Runtime retry aborted");
    if (input.deadlineAt && input.clock.now().getTime() >= input.deadlineAt.getTime()) {
      throw lastError ?? new Error("Runtime retry deadline elapsed");
    }
    if (attempt > 0) {
      const delay = jittered(RUNTIME_RETRY_DELAYS_MS[attempt - 1]!, input.jitter());
      const remaining = input.deadlineAt
        ? input.deadlineAt.getTime() - input.clock.now().getTime()
        : Number.POSITIVE_INFINITY;
      if (remaining <= delay) throw lastError;
      await input.clock.sleep(delay, input.signal);
    }
    await input.beforeAttempt?.();
    try {
      return await input.operation(input.signal);
    } catch (error) {
      lastError = error;
      if (!retryable(error) || attempt === RUNTIME_RETRY_DELAYS_MS.length) throw error;
    }
  }
  throw lastError;
}
