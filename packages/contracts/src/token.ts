import { z } from "zod";

/** Every personal access token carries this prefix. */
export const API_TOKEN_PREFIX = "cmp_pat_";

/** Capability scopes a personal access token can carry. */
export const tokenScopeSchema = z.enum(["skills:read", "skills:write", "secrets:read", "secrets:write"]);
export type TokenScope = z.infer<typeof tokenScopeSchema>;

export const TOKEN_SCOPES: readonly TokenScope[] = ["skills:read", "skills:write", "secrets:read", "secrets:write"] as const;

/** A non-empty, validated set of capabilities carried by a personal access token. */
export const tokenScopesSchema = z.array(tokenScopeSchema).min(1);

/** Body of `POST /v1/tokens` — request a scoped token. */
export const issueTokenInputSchema = z.object({
  scopes: tokenScopesSchema,
  name: z.string().min(1).max(120).optional(),
});
export type IssueTokenInput = z.infer<typeof issueTokenInputSchema>;

/** Response of `POST /v1/tokens` — the plaintext `token` is returned exactly once. */
export const issuedTokenSchema = z.object({
  id: z.string(),
  token: z.string().startsWith(API_TOKEN_PREFIX),
  prefix: z.string().startsWith(API_TOKEN_PREFIX),
  scopes: tokenScopesSchema,
  expires_at: z.string(),
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
