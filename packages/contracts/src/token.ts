import { z } from "zod";

/** Every personal access token carries this prefix. */
export const API_TOKEN_PREFIX = "cmp_pat_";

/** Capability scopes a personal access token can carry. */
export const tokenScopeSchema = z.enum([
  "skills:read",
  "skills:write",
  "secrets:read",
  "secrets:write",
  "database:read",
  "database:write",
  "public-skills:install",
]);
export type TokenScope = z.infer<typeof tokenScopeSchema>;

export const TOKEN_SCOPES: readonly TokenScope[] = [
  "skills:read",
  "skills:write",
  "secrets:read",
  "secrets:write",
  "database:read",
  "database:write",
  "public-skills:install",
] as const;

/**
 * Return scopes in canonical order with every implied capability made explicit.
 *
 * `database:write` includes `database:read` because DML can observe database state through
 * predicates, subqueries, conflict handling, and returned rows.
 */
export function expandTokenScopes(scopes: readonly TokenScope[]): TokenScope[] {
  const expanded = new Set(scopes);
  if (expanded.has("database:write")) expanded.add("database:read");
  return TOKEN_SCOPES.filter((scope) => expanded.has(scope));
}

/** A non-empty, validated set of capabilities carried by a personal access token. */
export const tokenScopesSchema = z.array(tokenScopeSchema).min(1);

/** Existing browser-session form of `POST /v1/tokens`. */
export const issueHumanTokenInputSchema = z.object({
  scopes: tokenScopesSchema,
  name: z.string().min(1).max(120).optional(),
  /** Prevent this branch from silently accepting the Agent Auth-only discriminator. */
  inherit_agent_grants: z.never().optional(),
});

/** Agent Auth-only form. Scopes and tenant identity are derived server-side, never caller-selected. */
export const issueInheritedTokenInputSchema = z.object({
  inherit_agent_grants: z.literal(true),
  name: z.string().min(1).max(120).optional(),
  ttl_seconds: z.number().int().min(300).max(60 * 60 * 24 * 7).optional(),
  target_workspace_id: z.string().trim().min(1).max(200).optional(),
  /** Make a mixed inheritance + arbitrary-scopes request fail rather than strip `scopes`. */
  scopes: z.never().optional(),
});

/** Body of `POST /v1/tokens` — human-selected scopes or an exact Agent Auth grant snapshot. */
export const issueTokenInputSchema = z.union([
  issueHumanTokenInputSchema,
  issueInheritedTokenInputSchema,
]);
export type IssueTokenInput = z.infer<typeof issueTokenInputSchema>;

/** Response of `POST /v1/tokens` — the plaintext `token` is returned exactly once. */
export const issuedTokenSchema = z.object({
  id: z.string(),
  token: z.string().startsWith(API_TOKEN_PREFIX),
  prefix: z.string().startsWith(API_TOKEN_PREFIX),
  scopes: tokenScopesSchema,
  expires_at: z.string(),
  target_workspace_id: z.string().nullable().optional(),
});
export type IssuedToken = z.infer<typeof issuedTokenSchema>;

/**
 * Response of `POST /v1/tokens/refresh`.
 *
 * An active token is left untouched and its plaintext is never returned. An eligible expired
 * token is replaced once; only that branch returns the successor plaintext.
 */
export const refreshTokenResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("current"),
    scopes: tokenScopesSchema,
    expires_at: z.string(),
  }),
  issuedTokenSchema.extend({ status: z.literal("rotated") }),
]);
export type RefreshTokenResponse = z.infer<typeof refreshTokenResponseSchema>;

/** A stored token's metadata — never includes the secret. */
export const apiTokenRowSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  user_id: z.string(),
  name: z.string(),
  prefix: z.string().startsWith(API_TOKEN_PREFIX),
  scopes: tokenScopesSchema,
  expires_at: z.string(),
  last_used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  created_at: z.string(),
});
export type ApiTokenRow = z.infer<typeof apiTokenRowSchema>;
