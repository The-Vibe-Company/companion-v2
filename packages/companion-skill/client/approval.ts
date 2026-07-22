import type { ApprovalInfo } from "@auth/agent";

export interface ApprovalBrowserCommand {
  command: string;
  args: string[];
}

function approvalUrl(info: ApprovalInfo): string | null {
  const raw = info.verification_uri_complete || info.verification_uri;
  if (!raw) return null;

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw new Error("Agent Auth returned an invalid approval URL");
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error("Agent Auth approval URL must use HTTP or HTTPS");
  }
  if (target.username || target.password) {
    throw new Error("Agent Auth approval URL must not contain credentials");
  }
  return target.href;
}

/** Build a shell-free browser launch command for an Agent Auth approval URL. */
export function approvalBrowserCommand(
  info: ApprovalInfo,
  platform: NodeJS.Platform = process.platform,
): ApprovalBrowserCommand | null {
  const target = approvalUrl(info);
  if (!target) return null;

  if (platform === "darwin") return { command: "open", args: [target] };
  if (platform === "win32") return { command: "explorer.exe", args: [target] };
  return { command: "xdg-open", args: [target] };
}
