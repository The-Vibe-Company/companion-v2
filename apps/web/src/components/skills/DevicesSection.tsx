"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeviceInventorySkillRow, DeviceRow } from "@companion/contracts";
import { fetchDevices, revokeDevice } from "@/lib/queries";
import { relativeTime } from "@/lib/format";
import { Icon } from "../Icon";

function platformLabel(value: string): string {
  if (value === "darwin") return "macOS";
  if (value === "win32") return "Windows";
  if (value === "linux") return "Linux";
  return value;
}

function inventorySummary(device: DeviceRow): string {
  const total = device.inventory_skills.length;
  const needsAttention = device.inventory_skills.filter((skill) => skill.outdated || skill.archived || !skill.managed).length;
  if (!total) return "No skills reported";
  if (needsAttention) {
    return `${needsAttention} item${needsAttention === 1 ? "" : "s"} need attention across ${total} skill${total === 1 ? "" : "s"}`;
  }
  return `${total} skill${total === 1 ? "" : "s"} current`;
}

function skillLabel(skill: DeviceInventorySkillRow): string {
  return skill.resolved_slug ?? skill.slug;
}

function skillStatus(skill: DeviceInventorySkillRow): "outdated" | "archived" | "current" | "unmanaged" {
  if (skill.outdated) return "outdated";
  if (skill.archived) return "archived";
  if (skill.managed) return "current";
  return "unmanaged";
}

function skillStatusLabel(status: ReturnType<typeof skillStatus>): string {
  if (status === "outdated") return "Outdated";
  if (status === "archived") return "Archived";
  if (status === "current") return "Current";
  return "Unmanaged";
}

function skillStatusBadge(status: ReturnType<typeof skillStatus>): string {
  if (status === "outdated" || status === "archived") return "devbadge--warn";
  if (status === "current") return "devbadge--ok";
  return "devbadge--muted";
}

export function DevicesSection({
  initialDevices,
  initialError = null,
}: {
  initialDevices: DeviceRow[];
  initialError?: string | null;
}) {
  const [devices, setDevices] = useState<DeviceRow[]>(initialDevices);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const refreshSeq = useRef(0);
  const hasDevices = devices.length > 0;

  useEffect(() => {
    setDevices(initialDevices);
    setError(initialError);
  }, [initialDevices, initialError]);

  const refresh = useCallback(async () => {
    const seq = refreshSeq.current + 1;
    refreshSeq.current = seq;
    setRefreshing(true);
    try {
      setError(null);
      const next = await fetchDevices();
      if (refreshSeq.current === seq) setDevices(next);
    } catch {
      if (refreshSeq.current === seq) setError("Could not refresh devices.");
    } finally {
      if (refreshSeq.current === seq) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh();
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const revoke = useCallback(
    async (device: DeviceRow) => {
      if (!window.confirm(`Revoke ${device.name}? The local agent on that machine will stop reporting.`)) return;
      setBusyId(device.id);
      try {
        await revokeDevice(device.id);
        setDevices((current) => current.filter((item) => item.id !== device.id));
        await refresh();
      } catch {
        setError("Could not revoke device.");
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const sorted = useMemo(
    () => [...devices].sort((a, b) => (b.last_seen_at ?? b.created_at).localeCompare(a.last_seen_at ?? a.created_at)),
    [devices],
  );

  return (
    <section className="devsec" aria-labelledby="devices-title">
      <div className="devsec__head">
        <div>
          <h2 id="devices-title" className="devsec__title">Your devices</h2>
          <p className="devsec__lede">Machines running the local Companion agent for this workspace.</p>
        </div>
        <button type="button" className="btn-secondary devsec__refresh" disabled={refreshing} onClick={refresh}>
          <Icon name="refresh-cw" size={15} />
          {refreshing ? "Refreshing" : "Refresh"}
        </button>
      </div>

      {error && <div className="devsec__error" role="status">{error}</div>}

      {!hasDevices && !error ? (
        <div className="devsec-empty">
          <Icon name="monitor" size={20} />
          <div className="devsec-empty__body">
            <div className="devsec-empty__title">No local agent yet</div>
            <div className="devsec-empty__code mono">companion login && companion agent install</div>
          </div>
        </div>
      ) : (
        <div className="devlist">
          {sorted.map((device) => (
            <article className="devcard" key={device.id}>
              <div className="devcard__top">
                <div className="devcard__identity">
                  <Icon name="laptop" size={18} />
                  <div>
                    <div className="devcard__name">{device.name}</div>
                    <div className="devcard__meta">
                      <span>{platformLabel(device.platform)}</span>
                      <span>Agent {device.agent_version ?? "unknown"}</span>
                      <span>Companion skill {device.companion_skill_version ?? "unknown"}</span>
                    </div>
                  </div>
                </div>
                <div className="devcard__actions">
                  <span className={`devbadge ${device.online ? "devbadge--ok" : "devbadge--muted"}`}>
                    <span className="devbadge__dot" />
                    {device.online ? "Online" : "Offline"}
                  </span>
                  {device.agent_update_available && (
                    <span className="devbadge devbadge--warn">Agent update</span>
                  )}
                  <button
                    type="button"
                    className="iconbtn"
                    aria-label={`Revoke ${device.name}`}
                    title={`Revoke ${device.name}`}
                    disabled={busyId === device.id}
                    onClick={() => void revoke(device)}
                  >
                    <Icon name="trash-2" size={15} />
                  </button>
                </div>
              </div>

              <div className="devcard__stats">
                <span>Last seen {relativeTime(device.last_seen_at)}</span>
                <span>{inventorySummary(device)}</span>
              </div>

              <details className="devinv">
                <summary>Inventory</summary>
                {device.inventory_skills.length ? (
                  <div className="devinv__table" aria-label={`${device.name} inventory`}>
                    {device.inventory_skills.map((skill) => {
                      const status = skillStatus(skill);
                      const label = skillStatusLabel(status);
                      return (
                        <div className="devinv__row" key={`${device.id}:${skill.slug}:${skill.skillId ?? ""}`}>
                          <span className="devinv__skill">
                            <span className="sr-only">Skill </span>
                            {skillLabel(skill)}
                          </span>
                          <span className="devinv__version mono" aria-label="Installed version and current version">
                            <span className="devinv__label">Version</span>
                            {skill.version ?? "unknown"} → {skill.current_version ?? "unmanaged"}
                          </span>
                          <span className="devinv__targets">
                            <span className="devinv__label">Targets</span>
                            {(skill.targets ?? []).map((target) => `${target.tool}/${target.scope}`).join(", ") || "No target"}
                          </span>
                          <span className={`devbadge ${skillStatusBadge(status)}`} aria-label={`Status: ${label}`}>
                            {label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="devinv__empty">No lockfile inventory reported.</div>
                )}
              </details>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
