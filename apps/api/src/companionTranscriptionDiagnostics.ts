export type CompanionTranscriptionFailureCategory =
  | "transport"
  | "4xx"
  | "5xx"
  | "invalid_response";

export interface CompanionTranscriptionFailureLog {
  level: "warn";
  ts: string;
  event: "api.companion_transcription.provider_failure";
  providerId: "google";
  category: CompanionTranscriptionFailureCategory;
  status?: number;
}

interface CompanionTranscriptionDiagnosticsInput {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  write?: (line: string) => void;
}

export interface CompanionTranscriptionDiagnostics {
  fetchImpl: typeof fetch;
  reportInvalidResponse(): void;
}

/**
 * Observe only the safe shape of Google's transcription-token exchange. Provider URLs, response
 * bodies, thrown messages, credentials, member identity, and Companion identity never enter the
 * record, so operators can distinguish transport, HTTP, and response-shape failures safely.
 */
export function createCompanionTranscriptionDiagnostics(
  input: CompanionTranscriptionDiagnosticsInput = {},
): CompanionTranscriptionDiagnostics {
  const providerFetch = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());
  const write = input.write ?? ((line: string) => console.warn(line));
  let sawSuccessfulResponse = false;
  let failureReported = false;

  const report = (
    category: CompanionTranscriptionFailureCategory,
    status?: number,
  ): void => {
    if (failureReported) return;
    const record: CompanionTranscriptionFailureLog = {
      level: "warn",
      ts: now().toISOString(),
      event: "api.companion_transcription.provider_failure",
      providerId: "google",
      category,
    };
    if (status !== undefined) record.status = status;
    write(JSON.stringify(record));
    failureReported = true;
  };

  const fetchImpl: typeof fetch = async (request, init) => {
    let response: Response;
    try {
      response = await providerFetch(request, init);
    } catch (error) {
      report("transport");
      throw error;
    }
    if (!response.ok) {
      report(response.status >= 500 ? "5xx" : "4xx", response.status);
    } else {
      sawSuccessfulResponse = true;
    }
    return response;
  };

  return {
    fetchImpl,
    reportInvalidResponse() {
      if (sawSuccessfulResponse) report("invalid_response");
    },
  };
}
