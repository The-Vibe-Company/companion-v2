CREATE TYPE "notification_type" AS ENUM ('skill.version_published', 'skill.comment_added', 'skill.comment_reply', 'skill.archived');--> statement-breakpoint
CREATE TYPE "notification_reason" AS ENUM ('owner', 'installer', 'starrer', 'commenter', 'thread_participant', 'subscriber');--> statement-breakpoint
CREATE TYPE "skill_subscription_state" AS ENUM ('subscribed', 'muted');--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"recipient_user_id" text NOT NULL,
	"actor_id" text,
	"type" "notification_type" NOT NULL,
	"reason" "notification_reason" NOT NULL,
	"skill_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_subscriptions" (
	"org_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"state" "skill_subscription_state" DEFAULT 'subscribed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_subscriptions_skill_id_user_id_pk" PRIMARY KEY("skill_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_skill_org_fk" FOREIGN KEY ("org_id","skill_id") REFERENCES "public"."skills"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_subscriptions" ADD CONSTRAINT "skill_subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_subscriptions" ADD CONSTRAINT "skill_subscriptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_subscriptions" ADD CONSTRAINT "skill_subscriptions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_subscriptions" ADD CONSTRAINT "skill_subscriptions_skill_org_fk" FOREIGN KEY ("org_id","skill_id") REFERENCES "public"."skills"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("org_id","recipient_user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("org_id","recipient_user_id") WHERE "read_at" is null;--> statement-breakpoint
CREATE INDEX "skill_subscriptions_org_skill_idx" ON "skill_subscriptions" USING btree ("org_id","skill_id");--> statement-breakpoint
CREATE INDEX "skill_subscriptions_org_user_idx" ON "skill_subscriptions" USING btree ("org_id","user_id");--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "notifications_tenant_rls" ON "notifications"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "skill_subscriptions_tenant_rls" ON "skill_subscriptions"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
