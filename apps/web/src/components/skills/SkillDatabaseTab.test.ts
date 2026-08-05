// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillDatabaseDescribeResponse } from "@companion/contracts";
import { ApiFetchError } from "@/lib/apiClient";
import { SkillDatabaseTab } from "./SkillDatabaseTab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rpc = vi.hoisted(() => ({
  executeSkillDatabase: vi.fn(),
  fetchSkillDatabase: vi.fn(),
  fetchSkillDatabaseShares: vi.fn(),
  querySkillDatabase: vi.fn(),
  setSkillDatabaseShares: vi.fn(),
}));
vi.mock("@/lib/skillDatabaseQueries", () => rpc);

const description: SkillDatabaseDescribeResponse = {
  skill_id: "00000000-0000-4000-8000-000000000001",
  slug: "stateful-skill",
  schema_generation: 2,
  limits: {
    maxBytes: 16 * 1024 * 1024,
    statementTimeoutMs: 2_000,
    maxResultRows: 1_000,
    maxResultBytes: 1024 * 1024,
  },
  tables: [
    {
      name: "private_notes",
      audience: "personal",
      columns: [
        { name: "id", type: "integer", nullable: false },
        { name: "body", type: "text", nullable: false },
      ],
      primary_key: ["id"],
      unique: [],
    },
    {
      name: "shared_log",
      audience: "organization",
      columns: [{ name: "message", type: "text", nullable: true }],
      primary_key: [],
      unique: [],
    },
  ],
  realms: [
    {
      id: "00000000-0000-4000-8000-000000000011",
      audience: "personal",
      owner: { user_id: "user-1", name: "Ada", initials: "AL", avatar_url: null },
      access: "owner",
      size_bytes: 8192,
      schema_generation: 2,
      last_accessed_at: "2026-07-31T12:00:00.000Z",
    },
    {
      id: "00000000-0000-4000-8000-000000000012",
      audience: "personal",
      owner: { user_id: "user-2", name: "Grace", initials: "GH", avatar_url: null },
      access: "shared",
      size_bytes: 12288,
      schema_generation: 2,
      last_accessed_at: "2026-07-31T12:00:00.000Z",
    },
  ],
};

const roots: Root[] = [];
async function mount(overrides: Partial<React.ComponentProps<typeof SkillDatabaseTab>> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(SkillDatabaseTab, {
      slug: "stateful-skill",
      meId: "user-1",
      scope: "org",
      archived: false,
      ...overrides,
    }));
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

