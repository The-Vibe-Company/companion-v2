"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  quoteSkillDatabaseIdentifier,
  type SkillDatabaseDescribeColumn,
  type SkillDatabaseDescribeRealm,
  type SkillDatabaseDescribeResponse,
  type SkillDatabaseDescribeTable,
  type SkillDatabaseParam,
  type SkillDatabaseSharesResponse,
} from "@companion/contracts";
import { Icon } from "../Icon";
import { Avatar } from "./blocks";
import {
  executeSkillDatabase,
  fetchSkillDatabase,
  fetchSkillDatabaseShares,
  querySkillDatabase,
  setSkillDatabaseShares,
  type SkillDatabaseRealmTarget,
} from "@/lib/skillDatabaseQueries";
import { ApiFetchError } from "@/lib/apiClient";

const PAGE_SIZE = 50;

type SpaceKind = "personal" | "shared" | "organization";
type Drawer =
  | { kind: "schema" }
  | { kind: "row"; mode: "create" | "edit" | "view"; row?: SkillDatabaseParam[] }
  | { kind: "sharing" }
  | null;

interface Space {
  key: string;
  kind: SpaceKind;
  label: string;
  description: string;
  target: SkillDatabaseRealmTarget;
  realm: SkillDatabaseDescribeRealm | null;
}

function quote(name: string): string {
  return quoteSkillDatabaseIdentifier(name);
}

function spacesFor(
  description: SkillDatabaseDescribeResponse,
  meId: string,
): Space[] {
  const spaces: Space[] = [];
  if (description.tables.some((table) => table.audience === "personal")) {
    const own = description.realms.find(
      (realm) => realm.audience === "personal" && realm.access === "owner",
    ) ?? null;
    spaces.push({
      key: "personal",
      kind: "personal",
      label: "My data",
      description: "Your private state for this skill.",
      target: { audience: "personal", ...(own ? { realmId: own.id } : {}) },
      realm: own,
    });
    for (const realm of description.realms.filter(
      (candidate) => candidate.audience === "personal"
        && candidate.access === "shared"
        && candidate.owner?.user_id !== meId,
    )) {
      spaces.push({
        key: `shared:${realm.id}`,
        kind: "shared",
        label: realm.owner?.name ?? "Shared member",
        description: `Shared by ${realm.owner?.name ?? "an organization member"}.`,
        target: { audience: "personal", realmId: realm.id },
        realm,
      });
    }
  }
  if (description.tables.some((table) => table.audience === "organization")) {
    const organization = description.realms.find(
      (realm) => realm.audience === "organization",
    ) ?? null;
    spaces.push({
      key: "organization",
      kind: "organization",
      label: "Organization",
      description: "Shared state available to every current member.",
      target: { audience: "organization" },
      realm: organization,
    });
  }
  return spaces;
}

function displayValue(value: SkillDatabaseParam, column: SkillDatabaseDescribeColumn): string {
  if (value === null) return "NULL";
  if (column.type === "boolean") return value === true || value === 1 ? "true" : "false";
  if (column.type === "json" && typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return value;
    }
  }
  return String(value);
}

function inputValue(value: SkillDatabaseParam | undefined, column: SkillDatabaseDescribeColumn): string {
  if (value === null || value === undefined) return "";
  if (column.type === "boolean") return value === true || value === 1 ? "true" : "false";
  if (column.type === "timestamp" && typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      const part = (number: number) => String(number).padStart(2, "0");
      return `${parsed.getFullYear()}-${part(parsed.getMonth() + 1)}-${part(parsed.getDate())}T${part(parsed.getHours())}:${part(parsed.getMinutes())}`;
    }
  }
  if (column.type === "json" && typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return String(value);
}

function parseField(value: string, column: SkillDatabaseDescribeColumn): SkillDatabaseParam {
  switch (column.type) {
    case "integer": {
      const normalized = value.trim();
      if (!/^-?\d+$/.test(normalized)) throw new Error(`${column.name} must be an integer.`);
      const parsed = BigInt(normalized);
      if (parsed < -(2n ** 63n) || parsed > (2n ** 63n) - 1n) {
        throw new Error(`${column.name} is outside SQLite’s signed 64-bit integer range.`);
      }
      return Number.isSafeInteger(Number(parsed)) ? Number(parsed) : normalized;
    }
    case "real": {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error(`${column.name} must be a finite number.`);
      return parsed;
    }
    case "boolean":
      return value === "true";
    case "json":
      try {
        return JSON.stringify(JSON.parse(value));
      } catch {
        throw new Error(`${column.name} must contain valid JSON.`);
      }
    case "timestamp": {
      if (Number.isNaN(Date.parse(value))) throw new Error(`${column.name} must be a valid timestamp.`);
      return new Date(value).toISOString();
    }
    case "text":
      return value;
  }
}

