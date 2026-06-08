import { z } from "zod";

/** Every personal access token carries this prefix. */
export const API_TOKEN_PREFIX = "cmp_pat_";

/** Capability scopes a personal access token can carry. */
export const tokenScopeSchema = z.enum(["skills:read", "skills:write"]);
export type TokenScope = z.infer<typeof tokenScopeSchema>;

export const TOKEN_SCOPES: readonly TokenScope[] = ["skills:read", "skills:write"] as const;

/** Body of `POST /v1/tokens` — request a short-lived scoped token. */
export const issueTokenInputSchema = z.object({
  scopes: z.array(tokenScopeSchema).min(1),
  name: z.string().min(1).max(120).optional(),
});
export type IssueTokenInput = z.infer<typeof issueTokenInputSchema>;

/** Response of `POST /v1/tokens` — the plaintext `token` is returned exactly once. */
export const issuedTokenSchema = z.object({
  id: z.string(),
  token: z.string().startsWith(API_TOKEN_PREFIX),
  prefix: z.string().startsWith(API_TOKEN_PREFIX),
  scopes: z.array(tokenScopeSchema).min(1),
  expires_at: z.string(),
});
export type IssuedToken = z.infer<typeof issuedTokenSchema>;

/** A stored token's metadata — never includes the secret. */
export const apiTokenRowSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  user_id: z.string(),
  name: z.string(),
  prefix: z.string().startsWith(API_TOKEN_PREFIX),
  scopes: z.array(tokenScopeSchema).min(1),
  expires_at: z.string(),
  last_used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  created_at: z.string(),
});
export type ApiTokenRow = z.infer<typeof apiTokenRowSchema>;
