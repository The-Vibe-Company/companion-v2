import { beforeEach, describe, expect, it, vi } from "vitest";
import { isUnread, markViewed, readViewed } from "./unread";

const ORG = "org-1";
const LUNA = "companion-1";

function companion(last: {
  created_at: string;
  author_id: string | null;
} | null) {
  return {
    id: LUNA,
    last_message: last
      ? {
          preview: "Drafted the launch note.",
          role: last.author_id ? ("user" as const) : ("assistant" as const),
          author_id: last.author_id,
          author_name: last.author_id ? "Ada" : null,
          created_at: last.created_at,
        }
      : null,
  };
}

function installStorage(): Storage {
  const values = new Map<string, string>();
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  } as Storage;
  vi.stubGlobal("window", { localStorage: store });
  return store;
}

describe("companion unread state", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks a thread unread until this reader has opened it", () => {
    installStorage();
    const arrived = companion({ created_at: "2026-08-14T09:00:00.000Z", author_id: null });

    expect(isUnread(arrived, "user-1", readViewed(ORG))).toBe(true);

    const viewed = markViewed(ORG, LUNA, "2026-08-14T09:00:01.000Z");
    expect(isUnread(arrived, "user-1", viewed)).toBe(false);
    // Read state survives the next paint, which is the whole point of remembering it.
    expect(isUnread(arrived, "user-1", readViewed(ORG))).toBe(false);
  });

  it("marks it unread again when someone else writes after that", () => {
    installStorage();
    markViewed(ORG, LUNA, "2026-08-14T09:00:00.000Z");

    const replied = companion({ created_at: "2026-08-14T09:05:00.000Z", author_id: null });
    expect(isUnread(replied, "user-1", readViewed(ORG))).toBe(true);
  });

  it("never marks a reader's own last word unread", () => {
    installStorage();
    const mine = companion({ created_at: "2026-08-14T09:05:00.000Z", author_id: "user-1" });

    expect(isUnread(mine, "user-1", {})).toBe(false);
    // Somebody else on a shared thread is a different matter.
    expect(isUnread(mine, "user-2", {})).toBe(true);
  });

  it("says nothing about a thread nobody has written in", () => {
    installStorage();

    expect(isUnread(companion(null), "user-1", {})).toBe(false);
  });

  it("only ever moves a thread's read mark forward", () => {
    installStorage();
    markViewed(ORG, LUNA, "2026-08-14T09:05:00.000Z");

    // A slower poll answering late must not reopen a thread the reader has already caught up on.
    const viewed = markViewed(ORG, LUNA, "2026-08-14T09:00:00.000Z");
    expect(viewed[LUNA]).toBe("2026-08-14T09:05:00.000Z");
  });

  it("keeps one workspace's read state out of another's rows", () => {
    installStorage();
    markViewed(ORG, LUNA, "2026-08-14T09:05:00.000Z");

    expect(readViewed("org-2")).toEqual({});
  });

  it("falls back to unread when the device refuses to remember anything", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("storage is disabled");
      },
    });
    const arrived = companion({ created_at: "2026-08-14T09:00:00.000Z", author_id: null });

    expect(readViewed(ORG)).toEqual({});
    expect(() => markViewed(ORG, LUNA, "2026-08-14T09:00:01.000Z")).not.toThrow();
    expect(isUnread(arrived, "user-1", readViewed(ORG))).toBe(true);
  });

  it("ignores stored junk rather than trusting it", () => {
    const store = installStorage();
    store.setItem(`companions:last-viewed:${ORG}`, "not json");
    expect(readViewed(ORG)).toEqual({});

    store.setItem(`companions:last-viewed:${ORG}`, JSON.stringify({ [LUNA]: 42 }));
    expect(readViewed(ORG)).toEqual({});
  });
});
