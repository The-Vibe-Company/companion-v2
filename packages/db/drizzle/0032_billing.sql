CREATE TYPE "public"."billing_seat_sync_status" AS ENUM('synced', 'pending', 'error');--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"stripe_subscription_item_id" text,
	"stripe_price_id" text,
	"stripe_status" text,
	"synced_quantity" integer,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"grace_ends_at" timestamp with time zone,
	"last_stripe_event_id" text,
	"last_reconciled_at" timestamp with time zone,
	"seat_sync_status" "billing_seat_sync_status" DEFAULT 'synced' NOT NULL,
	"seat_sync_requested_at" timestamp with time zone,
	"seat_sync_attempts" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"checkout_session_id" text,
	"checkout_expires_at" timestamp with time zone,
	"checkout_generation" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscriptions_stripe_customer_id_unique" UNIQUE("stripe_customer_id"),
	CONSTRAINT "billing_subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id"),
	CONSTRAINT "billing_subscriptions_stripe_subscription_item_id_unique" UNIQUE("stripe_subscription_item_id"),
	CONSTRAINT "billing_subscriptions_checkout_session_id_unique" UNIQUE("checkout_session_id"),
	CONSTRAINT "billing_subscriptions_quantity_check" CHECK ("synced_quantity" is null or "synced_quantity" >= 1),
	CONSTRAINT "billing_subscriptions_attempts_check" CHECK ("seat_sync_attempts" >= 0),
	CONSTRAINT "billing_subscriptions_checkout_generation_check" CHECK ("checkout_generation" >= 0)
);--> statement-breakpoint
CREATE TABLE "stripe_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "stripe_webhook_events_status_check" CHECK ("status" in ('processing', 'processed', 'failed'))
);--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_webhook_events" ADD CONSTRAINT "stripe_webhook_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_subscriptions_pending_idx" ON "billing_subscriptions" USING btree ("seat_sync_status","next_retry_at");--> statement-breakpoint
CREATE INDEX "billing_subscriptions_reconcile_idx" ON "billing_subscriptions" USING btree ("last_reconciled_at");--> statement-breakpoint
CREATE INDEX "stripe_webhook_events_org_idx" ON "stripe_webhook_events" USING btree ("org_id","received_at");--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stripe_webhook_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "billing_subscriptions_tenant_rls" ON "billing_subscriptions" USING ("org_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "stripe_webhook_events_tenant_rls" ON "stripe_webhook_events" USING ("org_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "plan";--> statement-breakpoint
DROP TYPE "public"."org_plan";
