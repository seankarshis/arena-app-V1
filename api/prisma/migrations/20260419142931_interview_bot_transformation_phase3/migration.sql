-- CreateEnum
CREATE TYPE "sensitivity_level" AS ENUM ('standard', 'sensitive', 'highly_sensitive');

-- CreateEnum
CREATE TYPE "flagged_item_priority" AS ENUM ('low', 'medium', 'high', 'critical');

-- CreateEnum
CREATE TYPE "tag_merge_proposal_status" AS ENUM ('pending', 'approved', 'rejected', 'merged');

-- AlterTable
ALTER TABLE "questions" ADD COLUMN     "intent" TEXT,
ADD COLUMN     "sensitivity_level" "sensitivity_level" NOT NULL DEFAULT 'standard';

-- AlterTable
ALTER TABLE "template_questions" ADD COLUMN     "admin_notes" TEXT;

-- CreateTable
CREATE TABLE "flagged_items" (
    "id" UUID NOT NULL,
    "interview_id" UUID NOT NULL,
    "source_turn" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "suggested_tags" JSONB NOT NULL DEFAULT '[]',
    "priority" "flagged_item_priority" NOT NULL,
    "needs_admin_review" BOOLEAN NOT NULL DEFAULT true,
    "dismissed_at" TIMESTAMPTZ,
    "converted_to_question_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flagged_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tag_merge_proposals" (
    "id" UUID NOT NULL,
    "canonical_tag_id" UUID NOT NULL,
    "candidate_tag_ids" UUID[],
    "rationale" TEXT,
    "status" "tag_merge_proposal_status" NOT NULL DEFAULT 'pending',
    "proposed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tag_merge_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrichment_outbox" (
    "id" UUID NOT NULL,
    "response_id" UUID NOT NULL,
    "interview_id" UUID NOT NULL,
    "dispatched_at" TIMESTAMPTZ,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrichment_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_flagged_items_interview_id" ON "flagged_items"("interview_id");

-- CreateIndex
CREATE INDEX "idx_flagged_items_needs_admin_review" ON "flagged_items"("needs_admin_review");

-- CreateIndex
CREATE INDEX "idx_tag_merge_proposals_status" ON "tag_merge_proposals"("status");

-- CreateIndex
CREATE INDEX "idx_tag_merge_proposals_canonical_tag" ON "tag_merge_proposals"("canonical_tag_id");

-- CreateIndex
CREATE INDEX "idx_enrichment_outbox_dispatch_poll" ON "enrichment_outbox"("dispatched_at", "created_at");

-- CreateIndex
CREATE INDEX "idx_enrichment_outbox_response_id" ON "enrichment_outbox"("response_id");

-- CreateIndex
CREATE INDEX "idx_enrichment_outbox_interview_id" ON "enrichment_outbox"("interview_id");

-- AddForeignKey
ALTER TABLE "flagged_items" ADD CONSTRAINT "flagged_items_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flagged_items" ADD CONSTRAINT "flagged_items_converted_to_question_id_fkey" FOREIGN KEY ("converted_to_question_id") REFERENCES "questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_merge_proposals" ADD CONSTRAINT "tag_merge_proposals_canonical_tag_id_fkey" FOREIGN KEY ("canonical_tag_id") REFERENCES "tags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_merge_proposals" ADD CONSTRAINT "tag_merge_proposals_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrichment_outbox" ADD CONSTRAINT "enrichment_outbox_response_id_fkey" FOREIGN KEY ("response_id") REFERENCES "interview_responses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrichment_outbox" ADD CONSTRAINT "enrichment_outbox_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