function DrawerShell({
  title,
  description,
  onClose,
  children,
  footer,
}: {
  title: string;
  description: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        panelRef.current.focus();
      } else if (
        event.shiftKey
        && (document.activeElement === first || document.activeElement === panelRef.current)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [onClose]);
  return (
    <div className="sdb-drawer-layer">
      <div className="sdb-drawer-scrim" aria-hidden="true" onClick={onClose} />
      <div
        className="sdb-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sdb-drawer-title"
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="sdb-drawer__head">
          <div>
            <h2 id="sdb-drawer-title">{title}</h2>
            <p>{description}</p>
          </div>
          <button className="iconbtn" type="button" aria-label="Close panel" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="sdb-drawer__body">{children}</div>
        {footer ? <footer className="sdb-drawer__foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

function SchemaDrawer({
  table,
  onClose,
}: {
  table: SkillDatabaseDescribeTable;
  onClose: () => void;
}) {
  return (
    <DrawerShell
      title={table.name}
      description={`${table.columns.length} column${table.columns.length === 1 ? "" : "s"} · ${table.audience}`}
      onClose={onClose}
    >
      <div className="sdb-schema">
        {table.columns.map((column) => (
          <div className="sdb-schema__row" key={column.name}>
            <div>
              <code>{column.name}</code>
              <span>{column.type}</span>
            </div>
            <div className="sdb-schema__flags">
              {table.primary_key.includes(column.name) ? <span>Primary key</span> : null}
              {!column.nullable ? <span>Required</span> : <span>Nullable</span>}
              {column.default !== undefined ? <span>Default {String(column.default)}</span> : null}
            </div>
          </div>
        ))}
      </div>
      {table.unique.length > 0 ? (
        <section className="sdb-drawer-section">
          <h3>Unique constraints</h3>
          {table.unique.map((constraint) => (
            <code key={constraint.join(":")}>{constraint.join(", ")}</code>
          ))}
        </section>
      ) : null}
    </DrawerShell>
  );
}

interface FieldState {
  value: string;
  isNull: boolean;
  omitted: boolean;
}

function RowDrawer({
  slug,
  target,
  table,
  mode,
  row,
  archived,
  onClose,
  onSaved,
}: {
  slug: string;
  target: SkillDatabaseRealmTarget;
  table: SkillDatabaseDescribeTable;
  mode: "create" | "edit" | "view";
  row?: SkillDatabaseParam[];
  archived: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fields, setFields] = useState<Record<string, FieldState>>(() =>
    Object.fromEntries(table.columns.map((column, index) => {
      const current = row?.[index];
      return [column.name, {
        value: inputValue(current, column),
        isNull: current === null,
        omitted: mode === "create" && current === undefined && (column.default !== undefined || column.nullable),
      }];
    })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const keepRowRef = useRef<HTMLButtonElement>(null);
  const deleteRowRef = useRef<HTMLButtonElement>(null);
  const wasConfirmingDeleteRef = useRef(false);
  const primary = new Set(table.primary_key);

  useEffect(() => {
    if (confirmDelete) {
      wasConfirmingDeleteRef.current = true;
      keepRowRef.current?.focus();
    } else if (wasConfirmingDeleteRef.current) {
      wasConfirmingDeleteRef.current = false;
      deleteRowRef.current?.focus();
    }
  }, [confirmDelete]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      if (mode === "create") {
        const included = table.columns.filter((column) => !fields[column.name]?.omitted);
        if (included.length === 0) throw new Error("Include at least one column before adding the row.");
        const values = included.map((column) => {
          const field = fields[column.name]!;
          return field.isNull ? null : parseField(field.value, column);
        });
        const sql = `INSERT INTO ${quote(table.name)} (${included.map((column) => quote(column.name)).join(", ")}) VALUES (${included.map(() => "?").join(", ")})`;
        const result = await executeSkillDatabase(slug, target, sql, values);
        if (result.changes !== 1) throw new Error("The row was not added. Reload the table and try again.");
      } else {
        const mutable = table.columns.filter((column, index) => {
          if (primary.has(column.name)) return false;
          const field = fields[column.name]!;
          const current = row?.[index];
          return field.isNull !== (current === null)
            || (!field.isNull && field.value !== inputValue(current, column));
        });
        if (mutable.length === 0) throw new Error("Change at least one field before saving.");
        const nextValues = mutable.map((column) => {
          const field = fields[column.name]!;
          return field.isNull ? null : parseField(field.value, column);
        });
        const originalValues = table.columns.map((_, index) => row?.[index] ?? null);
        const sql = `UPDATE ${quote(table.name)} SET ${mutable.map((column) => `${quote(column.name)} = ?`).join(", ")} WHERE ${table.columns.map((column) => `${quote(column.name)} IS ?`).join(" AND ")}`;
        const result = await executeSkillDatabase(slug, target, sql, [...nextValues, ...originalValues]);
        if (result.changes !== 1) throw new Error("The row changed elsewhere. Reload the table before editing it again.");
      }
      onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The row could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!row || table.primary_key.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const originalValues = table.columns.map((_, index) => row[index] ?? null);
      const sql = `DELETE FROM ${quote(table.name)} WHERE ${table.columns.map((column) => `${quote(column.name)} IS ?`).join(" AND ")}`;
      const result = await executeSkillDatabase(slug, target, sql, originalValues);
      if (result.changes !== 1) throw new Error("The row changed elsewhere. Reload the table before deleting it.");
      onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The row could not be deleted.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <DrawerShell
      title={mode === "create" ? `Add to ${table.name}` : mode === "view" ? `View ${table.name}` : `Edit ${table.name}`}
      description={mode === "create" ? "Values are validated against the published schema." : mode === "view" ? "This row is read-only." : "Primary-key values stay fixed so the row remains addressable."}
      onClose={onClose}
      footer={(
        <>
          {mode === "edit" && !archived ? (
            confirmDelete ? (
              <div className="sdb-delete-confirm" role="alert">
                <span>Delete this row permanently?</span>
                <button ref={keepRowRef} type="button" className="btn-sec" disabled={saving} onClick={() => setConfirmDelete(false)}>Keep row</button>
                <button type="button" className="btn-danger" disabled={saving} onClick={remove}>Delete</button>
              </div>
            ) : (
              <button ref={deleteRowRef} type="button" className="btn-ghost sdb-danger-link" onClick={() => setConfirmDelete(true)}>
                <Icon name="trash-2" size={14} />Delete row
              </button>
            )
          ) : null}
          <span className="sdb-spacer" />
          <button type="button" className="btn-sec" onClick={onClose}>Cancel</button>
          {mode !== "view" ? <button type="submit" form="sdb-row-form" className="btn-primary" disabled={saving || archived}>
            {saving ? "Saving…" : mode === "create" ? "Add row" : "Save changes"}
          </button> : null}
        </>
      )}
    >
      {archived ? (
        <div className="sdb-notice"><Icon name="lock" size={14} />Archived skill databases are read-only.</div>
      ) : null}
      {error ? <div className="sdb-error" role="alert">{error}</div> : null}
      <form id="sdb-row-form" className="sdb-form" onSubmit={submit}>
        {table.columns.map((column) => {
          const field = fields[column.name]!;
          const locked = mode === "view" || (mode === "edit" && primary.has(column.name));
          const optional = mode === "create" && (column.default !== undefined || column.nullable);
          return (
            <fieldset className="sdb-field" key={column.name} disabled={saving || archived || mode === "view"}>
              <div className="sdb-field__label">
                <label htmlFor={`sdb-field-${column.name}`}>
                  <code>{column.name}</code>
                  <span>{column.type}{primary.has(column.name) ? " · primary key" : ""}</span>
                </label>
                {optional ? (
                  <label className="sdb-mini-check">
                    <input
                      type="checkbox"
                      checked={field.omitted}
                      onChange={(event) => setFields((current) => ({
                        ...current,
                        [column.name]: { ...field, omitted: event.target.checked, isNull: false },
                      }))}
                    />
                    {column.default !== undefined ? "Use default" : "Omit value"}
                  </label>
                ) : null}
                {column.nullable && !field.omitted ? (
                  <label className="sdb-mini-check">
                    <input
                      type="checkbox"
                      checked={field.isNull}
                      disabled={locked}
                      onChange={(event) => setFields((current) => ({
                        ...current,
                        [column.name]: { ...field, isNull: event.target.checked },
                      }))}
                    />
                    NULL
                  </label>
                ) : null}
              </div>
              {column.type === "boolean" ? (
                <select
                  id={`sdb-field-${column.name}`}
                  value={field.value}
                  disabled={locked || field.omitted || field.isNull}
                  onChange={(event) => setFields((current) => ({
                    ...current,
                    [column.name]: { ...field, value: event.target.value },
                  }))}
                >
                  <option value="false">false</option>
                  <option value="true">true</option>
                </select>
              ) : column.type === "json" ? (
                <textarea
                  id={`sdb-field-${column.name}`}
                  value={field.value}
                  disabled={locked || field.omitted || field.isNull}
                  rows={5}
                  spellCheck={false}
                  onChange={(event) => setFields((current) => ({
                    ...current,
                    [column.name]: { ...field, value: event.target.value },
                  }))}
                />
              ) : (
                <input
                  id={`sdb-field-${column.name}`}
                  type={column.type === "real" ? "number" : column.type === "timestamp" ? "datetime-local" : "text"}
                  inputMode={column.type === "integer" ? "numeric" : undefined}
                  step={column.type === "integer" ? "1" : column.type === "real" ? "any" : undefined}
                  value={field.value}
                  disabled={locked || field.omitted || field.isNull}
                  required={!column.nullable && column.default === undefined}
                  onChange={(event) => setFields((current) => ({
                    ...current,
                    [column.name]: { ...field, value: event.target.value },
                  }))}
                />
              )}
            </fieldset>
          );
        })}
      </form>
    </DrawerShell>
  );
}

function SharingDrawer({
  slug,
  archived,
  onClose,
  onSaved,
}: {
  slug: string;
  archived: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [data, setData] = useState<SkillDatabaseSharesResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    fetchSkillDatabaseShares(slug)
      .then((response) => {
        if (!active) return;
        setData(response);
        setSelected(new Set(response.members.filter((member) => member.shared).map((member) => member.user_id)));
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Sharing settings could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, [slug]);
  const filtered = data?.members.filter((member) =>
    `${member.name} ${member.user_id}`.toLowerCase().includes(query.trim().toLowerCase()),
  ) ?? [];
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await setSkillDatabaseShares(slug, [...selected]);
      onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sharing settings could not be saved.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <DrawerShell
      title="Manage sharing"
      description="Selected members can read and write every personal table in this skill."
      onClose={onClose}
      footer={(
        <>
          <span className="sdb-spacer" />
          <button type="button" className="btn-sec" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" disabled={saving || !data} onClick={save}>
            {saving ? "Saving…" : "Save sharing"}
          </button>
        </>
      )}
    >
      {archived ? (
        <div className="sdb-notice">
          <Icon name="lock" size={14} />
          You can revoke existing access, but archived skills cannot add new members.
        </div>
      ) : null}
      {error ? <div className="sdb-error" role="alert">{error}</div> : null}
      {!data && !error ? <div className="sdb-member-skeleton" aria-label="Loading members" /> : null}
      {data ? (
        <>
          <label className="sdb-search">
            <span className="sr-only">Search members</span>
            <Icon name="search" size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search members" />
          </label>
          <div className="sdb-members">
            {filtered.length === 0 ? (
              <div className="sdb-empty sdb-empty--compact">
                <strong>{data.members.length === 0 ? "No other active members" : "No matching members"}</strong>
                <span>{data.members.length === 0 ? "Invite someone to the workspace before sharing this data." : "Try another name."}</span>
              </div>
            ) : filtered.map((member) => {
              const checked = selected.has(member.user_id);
              const canEnable = !archived || member.shared;
              return (
                <label className="sdb-member" key={member.user_id}>
                  <Avatar initials={member.initials} avatarUrl={member.avatar_url} size={28} />
                  <span>
                    <strong>{member.name}</strong>
                    <small>{checked ? "Read and write access" : "No access"}</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!canEnable && !checked}
                    onChange={(event) => setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(member.user_id);
                      else next.delete(member.user_id);
                      return next;
                    })}
                  />
                </label>
              );
            })}
          </div>
        </>
      ) : null}
    </DrawerShell>
  );
}

export function SkillDatabaseTab({
  slug,
  meId,
  scope,
  archived,
}: {
  slug: string;
  meId: string;
  scope: "personal" | "org";
  archived: boolean;
}) {
  const [description, setDescription] = useState<SkillDatabaseDescribeResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadDescription, setReloadDescription] = useState(0);
  const [spaceKey, setSpaceKey] = useState<string | null>(null);
  const [tableName, setTableName] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<SkillDatabaseParam[][]>([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [hasNext, setHasNext] = useState(false);
  const [reloadRows, setReloadRows] = useState(0);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [revokedMessage, setRevokedMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setDescription(null);
    setLoadError(null);
    fetchSkillDatabase(slug)
      .then((response) => {
        if (active) setDescription(response);
      })
      .catch((cause) => {
        if (active) setLoadError(cause instanceof Error ? cause.message : "The database description could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, [slug, reloadDescription]);

  const spaces = useMemo(() => description ? spacesFor(description, meId) : [], [description, meId]);
  const activeSpace = spaces.find((space) => space.key === spaceKey) ?? spaces[0] ?? null;
  const tables = useMemo(
    () => description && activeSpace
      ? description.tables.filter((table) => table.audience === activeSpace.target.audience)
      : [],
    [activeSpace, description],
  );
  const activeTable = tables.find((table) => table.name === tableName) ?? tables[0] ?? null;

  useEffect(() => {
    if (activeSpace && spaceKey !== activeSpace.key) setSpaceKey(activeSpace.key);
  }, [activeSpace, spaceKey]);
  useEffect(() => {
    if (activeTable && tableName !== activeTable.name) setTableName(activeTable.name);
  }, [activeTable, tableName]);

  useEffect(() => {
    if (!activeSpace || !activeTable) return;
    let active = true;
    setRowsLoading(true);
    setRowsError(null);
    const selectedColumns = activeTable.columns.map((column) => quote(column.name)).join(", ");
    const ordering = activeTable.primary_key.length
      ? ` ORDER BY ${activeTable.primary_key.map((name) => `${quote(name)} ASC`).join(", ")}`
      : "";
    querySkillDatabase(
      slug,
      activeSpace.target,
      `SELECT ${selectedColumns} FROM ${quote(activeTable.name)}${ordering} LIMIT ? OFFSET ?`,
      [PAGE_SIZE + 1, page * PAGE_SIZE],
    )
      .then((result) => {
        if (!active) return;
        setRows(result.rows.slice(0, PAGE_SIZE));
        setHasNext(result.rows.length > PAGE_SIZE);
      })
      .catch((cause) => {
        if (!active) return;
        setRows([]);
        setHasNext(false);
        if (activeSpace.kind === "shared" && cause instanceof ApiFetchError && cause.status === 404) {
          setRevokedMessage("This shared database is no longer available. Its owner may have revoked your access.");
          setSpaceKey("personal");
          setReloadDescription((value) => value + 1);
          setRowsError(null);
        } else {
          setRowsError(cause instanceof Error ? cause.message : "Rows could not be loaded.");
        }
      })
      .finally(() => {
        if (active) setRowsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeSpace, activeTable, page, reloadRows, slug]);

  useEffect(() => {
    setPage(0);
    setDrawer(null);
  }, [activeSpace?.key, activeTable?.name]);

  if (!description && !loadError) {
    return (
      <div className="sdb-loading" aria-label="Loading skill tables">
        <div /><div /><div />
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="sdb-empty">
        <Icon name="alert-triangle" size={20} />
        <strong>Tables could not be loaded</strong>
        <span>{loadError}</span>
        <button className="btn-sec" type="button" onClick={() => setReloadDescription((value) => value + 1)}>
          <Icon name="refresh-cw" size={14} />Try again
        </button>
      </div>
    );
  }
  if (!description || !activeSpace || !activeTable) {
    return (
      <div className="sdb-empty">
        <Icon name="database" size={20} />
        <strong>No active tables</strong>
        <span>Publish a database declaration in companion.json to use this surface.</span>
      </div>
    );
  }

  const sharedSpaces = spaces.filter((space) => space.kind === "shared");
  const category = activeSpace.kind;
  const selectCategory = (next: SpaceKind) => {
    const nextSpace = spaces.find((space) => space.kind === next);
    if (nextSpace) setSpaceKey(nextSpace.key);
  };
  const editable = !archived && activeTable.primary_key.length > 0;
  const canManageSharing = scope === "org" && category === "personal";

  return (
    <div className="sdb">
      <header className="sdb-toolbar">
        <div className="sdb-spaces" role="group" aria-label="Database space">
          {spaces.some((space) => space.kind === "personal") ? (
            <button type="button" aria-pressed={category === "personal"} onClick={() => selectCategory("personal")}>
              <Icon name="user" size={14} />My data
            </button>
          ) : null}
          {sharedSpaces.length > 0 ? (
            <button type="button" aria-pressed={category === "shared"} onClick={() => selectCategory("shared")}>
              <Icon name="users" size={14} />Shared with me <span>{sharedSpaces.length}</span>
            </button>
          ) : null}
          {spaces.some((space) => space.kind === "organization") ? (
            <button type="button" aria-pressed={category === "organization"} onClick={() => selectCategory("organization")}>
              <Icon name="building-2" size={14} />Organization
            </button>
          ) : null}
        </div>
        {category === "shared" && sharedSpaces.length > 1 ? (
          <label className="sdb-owner-select">
            <span className="sr-only">Shared database owner</span>
            <select value={activeSpace.key} onChange={(event) => setSpaceKey(event.target.value)}>
              {sharedSpaces.map((space) => <option value={space.key} key={space.key}>{space.label}</option>)}
            </select>
          </label>
        ) : category === "shared" && activeSpace.realm?.owner ? (
          <div className="sdb-owner">
            <Avatar initials={activeSpace.realm.owner.initials} avatarUrl={activeSpace.realm.owner.avatar_url} size={22} />
            <span>{activeSpace.realm.owner.name}</span>
          </div>
        ) : null}
        <span className="sdb-spacer" />
        {canManageSharing ? (
          <button className="btn-sec" type="button" onClick={() => setDrawer({ kind: "sharing" })}>
            <Icon name="users" size={14} />Manage sharing
          </button>
        ) : null}
      </header>

      {revokedMessage ? (
        <div className="sdb-notice sdb-notice--revoked" role="status">
          <Icon name="lock" size={14} />
          <span>{revokedMessage}</span>
          <button className="btn-ghost" type="button" onClick={() => setRevokedMessage(null)}>Dismiss</button>
        </div>
      ) : null}

      <div className="sdb-workspace">
        <aside className="sdb-table-rail" aria-label="Database tables">
          <div className="sdb-table-rail__head">
            <span>Tables</span><b>{tables.length}</b>
          </div>
          {tables.map((table) => (
            <button
              type="button"
              key={table.name}
              className={table.name === activeTable.name ? "is-selected" : ""}
              aria-current={table.name === activeTable.name ? "true" : undefined}
              onClick={() => setTableName(table.name)}
            >
              <Icon name="table" size={14} />
              <code>{table.name}</code>
              <span>{table.columns.length}</span>
            </button>
          ))}
        </aside>

        <main className="sdb-data">
          <header className="sdb-data__head">
            <div>
              <h2><code>{activeTable.name}</code></h2>
              <p>
                {activeSpace.description}
                {activeSpace.realm ? ` · ${activeSpace.realm.size_bytes.toLocaleString()} bytes` : " · Created on first query"}
              </p>
            </div>
            <span className="sdb-spacer" />
            <button className="btn-sec" type="button" onClick={() => setDrawer({ kind: "schema" })}>
              <Icon name="braces" size={14} />Schema
            </button>
            <button
              className="btn-primary"
              type="button"
              disabled={!editable}
              title={archived ? "Archived skill databases are read-only" : activeTable.primary_key.length === 0 ? "Add a primary key to edit this table safely" : "Add a row"}
              onClick={() => setDrawer({ kind: "row", mode: "create" })}
            >
              <Icon name="plus" size={14} />Add row
            </button>
          </header>

          {activeTable.primary_key.length === 0 ? (
            <div className="sdb-notice sdb-notice--inline">
              <Icon name="info" size={14} />
              This table is browse-only because it has no primary key.
            </div>
          ) : archived ? (
            <div className="sdb-notice sdb-notice--inline">
              <Icon name="lock" size={14} />
              Archived skill databases are read-only.
            </div>
          ) : null}

          <div className="sdb-grid-wrap">
            {rowsLoading ? (
              <div className="sdb-grid-skeleton"><div /><div /><div /><div /></div>
            ) : rowsError ? (
              <div className="sdb-empty sdb-empty--grid">
                <strong>Rows could not be loaded</strong>
                <span>{rowsError}</span>
                <button className="btn-sec" type="button" onClick={() => setReloadRows((value) => value + 1)}>
                  <Icon name="refresh-cw" size={14} />Try again
                </button>
              </div>
            ) : rows.length === 0 ? (
              <div className="sdb-empty sdb-empty--grid">
                <Icon name="table" size={20} />
                <strong>No rows yet</strong>
                <span>{editable ? "Add the first row to start this skill’s state." : "This table does not contain any data."}</span>
                {editable ? <button className="btn-sec" type="button" onClick={() => setDrawer({ kind: "row", mode: "create" })}><Icon name="plus" size={14} />Add row</button> : null}
              </div>
            ) : (
              <>
                <table className="sdb-grid">
                  <thead>
                    <tr>
                      {activeTable.columns.map((column) => (
                        <th key={column.name}>
                          <code>{column.name}</code>
                          <span>{column.type}</span>
                        </th>
                      ))}
                      <th className="sdb-grid__actions"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, rowIndex) => (
                      <tr key={`${page}:${rowIndex}`}>
                        {activeTable.columns.map((column, columnIndex) => (
                          <td key={column.name} title={displayValue(row[columnIndex] ?? null, column)}>
                            <code className={row[columnIndex] === null ? "is-null" : ""}>
                              {displayValue(row[columnIndex] ?? null, column)}
                            </code>
                          </td>
                        ))}
                        <td className="sdb-grid__actions">
                          <button
                            className="iconbtn"
                            type="button"
                            aria-label={`${editable ? "Edit" : "View"} row ${page * PAGE_SIZE + rowIndex + 1}`}
                            onClick={() => setDrawer({
                              kind: "row",
                              mode: editable ? "edit" : "view",
                              row,
                            })}
                          >
                            <Icon name={editable ? "pencil" : "eye"} size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="sdb-mobile-rows" aria-label={`${activeTable.name} rows`}>
                  {rows.map((row, rowIndex) => (
                    <button
                      type="button"
                      key={`${page}:mobile:${rowIndex}`}
                      onClick={() => setDrawer({
                        kind: "row",
                        mode: editable ? "edit" : "view",
                        row,
                      })}
                    >
                      <span>Row {page * PAGE_SIZE + rowIndex + 1}</span>
                      <code>
                        {activeTable.columns.slice(0, 2).map((column, columnIndex) =>
                          `${column.name}: ${displayValue(row[columnIndex] ?? null, column)}`,
                        ).join(" · ")}
                      </code>
                      <Icon name="chevron-right" size={15} />
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <footer className="sdb-pagination">
            <span>
              {rows.length === 0 ? "0 rows" : `${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + rows.length}`}
            </span>
            <button className="btn-sec" type="button" disabled={page === 0 || rowsLoading} onClick={() => setPage((value) => value - 1)}>
              <Icon name="arrow-left" size={14} />Previous
            </button>
            <button className="btn-sec" type="button" disabled={!hasNext || rowsLoading} onClick={() => setPage((value) => value + 1)}>
              Next<Icon name="arrow-right" size={14} />
            </button>
          </footer>
        </main>
      </div>

      {drawer?.kind === "schema" ? <SchemaDrawer table={activeTable} onClose={() => setDrawer(null)} /> : null}
      {drawer?.kind === "row" ? (
        <RowDrawer
          slug={slug}
          target={activeSpace.target}
          table={activeTable}
          mode={drawer.mode}
          row={drawer.row}
          archived={archived}
          onClose={() => setDrawer(null)}
          onSaved={() => setReloadRows((value) => value + 1)}
        />
      ) : null}
      {drawer?.kind === "sharing" ? (
        <SharingDrawer
          slug={slug}
          archived={archived}
          onClose={() => setDrawer(null)}
          onSaved={() => setReloadDescription((value) => value + 1)}
        />
      ) : null}
    </div>
  );
}
