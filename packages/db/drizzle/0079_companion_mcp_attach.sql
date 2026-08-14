-- THE-361: per-Companion MCP plugin allow-list (already-connected member accounts only).
ALTER TABLE "companions"
  ADD COLUMN "selected_mcp_account_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
-- Postgres CHECK cannot use subqueries; UUID element shape is enforced in contracts/core.
ALTER TABLE "companions"
  ADD CONSTRAINT "companions_selected_mcp_account_ids_check"
  CHECK (jsonb_typeof("selected_mcp_account_ids") = 'array');