async function changeValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLInputElement
      ? window.HTMLInputElement.prototype
      : element instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("SkillDatabaseTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpc.fetchSkillDatabase.mockResolvedValue(description);
    rpc.querySkillDatabase.mockResolvedValue({
      columns: ["id", "body"],
      rows: [[1, "First note"]],
      row_count: 1,
      changes: 0,
      last_insert_rowid: null,
      read_only: true,
      db_size_bytes: 8192,
      schema_generation: 2,
    });
    rpc.fetchSkillDatabaseShares.mockResolvedValue({
      realm_id: "00000000-0000-4000-8000-000000000011",
      members: [
        { user_id: "user-2", name: "Grace", initials: "GH", avatar_url: null, shared: false },
      ],
    });
    rpc.setSkillDatabaseShares.mockResolvedValue({
      realm_id: "00000000-0000-4000-8000-000000000011",
      members: [
        { user_id: "user-2", name: "Grace", initials: "GH", avatar_url: null, shared: true },
      ],
    });
    rpc.executeSkillDatabase.mockResolvedValue({
      columns: [],
      rows: [],
      row_count: 0,
      changes: 1,
      last_insert_rowid: 1,
      read_only: false,
      db_size_bytes: 8192,
      schema_generation: 2,
    });
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
  });

  it("loads the personal table with bounded parameterized pagination", async () => {
    const container = await mount();
    expect(container.textContent).toContain("My data");
    expect(container.textContent).toContain("Shared with me");
    expect(container.textContent).toContain("Organization");
    expect(container.textContent).toContain("First note");
    expect(rpc.querySkillDatabase).toHaveBeenCalledWith(
      "stateful-skill",
      { audience: "personal", realmId: "00000000-0000-4000-8000-000000000011" },
      'SELECT "id", "body" FROM "private_notes" ORDER BY "id" ASC LIMIT ? OFFSET ?',
      [51, 0],
    );
  });

  it("addresses an explicitly shared realm instead of the caller's personal realm", async () => {
    const container = await mount();
    const shared = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Shared with me"))!;
    await act(async () => {
      shared.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Grace");
    expect(rpc.querySkillDatabase).toHaveBeenLastCalledWith(
      "stateful-skill",
      { audience: "personal", realmId: "00000000-0000-4000-8000-000000000012" },
      expect.stringContaining('FROM "private_notes"'),
      [51, 0],
    );
  });

  it("keeps a table without a primary key browse-only", async () => {
    const container = await mount();
    const organization = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Organization"))!;
    await act(async () => {
      organization.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("browse-only because it has no primary key");
    const add = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Add row"));
    expect(add?.disabled).toBe(true);
    const view = container.querySelector<HTMLButtonElement>('[aria-label="View row 1"]')!;
    await act(async () => {
      view.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("View shared_log");
    expect(container.textContent).toContain("This row is read-only");
  });

  it("pages by 50 rows without interpolating the offset into SQL", async () => {
    rpc.querySkillDatabase.mockResolvedValue({
      columns: ["id", "body"],
      rows: Array.from({ length: 51 }, (_, index) => [index + 1, `Note ${index + 1}`]),
      row_count: 51,
      changes: 0,
      last_insert_rowid: null,
      read_only: true,
      db_size_bytes: 8192,
      schema_generation: 2,
    });
    const container = await mount();
    const next = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Next"))!;
    expect(next.disabled).toBe(false);
    await act(async () => {
      next.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(rpc.querySkillDatabase).toHaveBeenLastCalledWith(
      "stateful-skill",
      expect.anything(),
      expect.stringContaining("LIMIT ? OFFSET ?"),
      [51, 50],
    );
  });

  it("uses typed parameters for inserts and leaves SQL generation inside the declared schema", async () => {
    rpc.fetchSkillDatabase.mockResolvedValue({
      ...description,
      tables: [{
        name: "typed_rows",
        audience: "personal",
        columns: [
          { name: "id", type: "integer", nullable: false },
          { name: "title", type: "text", nullable: false },
          { name: "enabled", type: "boolean", nullable: false },
          { name: "payload", type: "json", nullable: false },
          { name: "occurred_at", type: "timestamp", nullable: false },
        ],
        primary_key: ["id"],
        unique: [],
      }],
    });
    rpc.querySkillDatabase.mockResolvedValue({
      columns: ["id", "title", "enabled", "payload", "occurred_at"],
      rows: [],
      row_count: 0,
      changes: 0,
      last_insert_rowid: null,
      read_only: true,
      db_size_bytes: 8192,
      schema_generation: 2,
    });
    const container = await mount();
    const add = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Add row"))!;
    await act(async () => {
      add.click();
      await Promise.resolve();
    });
    await changeValue(container.querySelector<HTMLInputElement>("#sdb-field-id")!, "7");
    await changeValue(container.querySelector<HTMLInputElement>("#sdb-field-title")!, "A note");
    await changeValue(container.querySelector<HTMLSelectElement>("#sdb-field-enabled")!, "true");
    await changeValue(container.querySelector<HTMLTextAreaElement>("#sdb-field-payload")!, '{"kind":"demo"}');
    await changeValue(container.querySelector<HTMLInputElement>("#sdb-field-occurred_at")!, "2026-07-31T12:30");
    const save = container.querySelector<HTMLButtonElement>('button[form="sdb-row-form"]')!;
    await act(async () => {
      save.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(rpc.executeSkillDatabase).toHaveBeenCalledWith(
      "stateful-skill",
      { audience: "personal", realmId: "00000000-0000-4000-8000-000000000011" },
      'INSERT INTO "typed_rows" ("id", "title", "enabled", "payload", "occurred_at") VALUES (?, ?, ?, ?, ?)',
      [7, "A note", true, '{"kind":"demo"}', "2026-07-31T12:30:00.000Z"],
    );
  });

  it("updates only dirty fields while preserving exact timestamps and signed 64-bit integers", async () => {
    const occurredAt = "2026-07-31T12:30:00.000Z";
    const unsafeInteger = "9007199254740993";
    rpc.fetchSkillDatabase.mockResolvedValue({
      ...description,
      tables: [{
        name: "typed_rows",
        audience: "personal",
        columns: [
          { name: "id", type: "integer", nullable: false },
          { name: "counter", type: "integer", nullable: false },
          { name: "occurred_at", type: "timestamp", nullable: false },
          { name: "title", type: "text", nullable: false },
        ],
        primary_key: ["id"],
        unique: [],
      }],
    });
    rpc.querySkillDatabase.mockResolvedValue({
      columns: ["id", "counter", "occurred_at", "title"],
      rows: [[1, unsafeInteger, occurredAt, "Before"]],
      row_count: 1,
      changes: 0,
      last_insert_rowid: null,
      read_only: true,
      db_size_bytes: 8192,
      schema_generation: 2,
    });
    rpc.executeSkillDatabase.mockResolvedValue({
      columns: [],
      rows: [],
      row_count: 0,
      changes: 1,
      last_insert_rowid: null,
      read_only: false,
      db_size_bytes: 8192,
      schema_generation: 2,
    });
    const container = await mount();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Edit row 1"]')!.click();
      await Promise.resolve();
    });
    await changeValue(container.querySelector<HTMLInputElement>("#sdb-field-title")!, "After");
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[form="sdb-row-form"]')!.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(rpc.executeSkillDatabase).toHaveBeenCalledWith(
      "stateful-skill",
      expect.anything(),
      'UPDATE "typed_rows" SET "title" = ? WHERE "id" IS ? AND "counter" IS ? AND "occurred_at" IS ? AND "title" IS ?',
      ["After", 1, unsafeInteger, occurredAt, "Before"],
    );
  });

  it("keeps full-row conflict detection within the bounded request for a 32-column table", async () => {
    const columns = Array.from({ length: 32 }, (_, index) => ({
      name: index === 0 ? "id" : `value_${index}`,
      type: "text" as const,
      nullable: false,
    }));
    const row = columns.map((_, index) => index === 0 ? "row-1" : `before-${index}`);
    rpc.fetchSkillDatabase.mockResolvedValue({
      ...description,
      tables: [{
        name: "wide_rows",
        audience: "personal",
        columns,
        primary_key: ["id"],
        unique: [],
      }],
    });
    rpc.querySkillDatabase.mockResolvedValue({
      columns: columns.map((column) => column.name),
      rows: [row],
      row_count: 1,
      changes: 0,
      last_insert_rowid: null,
      read_only: true,
      db_size_bytes: 8192,
      schema_generation: 2,
    });
    const container = await mount();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Edit row 1"]')!.click();
      await Promise.resolve();
    });
    await changeValue(container.querySelector<HTMLInputElement>("#sdb-field-value_31")!, "after-31");
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[form="sdb-row-form"]')!.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const params = rpc.executeSkillDatabase.mock.calls.at(-1)?.[3];
    expect(params).toHaveLength(33);
    expect(params).toEqual(["after-31", ...row]);
  });

  it("keeps primary keys immutable and reports a one-row mutation conflict", async () => {
    rpc.executeSkillDatabase.mockResolvedValueOnce({
      columns: [],
      rows: [],
      row_count: 0,
      changes: 0,
      last_insert_rowid: null,
      read_only: false,
      db_size_bytes: 8192,
      schema_generation: 2,
    });
    const container = await mount();
    const edit = container.querySelector<HTMLButtonElement>('[aria-label="Edit row 1"]')!;
    await act(async () => {
      edit.click();
      await Promise.resolve();
    });
    expect(container.querySelector<HTMLInputElement>("#sdb-field-id")?.disabled).toBe(true);
    await changeValue(container.querySelector<HTMLInputElement>("#sdb-field-body")!, "Changed");
    const save = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Save changes"))!;
    await act(async () => {
      save.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(rpc.executeSkillDatabase).toHaveBeenCalledWith(
      "stateful-skill",
      expect.anything(),
      'UPDATE "private_notes" SET "body" = ? WHERE "id" IS ? AND "body" IS ?',
      ["Changed", 1, "First note"],
    );
    expect(container.textContent).toContain("The row changed elsewhere");
  });

  it("keeps archived rows read-only while leaving sharing revocation available", async () => {
    const container = await mount({ archived: true });
    const add = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Add row"));
    expect(add?.disabled).toBe(true);
    expect(container.textContent).toContain("Archived skill databases are read-only");
    expect(container.textContent).toContain("Manage sharing");
    const view = container.querySelector<HTMLButtonElement>('[aria-label="View row 1"]')!;
    await act(async () => {
      view.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("View private_notes");
  });

  it("saves an explicit member selection from the sharing drawer", async () => {
    const container = await mount();
    const manage = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Manage sharing"))!;
    await act(async () => {
      manage.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const checkbox = container.querySelector<HTMLInputElement>(".sdb-member input")!;
    await act(async () => {
      checkbox.click();
      await Promise.resolve();
    });
    const save = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Save sharing"))!;
    await act(async () => {
      save.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(rpc.setSkillDatabaseShares).toHaveBeenCalledWith("stateful-skill", ["user-2"]);
  });

  it("keeps reverse focus inside drawers", async () => {
    const container = await mount();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Edit row 1"]')!.click();
      await Promise.resolve();
    });
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(document.activeElement).toBe(dialog);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
      await Promise.resolve();
    });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("moves focus into delete confirmation when it replaces the trigger", async () => {
    const container = await mount();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Edit row 1"]')!.click();
      await Promise.resolve();
    });
    const deleteRow = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Delete row"))!;
    await act(async () => {
      deleteRow.click();
      await Promise.resolve();
    });
    const keepRow = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Keep row"))!;
    expect(document.activeElement).toBe(keepRow);
    expect(container.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
    await act(async () => {
      keepRow.click();
      await Promise.resolve();
    });
    const returnedDeleteRow = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Delete row"))!;
    expect(document.activeElement).toBe(returnedDeleteRow);
    expect(container.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
  });

  it("returns to My data when a shared realm is revoked during consultation", async () => {
    rpc.querySkillDatabase
      .mockResolvedValueOnce({
        columns: ["id", "body"],
        rows: [[1, "First note"]],
        row_count: 1,
        changes: 0,
        last_insert_rowid: null,
        read_only: true,
        db_size_bytes: 8192,
        schema_generation: 2,
      })
      .mockRejectedValueOnce(new ApiFetchError("skill database realm not found", 404));
    rpc.fetchSkillDatabase
      .mockResolvedValueOnce(description)
      .mockResolvedValueOnce({
        ...description,
        realms: description.realms.filter((realm) => realm.access !== "shared"),
      });
    const container = await mount();
    const shared = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Shared with me"))!;
    await act(async () => {
      shared.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("no longer available");
    const myData = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("My data"))!;
    expect(myData.getAttribute("aria-pressed")).toBe("true");
  });
});
