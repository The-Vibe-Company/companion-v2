"use client";

import { useEffect, useState } from "react";
import type { CompanionPluginsResponse } from "@companion/contracts";
import { apiFetch } from "@/lib/apiClient";
import { Icon } from "../Icon";

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

  const toggle = (id: string, checked: boolean) => {
    onSelectedMcpAccountIdsChange(
      checked
        ? [...selectedMcpAccountIds, id]
        : selectedMcpAccountIds.filter((current) => current !== id),
    );
  };

  return (
    <div className="companions-skills-picker">
      <fieldset disabled={disabled} className="companions-skills-picker__skills">
        <legend>Plugins</legend>
        <p className="companions-skills-picker__hint">
          Choose which already-connected MCP plugins this Companion may use. Empty means no extra
          MCP pins on the Box. Detach does not disconnect the plugin from Plugins.
        </p>
        {error ? <div className="companions-error" role="alert">{error}</div> : null}
        {plugins === null ? (
          <p className="companions-skills-picker__empty">Loading plugins…</p>
        ) : plugins.length === 0 && !error ? (
          <p className="companions-skills-picker__empty">
            No plugins connected yet. Connect them from the Plugins page first.
          </p>
        ) : plugins.length === 0 ? null : (
          <div
            className="companions-skills-picker__list"
            role="group"
            aria-label="Plugins this Companion may use"
          >
            {plugins.map((plugin) => {
              const checked = selectedMcpAccountIds.includes(plugin.id);
              return (
                <label key={plugin.id} className={checked ? "is-selected" : undefined}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => toggle(plugin.id, event.target.checked)}
                  />
                  <span>
                    <strong>{plugin.provider}</strong>
                    <code>{plugin.label} · {plugin.transport}</code>
                    <small>{plugin.endpoint}</small>
                  </span>
                  {checked ? <Icon name="circle-check" size={14} /> : null}
                </label>
              );
            })}
          </div>
        )}
        <div className="companions-skills-picker__foot">
          {selectedMcpAccountIds.length} selected
        </div>
      </fieldset>
    </div>
  );
}
