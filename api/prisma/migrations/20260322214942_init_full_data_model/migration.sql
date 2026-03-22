-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "label" VARCHAR(255) NOT NULL,
    "tag_type" VARCHAR(50) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "category" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_tags" (
    "question_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,

    CONSTRAINT "question_tags_pkey" PRIMARY KEY ("question_id","tag_id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "role" VARCHAR(20) NOT NULL DEFAULT 'user',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_tags" (
    "user_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,

    CONSTRAINT "user_tags_pkey" PRIMARY KEY ("user_id","tag_id")
);

-- CreateTable
CREATE TABLE "user_templates" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "completed_at" TIMESTAMPTZ,
    "removed_at" TIMESTAMPTZ,

    CONSTRAINT "user_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_assignment_history" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by" UUID NOT NULL,
    "unassigned_at" TIMESTAMPTZ,
    "unassigned_reason" VARCHAR(100),

    CONSTRAINT "template_assignment_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_templates" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interview_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_questions" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "sequence_order" INTEGER NOT NULL,
    "category_bucket" VARCHAR(100) NOT NULL,
    "is_required" BOOLEAN NOT NULL DEFAULT true,
    "followup_triggers" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interviews" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'scheduled',
    "session_snapshot" JSONB,
    "paused_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "total_llm_prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_llm_completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_stt_duration_seconds" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total_tts_characters" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_responses" (
    "id" UUID NOT NULL,
    "interview_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "question_text_as_asked" TEXT NOT NULL,
    "sequence_number" INTEGER NOT NULL,
    "tags_at_time" JSONB NOT NULL DEFAULT '[]',
    "category_bucket" VARCHAR(100),
    "is_followup" BOOLEAN NOT NULL DEFAULT false,
    "parent_response_id" UUID,
    "is_skipped" BOOLEAN NOT NULL DEFAULT false,
    "input_mode" VARCHAR(10) NOT NULL DEFAULT 'voice',
    "s3_audio_key" VARCHAR(1024),
    "s3_audio_bucket" VARCHAR(255),
    "audio_mime_type" VARCHAR(100),
    "audio_duration_seconds" DECIMAL(10,2),
    "audio_upload_status" VARCHAR(20) NOT NULL DEFAULT 'not_applicable',
    "stt_engine" VARCHAR(100),
    "raw_transcription" TEXT,
    "stt_confidence_score" DECIMAL(5,4),
    "cleaned_markdown" TEXT,
    "cleaning_model" VARCHAR(100),
    "cleaned_at" TIMESTAMPTZ,
    "processing_status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "error_message" TEXT,
    "llm_prompt_tokens" INTEGER,
    "llm_completion_tokens" INTEGER,
    "llm_model" VARCHAR(100),
    "llm_latency_ms" INTEGER,
    "stt_duration_billed_seconds" DECIMAL(10,2),
    "tts_characters_billed" INTEGER,
    "responded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interview_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "response_drafts" (
    "id" UUID NOT NULL,
    "interview_id" UUID NOT NULL,
    "question_id" UUID,
    "draft_number" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "input_mode" VARCHAR(10) NOT NULL,
    "stt_confidence_score" DECIMAL(5,4),
    "s3_audio_key" VARCHAR(1024),
    "s3_audio_bucket" VARCHAR(255),
    "audio_mime_type" VARCHAR(100),
    "audio_duration_seconds" DECIMAL(10,2),
    "audio_upload_status" VARCHAR(20) DEFAULT 'pending',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "response_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_consent_records" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "consent_type" VARCHAR(50) NOT NULL,
    "consent_version" VARCHAR(20) NOT NULL,
    "granted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ,
    "ip_address" VARCHAR(45),

    CONSTRAINT "user_consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_log" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "entity_type" VARCHAR(50) NOT NULL,
    "entity_id" UUID NOT NULL,
    "changes" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tags_label_key" ON "tags"("label");

-- CreateIndex
CREATE INDEX "idx_tags_tag_type_is_active" ON "tags"("tag_type", "is_active");

-- CreateIndex
CREATE INDEX "idx_questions_is_active" ON "questions"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "idx_user_templates_user_id_status" ON "user_templates"("user_id", "status");

-- CreateIndex
CREATE INDEX "idx_user_templates_template_id_status" ON "user_templates"("template_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "user_templates_user_id_template_id_key" ON "user_templates"("user_id", "template_id");

-- CreateIndex
CREATE INDEX "idx_template_assignment_history_user_id" ON "template_assignment_history"("user_id");

-- CreateIndex
CREATE INDEX "idx_interview_templates_status" ON "interview_templates"("status");

-- CreateIndex
CREATE UNIQUE INDEX "template_questions_template_id_question_id_key" ON "template_questions"("template_id", "question_id");

-- CreateIndex
CREATE UNIQUE INDEX "template_questions_template_id_sequence_order_key" ON "template_questions"("template_id", "sequence_order");

-- CreateIndex
CREATE INDEX "idx_interviews_user_id_status" ON "interviews"("user_id", "status");

-- CreateIndex
CREATE INDEX "idx_interviews_status_paused_at" ON "interviews"("status", "paused_at");

-- CreateIndex
CREATE INDEX "idx_interview_responses_interview_processing" ON "interview_responses"("interview_id", "processing_status");

-- CreateIndex
CREATE INDEX "idx_interview_responses_processing_responded" ON "interview_responses"("processing_status", "responded_at");

-- CreateIndex
CREATE INDEX "idx_interview_responses_audio_reconciliation" ON "interview_responses"("input_mode", "audio_upload_status", "responded_at");

-- CreateIndex
CREATE INDEX "idx_response_drafts_interview_question" ON "response_drafts"("interview_id", "question_id");

-- CreateIndex
CREATE UNIQUE INDEX "response_drafts_interview_id_question_id_draft_number_key" ON "response_drafts"("interview_id", "question_id", "draft_number");

-- CreateIndex
CREATE INDEX "idx_user_consent_records_user_consent_type" ON "user_consent_records"("user_id", "consent_type");

-- CreateIndex
CREATE UNIQUE INDEX "user_consent_records_user_id_consent_type_consent_version_key" ON "user_consent_records"("user_id", "consent_type", "consent_version");

-- CreateIndex
CREATE INDEX "idx_admin_audit_log_entity" ON "admin_audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "idx_admin_audit_log_actor_created" ON "admin_audit_log"("actor_id", "created_at");

-- AddForeignKey
ALTER TABLE "question_tags" ADD CONSTRAINT "question_tags_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_tags" ADD CONSTRAINT "question_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_tags" ADD CONSTRAINT "user_tags_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_tags" ADD CONSTRAINT "user_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_templates" ADD CONSTRAINT "user_templates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_templates" ADD CONSTRAINT "user_templates_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "interview_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_templates" ADD CONSTRAINT "user_templates_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_assignment_history" ADD CONSTRAINT "template_assignment_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_assignment_history" ADD CONSTRAINT "template_assignment_history_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "interview_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_assignment_history" ADD CONSTRAINT "template_assignment_history_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_questions" ADD CONSTRAINT "template_questions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "interview_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_questions" ADD CONSTRAINT "template_questions_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "interview_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_responses" ADD CONSTRAINT "interview_responses_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_responses" ADD CONSTRAINT "interview_responses_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_responses" ADD CONSTRAINT "interview_responses_parent_response_id_fkey" FOREIGN KEY ("parent_response_id") REFERENCES "interview_responses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "response_drafts" ADD CONSTRAINT "response_drafts_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "response_drafts" ADD CONSTRAINT "response_drafts_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_consent_records" ADD CONSTRAINT "user_consent_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraints (VARCHAR with CHECK instead of Postgres ENUM)
ALTER TABLE "tags" ADD CONSTRAINT "chk_tags_tag_type" CHECK ("tag_type" IN ('role','department','topic','seniority','domain'));

ALTER TABLE "users" ADD CONSTRAINT "chk_users_role" CHECK ("role" IN ('admin','user'));

ALTER TABLE "user_templates" ADD CONSTRAINT "chk_user_templates_status" CHECK ("status" IN ('active','completed','removed'));

ALTER TABLE "interview_templates" ADD CONSTRAINT "chk_interview_templates_status" CHECK ("status" IN ('draft','published','archived'));

ALTER TABLE "interviews" ADD CONSTRAINT "chk_interviews_status" CHECK ("status" IN ('scheduled','in_progress','paused','completed','abandoned'));

ALTER TABLE "interview_responses" ADD CONSTRAINT "chk_interview_responses_input_mode" CHECK ("input_mode" IN ('voice','text','edited'));
ALTER TABLE "interview_responses" ADD CONSTRAINT "chk_interview_responses_audio_upload_status" CHECK ("audio_upload_status" IN ('pending','uploaded','failed','not_applicable'));
ALTER TABLE "interview_responses" ADD CONSTRAINT "chk_interview_responses_processing_status" CHECK ("processing_status" IN ('pending','cleaning','cleaned','error'));

ALTER TABLE "response_drafts" ADD CONSTRAINT "chk_response_drafts_input_mode" CHECK ("input_mode" IN ('voice','text','edited'));
ALTER TABLE "response_drafts" ADD CONSTRAINT "chk_response_drafts_audio_upload_status" CHECK ("audio_upload_status" IN ('pending','uploaded','failed'));

ALTER TABLE "user_consent_records" ADD CONSTRAINT "chk_user_consent_records_consent_type" CHECK ("consent_type" IN ('data_processing','audio_recording','ai_interaction'));

-- Partial unique indexes (replace full unique indexes with filtered ones)
DROP INDEX "user_templates_user_id_template_id_key";
CREATE UNIQUE INDEX "uq_user_templates_user_template_active" ON "user_templates"("user_id", "template_id") WHERE "status" = 'active';

DROP INDEX "user_consent_records_user_id_consent_type_consent_version_key";
CREATE UNIQUE INDEX "uq_user_consent_active" ON "user_consent_records"("user_id", "consent_type", "consent_version") WHERE "revoked_at" IS NULL;
