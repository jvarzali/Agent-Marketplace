-- AlterTable
ALTER TABLE "users" ADD COLUMN "auto_purchases_seen_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "approvals" ADD COLUMN "override" BOOLEAN NOT NULL DEFAULT false;
