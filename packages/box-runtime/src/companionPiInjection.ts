import { createHash } from "node:crypto";
import type { CompanionMcpAccount } from "@companion/contracts";

export interface CompanionRuntimeSkill {
  slug: string;
  version: string;
  checksum: string;
  archive: Buffer;
}

export interface CompanionMcpAdapterConfig {
  settings: {
    toolPrefix: "mcp";
    hostConfigDiscovery: "off";
    sampling: false;
    elicitation: false;
    oauthDir: string;
  };
  mcpServers: Record<string, Record<string, unknown>>;
}

export interface CompanionMcpAccountMetadata {
  id: string;
  label: string;
  adapter_name: string;
  transport: CompanionMcpAccount["transport"];
}

function adapterName(account: Pick<CompanionMcpAccount, "id" | "label">): string {
  const label = account.label
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "account";
  const suffix = createHash("sha256").update(account.id).digest("hex").slice(0, 10);
  return `${label}--${suffix}`;
}

function environmentReference(envKey: string): string {
  return `\${${envKey}}`;
}

/**
 * Convert Companion's labeled account contract into pi-mcp-adapter's file contract. Only
 * environment references enter the durable JSON; credential values are inherited from Pi's
 * transient process environment.
 */
export function buildMcpAdapterInjection(accounts: CompanionMcpAccount[]): {
  config: CompanionMcpAdapterConfig;
  accounts: CompanionMcpAccountMetadata[];
} {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  const metadata: CompanionMcpAccountMetadata[] = [];

  for (const account of accounts) {
    const name = adapterName(account);
    const common = {
      lifecycle: account.lifecycle,
      directTools: account.direct_tools,
    };
    mcpServers[name] = account.transport === "stdio"
      ? {
          ...common,
          command: account.command,
          args: account.args,
          env: Object.fromEntries(
            Object.entries(account.env).map(([key, envKey]) => [key, environmentReference(envKey)]),
          ),
        }
      : {
          ...common,
          url: account.url,
          headers: Object.fromEntries(
            Object.entries(account.headers).map(([key, envKey]) => [key, environmentReference(envKey)]),
          ),
        };
    metadata.push({
      id: account.id,
      label: account.label,
      adapter_name: name,
      transport: account.transport,
    });
  }

  return {
    config: {
      settings: {
        toolPrefix: "mcp",
        hostConfigDiscovery: "off",
        sampling: false,
        elicitation: false,
        oauthDir: "~/.companion/runtime/state/mcp-oauth",
      },
      mcpServers,
    },
    accounts: metadata,
  };
}

export function runtimeSkillArchivePath(skill: Pick<CompanionRuntimeSkill, "slug">): string {
  return `.companion/runtime/state/skill-archives/${skill.slug}.tar.gz.b64`;
}
