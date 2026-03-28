/*
  Warnings:

  - You are about to drop the column `tag_type` on the `tags` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "idx_tags_tag_type_is_active";

-- AlterTable
ALTER TABLE "tags" DROP COLUMN "tag_type";

-- CreateIndex
CREATE INDEX "idx_tags_is_active" ON "tags"("is_active");
