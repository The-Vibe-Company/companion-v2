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
});
