import { describe, expect, it, vi } from "vitest";
import { sweepRunAttachmentOrphans } from "./runAttachmentCleanup";

describe("run attachment orphan maintenance", () => {
  it("keeps fresh and referenced objects and deletes only old objects absent on the final read", async () => {
    const remove = vi.fn(async () => undefined);
    const deleteIfReserved = vi.fn(async ({ storageKey, deleteObject }: { storageKey: string; deleteObject: () => Promise<void> }) => {
      if (storageKey !== "orphan") return false;
      await deleteObject();
      return true;
    });
    const result = await sweepRunAttachmentOrphans({
      now: new Date("2026-07-15T12:00:00Z"),
      graceMs: 60_000,
      listReservations: async () => ["referenced", "orphan", "raced"],
      deleteIfReserved: deleteIfReserved as never,
      deleteObject: remove,
    });
    expect(remove).toHaveBeenCalledWith("orphan");
    expect(remove).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ deleted: 1, retained: 2, failed: 0 });
  });

  it("backs off a poison key so candidates beyond the batch limit still progress", async () => {
    const now = new Date("2026-07-15T12:00:00Z");
    const rows = [
      { key: "poison", touchedAt: new Date("2026-07-13T00:00:00Z") },
      { key: "first", touchedAt: new Date("2026-07-13T01:00:00Z") },
      { key: "beyond-limit", touchedAt: new Date("2026-07-13T02:00:00Z") },
    ];
    const listReservations = async ({ before, limit = 250 }: { before: Date; limit?: number }) =>
      rows
        .filter((row) => row.touchedAt < before)
        .sort((left, right) => left.touchedAt.getTime() - right.touchedAt.getTime())
        .slice(0, limit)
        .map((row) => row.key);
    const deleteIfReserved = async ({ storageKey }: { storageKey: string }) => {
      if (storageKey === "poison") throw new Error("persistent S3 failure");
      rows.splice(rows.findIndex((row) => row.key === storageKey), 1);
      return true;
    };
    const deferReservation = async ({ storageKey }: { storageKey: string }) => {
      const row = rows.find((candidate) => candidate.key === storageKey);
      if (row) row.touchedAt = now;
      return Boolean(row);
    };

    await expect(sweepRunAttachmentOrphans({
      now,
      graceMs: 60_000,
      limit: 2,
      listReservations: listReservations as never,
      deleteIfReserved: deleteIfReserved as never,
      deferReservation: deferReservation as never,
    })).resolves.toEqual({ deleted: 1, retained: 0, failed: 1 });
    await expect(sweepRunAttachmentOrphans({
      now,
      graceMs: 60_000,
      limit: 2,
      listReservations: listReservations as never,
      deleteIfReserved: deleteIfReserved as never,
      deferReservation: deferReservation as never,
    })).resolves.toEqual({ deleted: 1, retained: 0, failed: 0 });
    expect(rows.map((row) => row.key)).toEqual(["poison"]);
  });
});
