/**
 * Companion permission broker — Pi extension source and control-plane helpers.
 *
 * The extension itself runs inside the Box under Pi. The control plane only stages its source onto
 * `$PI_CODING_AGENT_DIR/extensions/` and projects the `extension_ui_request` events it emits.
 */

/** Fail closed with the Box extension's own dialog timeout (5 minutes). Timeout → Deny. */
export const COMPANION_DECISION_TIMEOUT_MS = 5 * 60 * 1000;

/** On-disk name under `$PI_CODING_AGENT_DIR/extensions/`. */
export const COMPANION_PERMISSION_BROKER_EXTENSION_FILE = "companion-permission-broker.ts";

/** Title the extension puts on extension_ui_request events: `companion:<kind>:<tool>`. */
export const COMPANION_DECISION_TITLE_PATTERN =
  /^companion:(shell|file|question):([A-Za-z0-9._-]{1,120})$/;

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
 * Source installed onto every Companion Box so Pi pauses risky tools for a human decision.
 * Kept as text so the API package does not depend on Pi's extension types.
 */
export const COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE = `/**
 * Companion permission broker — Pi extension installed on every Companion Box.
 *
 * Before bash / write / edit run, and when the model calls ask_user, this extension emits an
 * extension_ui_request over Pi's RPC log and blocks until the control plane answers with an
 * extension_ui_response (or the timeout fails closed). Titles use \`companion:<kind>:<name>\` so the
 * control plane can project a transcript card without guessing from free-form prose.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DECISION_TIMEOUT_MS = ${COMPANION_DECISION_TIMEOUT_MS};

const GATED_TOOLS: Record<string, "shell" | "file"> = {
  bash: "shell",
  write: "file",
  edit: "file",
};

function decisionTitle(kind: "shell" | "file" | "question", name: string): string {
  return \`companion:\${kind}:\${name}\`;
}

function summarize(kind: "shell" | "file", name: string, input: Record<string, unknown>): string {
  if (kind === "shell") {
    const command = input.command ?? input.cmd ?? input.script;
    return typeof command === "string" && command.trim() ? command.trim() : name;
  }
  const path = input.path ?? input.file_path ?? input.filePath ?? input.file;
  return typeof path === "string" && path.trim() ? path.trim() : name;
}

export default function companionPermissionBroker(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const kind = GATED_TOOLS[event.toolName];
    if (!kind) return undefined;
    if (!ctx.hasUI) {
      return { block: true, reason: "Blocked: no permission UI available" };
    }
    const input = (event.input ?? {}) as Record<string, unknown>;
    const detail = summarize(kind, event.toolName, input);
    const allowed = await ctx.ui.confirm(
      decisionTitle(kind, event.toolName),
      detail,
      { timeout: DECISION_TIMEOUT_MS },
    );
    if (!allowed) {
      return { block: true, reason: "Denied by user or timed out" };
    }
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
        decisionTitle("question", "ask_user"),
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
