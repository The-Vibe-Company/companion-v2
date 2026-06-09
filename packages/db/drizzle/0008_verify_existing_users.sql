-- Email verification (6-digit OTP) is now required for email/password sign-in. Accounts created before
-- this change have email_verified = false and would otherwise be locked out. Backfill them as verified.
-- One-time, idempotent (the WHERE guard makes a re-run a no-op). Do NOT re-run against a populated
-- production database where genuinely-unverified accounts must stay unverified.
UPDATE "user" SET "email_verified" = true WHERE "email_verified" = false;
