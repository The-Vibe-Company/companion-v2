import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import {
  createAppStoreConnectToken,
  createBuildNumber,
  findAppStoreConnectBuild,
  findReusableAppStoreConnectBuild,
} from "./app-store-connect-build.mjs";

test("build numbers are deterministic and unique across workflow runs and retries", () => {
  const first = createBuildNumber("17000000001", "1");
  const repeated = createBuildNumber("17000000001", "1");
  const retried = createBuildNumber("17000000001", "2");
  const otherRun = createBuildNumber("17000000002", "1");

  assert.equal(first, repeated);
  assert.match(first, /^\d{14}$/);
  assert.notEqual(first, retried);
  assert.ok(BigInt(first) < BigInt(retried));
  assert.ok(BigInt(retried) < BigInt(otherRun));
  assert.throws(() => createBuildNumber("not-a-run", "1"));
  assert.throws(() => createBuildNumber("17000000001", "1000"));
  assert.throws(() => createBuildNumber("9999999999999999", "1"), /18 digits/);
});

test("failed prior uploads are retried while accepted uploads remain idempotent", async () => {
  const responses = new Map([
    ["17000000001001", { id: "failed", attributes: { version: "17000000001001", processingState: "FAILED" } }],
    ["17000000001002", null],
  ]);
  const request = async (url) => {
    const version = url.searchParams.get("filter[version]");
    const build = responses.get(version);
    return new Response(JSON.stringify({ data: build ? [build] : [] }), { status: 200 });
  };

  assert.equal(await findReusableAppStoreConnectBuild("6804447784", "17000000001", "2", "jwt", request), null);
  responses.set("17000000001001", {
    id: "valid",
    attributes: { version: "17000000001001", processingState: "VALID" },
  });
  assert.equal(
    (await findReusableAppStoreConnectBuild("6804447784", "17000000001", "2", "jwt", request)).id,
    "valid",
  );
  responses.set("17000000001001", null);
  responses.set("17000000001002", {
    id: "invalid",
    attributes: { version: "17000000001002", processingState: "INVALID" },
  });
  await assert.rejects(
    findReusableAppStoreConnectBuild("6804447784", "17000000001", "2", "jwt", request),
    /rerun this workflow/,
  );
});

test("App Store Connect tokens use a verifiable ES256 signature and bounded lifetime", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const token = createAppStoreConnectToken(
    "issuer-id",
    "key-id",
    privateKey.export({ format: "pem", type: "pkcs8" }),
    1_700_000_000,
  );
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));

  assert.deepEqual(header, { alg: "ES256", kid: "key-id", typ: "JWT" });
  assert.deepEqual(payload, {
    iss: "issuer-id",
    iat: 1_700_000_000,
    exp: 1_700_000_600,
    aud: "appstoreconnect-v1",
  });
  assert.equal(
    verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(encodedSignature, "base64url"),
    ),
    true,
  );
});

test("build lookup filters by app and build number without exposing response bodies", async () => {
  let requestedURL = "";
  let authorization = "";
  const build = await findAppStoreConnectBuild("6804447784", "202608241433", "jwt-token", async (url, options) => {
    requestedURL = url.toString();
    authorization = options.headers.Authorization;
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "build-id",
            attributes: {
              version: "202608241433",
              uploadedDate: "2026-08-24T14:34:00Z",
              processingState: "VALID",
            },
          },
        ],
      }),
      { status: 200 },
    );
  });

  const url = new URL(requestedURL);
  assert.equal(url.searchParams.get("filter[app]"), "6804447784");
  assert.equal(url.searchParams.get("filter[version]"), "202608241433");
  assert.equal(authorization, "Bearer jwt-token");
  assert.deepEqual(build, {
    id: "build-id",
    version: "202608241433",
    uploadedDate: "2026-08-24T14:34:00Z",
    processingState: "VALID",
  });

  await assert.rejects(
    findAppStoreConnectBuild("6804447784", "missing", "jwt-token", async () => new Response("private", { status: 401 })),
    /HTTP 401/,
  );
});
