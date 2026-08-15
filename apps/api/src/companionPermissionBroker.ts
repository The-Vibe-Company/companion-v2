/**
 * Companion permission broker — Pi extension source and control-plane helpers.
 *
 * The extension itself runs inside the Box under Pi. The control plane only stages its source onto
 * `$PI_CODING_AGENT_DIR/extensions/` and projects the `extension_ui_request` events it emits.
 */

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

function decisionTitle(name: string): string {
  return \`companion:question:\${name}\`;
}

export default function companionPermissionBroker(pi: ExtensionAPI) {
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
