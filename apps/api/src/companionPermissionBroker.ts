/**
 * Companion permission broker — Pi extension source and control-plane helpers.
 *
 * The extension itself runs inside the Box under Pi. The control plane only stages its source onto
 * `$PI_CODING_AGENT_DIR/extensions/` and projects the `extension_ui_request` events it emits.
 */

import { COMPANION_TOOL_RUN_TIMEOUT_MS } from "@companion/contracts";

/** Fail closed with the Box extension's own question timeout (5 minutes). Timeout → cancelled. */
export const COMPANION_DECISION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * On-disk name under `$PI_CODING_AGENT_DIR/extensions/`.
 *
 * Keep the legacy permission-broker filename so every start overwrites the older extension that
 * gated shell and file tools. The current extension only provides the interactive `ask_user` tool.
 */
export const COMPANION_PERMISSION_BROKER_EXTENSION_FILE = "companion-permission-broker.ts";

/** Title the extension puts on extension_ui_request events: `companion:<kind>:<tool>`. */
export const COMPANION_DECISION_TITLE_PATTERN =
  /^companion:(shell|file|question):([A-Za-z0-9._-]{1,120})$/;

const COMPANION_IMAGE_READ_PATH_PATTERN = /\.(?:avif|bmp|gif|jpe?g|png|webp)(?:[?#].*)?$/i;
export const COMPANION_IMAGE_READ_REFUSAL =
  "Image reads are disabled in Companion. Use browse or computer; the visual run receives one Box desktop frame automatically.";

/** The same fail-closed decision the staged Pi extension makes before its built-in read executes. */
export function companionImageReadRefusal(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (toolName !== "read") return null;
  const path = input.path ?? input.file_path ?? input.filePath ?? input.file;
  return typeof path === "string" && COMPANION_IMAGE_READ_PATH_PATTERN.test(path.trim())
    ? COMPANION_IMAGE_READ_REFUSAL
    : null;
}

export function parseCompanionDecisionTitle(title: string): {
  kind: "shell" | "file" | "question";
  name: string;
} | null {
  const match = COMPANION_DECISION_TITLE_PATTERN.exec(title.trim());
  if (!match) return null;
  return {
    kind: match[1] as "shell" | "file" | "question",
    name: match[2]!,
  };
}

/**
 * Source installed onto every Companion Box so Pi can ask the human a blocking question.
 * Shell and file tools are deliberately not intercepted: a Companion runs them without approval.
 * Kept as text so the API package does not depend on Pi's extension types.
 */
export const COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE = `/**
 * Companion question broker — Pi extension installed on every Companion Box.
 *
 * The model can call ask_user to emit an extension_ui_request over Pi's RPC log and block until the
 * control plane answers with an extension_ui_response (or the timeout cancels the question).
 * Built-in shell and file tools remain unrestricted and execute without a confirmation request.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DECISION_TIMEOUT_MS = ${COMPANION_DECISION_TIMEOUT_MS};
const TOOL_TIMEOUT_MS = ${COMPANION_TOOL_RUN_TIMEOUT_MS};

const IMAGE_PATH_PATTERN = /${COMPANION_IMAGE_READ_PATH_PATTERN.source}/${COMPANION_IMAGE_READ_PATH_PATTERN.flags};
const toolTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

function clearToolTimeouts() {
  for (const timeout of toolTimeouts.values()) clearTimeout(timeout);
  toolTimeouts.clear();
}

function startToolTimeout(toolCallId: string, ctx: { abort(): void }) {
  const existing = toolTimeouts.get(toolCallId);
  if (existing) clearTimeout(existing);
  toolTimeouts.set(toolCallId, setTimeout(() => {
    // Pi may run sibling tools in parallel. One overdue tool aborts this turn, and every sibling
    // timer must disappear with it so none can abort a later queued turn.
    clearToolTimeouts();
    ctx.abort();
  }, TOOL_TIMEOUT_MS));
}

function decisionTitle(name: string): string {
  return \`companion:question:\${name}\`;
}

export default function companionPermissionBroker(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "read") {
      const input = (event.input ?? {}) as Record<string, unknown>;
      const path = input.path ?? input.file_path ?? input.filePath ?? input.file;
      if (typeof path === "string" && IMAGE_PATH_PATTERN.test(path.trim())) {
        return {
          block: true,
          reason: ${JSON.stringify(COMPANION_IMAGE_READ_REFUSAL)},
        };
      }
      startToolTimeout(event.toolCallId, ctx);
      return undefined;
    }
    // ask_user is an interactive decision with its own five-minute fail-closed UI deadline. Its
    // execute body does not perform external work, so the shorter execution timer must not abort a
    // still-actionable question.
    if (event.toolName === "ask_user") return undefined;
    startToolTimeout(event.toolCallId, ctx);
    return undefined;
  });

  pi.on("tool_result", (event) => {
    const timeout = toolTimeouts.get(event.toolCallId);
    if (timeout) clearTimeout(timeout);
    toolTimeouts.delete(event.toolCallId);
    return undefined;
  });

  pi.on("turn_end", () => {
    clearToolTimeouts();
    return undefined;
  });

  pi.registerTool({
    name: "ask_user",
    label: "Ask user",
    description:
      "Ask the human who owns this Companion a question and wait for their answer. Use when you need a decision, preference, missing information, or sign-off before doing something consequential.",
    parameters: Type.Object({
      question: Type.String({ description: "The question, with enough context to answer at a glance" }),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const question = typeof params.question === "string" ? params.question.trim() : "";
      if (!question) {
        return {
          content: [{ type: "text", text: "Error: ask_user requires a question" }],
          details: { question: "", answer: null },
        };
      }
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Error: no permission UI available" }],
          details: { question, answer: null },
        };
      }
      const answer = await ctx.ui.input(
        decisionTitle("ask_user"),
        question,
        { timeout: DECISION_TIMEOUT_MS },
      );
      if (answer === undefined || !answer.trim()) {
        return {
          content: [{ type: "text", text: "User did not answer (denied or timed out)." }],
          details: { question, answer: null },
        };
      }
      return {
        content: [{ type: "text", text: answer.trim() }],
        details: { question, answer: answer.trim() },
      };
    },
  });
}
`;
