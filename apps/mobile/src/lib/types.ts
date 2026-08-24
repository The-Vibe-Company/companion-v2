/** Local mirrors of packages/contracts/src/companions.ts for the standalone mobile package. */

/* The source contract names the cosmetic icon's geometric body index "shape". */
/* oxlint-disable anti-slop/no-shape-in-symbol-names */

export type CompanionIconValue = {
  shape: number;
  mouth: number;
  accessory: number;
  color: number;
};

export type CompanionRuntimeState =
  | "not_created"
  | "provisioning"
  | "running"
  | "stopping"
  | "stopped"
  | "error";

export type SafeRuntimeError = {
  code: string;
  message: string;
  action: "retry" | "cancel" | "restart_pi" | "restart_box" | "switch_model" | "reconnect_provider" | "none";
};

export type CompanionTurnStatus =
  | "queued"
  | "starting"
  | "dispatching"
  | "running"
  | "needs_input"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled";

export type CompanionTurn = {
  id: string;
  companion_id: string;
  client_message_id: string;
  status: CompanionTurnStatus;
  queue_sequence: number;
  replying: boolean;
  error: SafeRuntimeError | null;
  state_changed_at: string;
  settled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Companion = {
  id: string;
  name: string;
  persona: string | null;
  icon?: CompanionIconValue;
  model_id: string | null;
  owner_id: string;
  access: "owner" | "editor" | "viewer";
  pinned: boolean;
  hidden: boolean;
  unread: boolean;
  last_message: {
    preview: string;
    role: "user" | "assistant";
    author_id: string | null;
    author_name: string | null;
    routine_name: string | null;
    trigger_name: string | null;
    created_at: string;
  } | null;
  runtime: {
    state: CompanionRuntimeState;
    replying: boolean;
    last_error: string | null;
  };
  created_at: string;
  updated_at: string;
};

export type CompanionToolRun = {
  call_id: string | null;
  kind: "shell" | "file" | "browse" | "computer" | "subagent" | "tool";
  name: string;
  title: string;
  status: "running" | "ok" | "error" | "timeout";
  detail: string | null;
  /** A `data:image/...;base64,` frame of the Box desktop on a visual run, or null. */
  screenshot: string | null;
};

export type CompanionConfigProposal = {
  kind: "config";
  add_skill_ids?: string[];
  remove_skill_ids?: string[];
  attach_plugin_ids?: string[];
  detach_plugin_ids?: string[];
  model_id?: string;
  persona?: string | null;
  connect_plugin?: { server_name: string; reason?: string };
};

export type CompanionRoutineProposal = {
  kind: "routine";
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
};

export type CompanionTriggerProposal = {
  kind: "trigger";
  name: string;
  prompt: string;
  provider: string;
  target?: { repo?: string; events?: string[] };
};

export type CompanionDecisionProposal =
  | CompanionConfigProposal
  | CompanionRoutineProposal
  | CompanionTriggerProposal;

export type CompanionDecision = {
  request_id: string;
  kind: "shell" | "file" | "question" | "config" | "routine" | "trigger";
  name: string;
  title: string;
  detail: string | null;
  status: "pending" | "allowed" | "denied" | "answered" | "expired";
  answer: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  expires_at: string;
  proposal: CompanionDecisionProposal | null;
};

export type CompanionAttachment = {
  id: string;
  kind: "user_upload" | "pi_output";
  content_type: string;
  byte_size: number;
  filename: string;
  position: number;
};

/** Mirrors of the contract's attachment bounds; the API re-validates every send. */
export const ATTACHMENT_MAX_COUNT = 5;
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

const ATTACHMENT_EXTENSION_TO_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
} satisfies Record<string, string>;

const ATTACHMENT_MIME_TYPES = new Set<string>(Object.values(ATTACHMENT_EXTENSION_TO_MIME));

export function isAttachmentImage(contentType: string): boolean {
  return contentType.startsWith("image/");
}

/** The type a picked file declares, or null when this hub does not accept it at all. */
export function declaredAttachmentContentType(file: { type: string; name: string }): string | null {
  const declared = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (ATTACHMENT_MIME_TYPES.has(declared)) return declared;
  const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0];
  if (extension && extension in ATTACHMENT_EXTENSION_TO_MIME) {
    // SAFETY: the `in` check above guarantees extension is one of this table's literal keys.
    return ATTACHMENT_EXTENSION_TO_MIME[extension as keyof typeof ATTACHMENT_EXTENSION_TO_MIME];
  }
  return null;
}

export type TranscriptEntry = {
  event_id: string;
  ordinal: number;
  role: "user" | "assistant" | "system" | "tool" | "decision";
  content: string;
  /** What Pi thought before it answered; only a reply carries it. */
  reasoning: string | null;
  author_id: string | null;
  author_name: string | null;
  tool: CompanionToolRun | null;
  decision: CompanionDecision | null;
  routine: { id: string | null; name: string } | null;
  trigger: { id: string | null; name: string } | null;
  turn_id: string | null;
  queued: boolean;
  attachments: CompanionAttachment[];
  created_at: string;
};

export type CompanionThread = {
  companion_id: string;
  viewer_id: string;
  access: "owner" | "editor" | "viewer";
  read_only: boolean;
  can_send: boolean;
  entries: TranscriptEntry[];
  active_turn: CompanionTurn | null;
  queued_count: number;
  interrupted_turn: CompanionTurn | null;
  last_message_at: string | null;
};

/** A resource name this surface already loaded, so proposal cards never print Pi-supplied labels. */
export type NamedResource = { id: string; label: string };

export type ProviderDefinition = {
  id: string;
  name: string;
  models: { id: string; name: string; default?: true }[];
};

export type ProvidersResponse = {
  catalog: ProviderDefinition[];
  connections: { provider_id: string }[];
  default_provider_id: string | null;
  can_manage: boolean;
};

export type WhoAmI = {
  userId: string;
  email: string;
  name?: string | null;
  role?: string | null;
  org?: { org_id?: string; name?: string; slug?: string } | null;
  onboarded: boolean;
  needsOnboarding: boolean;
};

export type Session = {
  cookie: string;
  orgId: string | null;
  needsOnboarding: boolean;
  user: { id: string; email: string; name: string | null };
};

export type OnboardingMatchedOrg = {
  id: string;
  name: string;
  domain: string;
  member_count: number;
};

export type OnboardingContext = {
  email: string;
  domain: string | null;
  is_personal: boolean;
  matched_orgs: OnboardingMatchedOrg[];
};

export type CreateCompanionInput = {
  name: string;
  persona?: string;
  icon: CompanionIconValue;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
