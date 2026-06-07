import { describe, expect, it } from "vitest";
import { putSkillArchive, skillArchiveKey } from "../src";

describe("skillArchiveKey", () => {
  it("uses the stable tenant/slug/version path", () => {
    expect(skillArchiveKey({ orgId: "org-1", slug: "pdf-extract", version: "1.2.3" })).toBe(
      "org-1/pdf-extract/1.2.3.tar.gz",
    );
  });
});

describe("putSkillArchive", () => {
  it("can send a conditional put to preserve immutable version keys", async () => {
    const sent: unknown[] = [];
    const client = {
      send: async (command: { input: unknown }) => {
        sent.push(command.input);
      },
    };

    await putSkillArchive({
      key: "org-1/pdf-extract/1.2.3.tar.gz",
      body: new Uint8Array([1, 2, 3]),
      preventOverwrite: true,
      client: client as never,
      config: {
        endpoint: "http://127.0.0.1:9000",
        region: "us-east-1",
        accessKeyId: "companion",
        secretAccessKey: "companion-secret",
        bucket: "skill-archives",
        forcePathStyle: true,
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ IfNoneMatch: "*" });
  });
});
