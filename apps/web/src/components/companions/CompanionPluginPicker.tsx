"use client";

import { useEffect, useState } from "react";
import type { CompanionPluginsResponse } from "@companion/contracts";
import { apiFetch } from "@/lib/apiClient";
import { OptionMultiSelect } from "./OptionMultiSelect";

export type CompanionPluginOption = {
  id: string;
  provider: string;
  label: string;
  transport: "http" | "stdio";
  endpoint: string;
};

async function fetchPickerPlugins(orgId: string): Promise<CompanionPluginOption[]> {
  const result = await apiFetch<CompanionPluginsResponse>("/v1/companion-plugins", {
    headers: { "x-companion-org": orgId },
  });
  return result.accounts
    .map((account): CompanionPluginOption => ({
      id: account.id,
      provider: account.provider,
      label: account.label,
      transport: account.transport,
      endpoint: account.endpoint,
    }))
    .sort((left, right) => {
      const byProvider = left.provider.localeCompare(right.provider);
      return byProvider !== 0 ? byProvider : left.label.localeCompare(right.label);
    });
}

/**
 * Skills-page language multi-select for which already-connected MCP plugins a Companion may stage
 * onto its Box. Native apps never render this control (THE-320 chat-only). Detach never disconnects
 * the member's workspace Plugins connection.
 */
export function CompanionPluginPicker({
  orgId,
  selectedMcpAccountIds,
  disabled,
  onSelectedMcpAccountIdsChange,
}: {
  orgId: string;
  selectedMcpAccountIds: string[];
  disabled?: boolean;
  onSelectedMcpAccountIdsChange: (ids: string[]) => void;
}) {
  const [plugins, setPlugins] = useState<CompanionPluginOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setPlugins(null);
    void fetchPickerPlugins(orgId)
      .then((rows) => {
        if (cancelled) return;
        setPlugins(rows);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Plugins could not be loaded.");
        setPlugins([]);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  return (
    <div className="companions-skills-picker">
      <OptionMultiSelect
        legend="Plugins"
        hint="Choose which already-connected MCP plugins this Companion may use. Empty means no extra MCP pins on the Box. Detach does not disconnect the plugin from Plugins."
        options={plugins?.map((plugin) => ({
          id: plugin.id,
          title: plugin.provider,
          mono: `${plugin.label} · ${plugin.transport}`,
          meta: plugin.endpoint,
        })) ?? null}
        selectedIds={selectedMcpAccountIds}
        disabled={disabled}
        error={error}
        searchPlaceholder="Search plugins…"
        emptyText="No plugins connected yet. Connect them from the Plugins page first."
        missingLabel="Not connected anymore"
        onChange={onSelectedMcpAccountIdsChange}
      />
    </div>
  );
}
