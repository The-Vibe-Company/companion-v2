import { z } from "zod";

/**
 * Contracts for the official MCP registry browse surface (THE-327). The browser never talks to
 * `registry.modelcontextprotocol.io` directly — it reads these normalized shapes from the
 * companion-v2 API, which proxies, caches, and applies the pin overrides. Connecting reuses
 * THE-321's `saveCompanionPlugin`, so the registry only supplies the transport metadata and the
 * credential the server describes; the account label and any secret are always entered by the user.
 */

/**
 * A credential the registry says a server needs. For HTTP this is a header name, for stdio an
 * environment variable name. The value is never carried here: it is entered by the connecting user
 * and stored envelope-encrypted by `saveCompanionPlugin`.
 */
export const companionRegistryCredentialSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  is_secret: z.boolean(),
  required: z.boolean(),
}).strict();
export type CompanionRegistryCredential = z.infer<typeof companionRegistryCredentialSchema>;

/**
 * Normalized connect metadata mapped from the registry's `remotes`/`packages`. A `streamable-http`
 * remote maps to `http`; otherwise an `npx`/`uvx`/`oci` package maps to `stdio`. When neither maps
 * cleanly the server carries a null connect and cannot be connected from this surface.
 */
export const companionRegistryConnectSchema = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("http"),
    url: z.string(),
    credential: companionRegistryCredentialSchema.nullable(),
  }).strict(),
  z.object({
    transport: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()),
    credential: companionRegistryCredentialSchema.nullable(),
  }).strict(),
]);
export type CompanionRegistryConnect = z.infer<typeof companionRegistryConnectSchema>;

export const companionRegistryServerSchema = z.object({
  /** Registry reverse-DNS name, e.g. `app.linear/linear`. */
  name: z.string(),
  /** Stable slug derived from the name and used as the plugin `provider`, e.g. `linear`. */
  provider: z.string(),
  title: z.string(),
  description: z.string(),
  version: z.string(),
  website_url: z.string().nullable(),
  repository_url: z.string().nullable(),
  /** True for the curated, verified overrides shown at the top of the browse surface. */
  pinned: z.boolean(),
  connect: companionRegistryConnectSchema.nullable(),
}).strict();
export type CompanionRegistryServer = z.infer<typeof companionRegistryServerSchema>;

/**
 * Where the browse result came from. `live` is a fresh registry read, `cache` is the TTL cache or
 * the last-good fallback used while the registry is down, and `unavailable` means neither was
 * available so only the static pins are returned.
 */
export const companionRegistrySourceSchema = z.enum(["live", "cache", "unavailable"]);
export type CompanionRegistrySource = z.infer<typeof companionRegistrySourceSchema>;

export const companionRegistryListResponseSchema = z.object({
  /** Static, verified overrides. Present on the default view; always returned even if search fails. */
  pins: z.array(companionRegistryServerSchema),
  servers: z.array(companionRegistryServerSchema),
  next_cursor: z.string().nullable(),
  source: companionRegistrySourceSchema,
}).strict();
export type CompanionRegistryListResponse = z.infer<typeof companionRegistryListResponseSchema>;

export const companionRegistryDetailResponseSchema = z.object({
  server: companionRegistryServerSchema,
  source: companionRegistrySourceSchema,
}).strict();
export type CompanionRegistryDetailResponse = z.infer<typeof companionRegistryDetailResponseSchema>;

export const companionRegistryQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  cursor: z.string().trim().max(400).optional(),
}).strict();
export type CompanionRegistryQuery = z.infer<typeof companionRegistryQuerySchema>;

/** Registry reverse-DNS name: exactly one slash separating namespace from server name. */
export const companionRegistryServerNameSchema = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .regex(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
