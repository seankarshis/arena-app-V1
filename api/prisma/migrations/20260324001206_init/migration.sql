/*
  Warnings:

  - A unique constraint covering the columns `[user_id,consent_type,consent_version]` on the table `user_consent_records` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[user_id,template_id]` on the table `user_templates` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "user_consent_records_user_id_consent_type_consent_version_key" ON "user_consent_records"("user_id", "consent_type", "consent_version");

-- CreateIndex
CREATE UNIQUE INDEX "user_templates_user_id_template_id_key" ON "user_templates"("user_id", "template_id");
