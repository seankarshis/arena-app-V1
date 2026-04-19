-- Drop the master Question.category column. The category concept is now
-- owned by TemplateQuestion.categoryBucket (template-level) and the tags
-- many-to-many (cross-cutting). See ADR 005.
ALTER TABLE "questions" DROP COLUMN "category";
