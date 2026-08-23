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
};

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
  proposal: { kind: "config" | "routine" | "trigger"; summary?: string } | null;
};

export type TranscriptEntry = {
  event_id: string;
  ordinal: number;
  role: "user" | "assistant" | "system" | "tool" | "decision";
  content: string;
  author_id: string | null;
  author_name: string | null;
  tool: CompanionToolRun | null;
  decision: CompanionDecision | null;
  routine: { id: string | null; name: string } | null;
  trigger: { id: string | null; name: string } | null;
  turn_id: string | null;
  queued: boolean;
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
};

export type Session = {
  cookie: string;
  orgId: string | null;
  user: { id: string; email: string };
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
