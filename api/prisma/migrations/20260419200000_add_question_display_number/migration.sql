-- Add a stable, unique, human-referenceable number per question.
-- Preserves the sequential numbering encoded in the seed UUIDs
-- (pattern 20000000-0000-4000-a000-000000000NNN) so existing references
-- in seed intent/probe text (e.g. "follow up via Q16") remain valid.

-- 1) Add column as nullable so we can backfill before enforcing NOT NULL.
ALTER TABLE "questions" ADD COLUMN "display_number" INTEGER;

-- 2) Backfill seed questions: extract the numeric tail from their deterministic UUID.
UPDATE "questions"
SET "display_number" = CAST(SUBSTRING(id::text FROM 25 FOR 12) AS INTEGER)
WHERE id::text LIKE '20000000-0000-4000-a000-%';

-- 3) Backfill any non-seed questions (created via UI during dev) with numbers
--    above the current max, ordered by creation time to keep things stable.
WITH renumber AS (
  SELECT
    id,
    COALESCE((SELECT MAX("display_number") FROM "questions"), 0)
      + ROW_NUMBER() OVER (ORDER BY "created_at") AS new_num
  FROM "questions"
  WHERE "display_number" IS NULL
)
UPDATE "questions" q
SET "display_number" = r.new_num
FROM renumber r
WHERE q.id = r.id;

-- 4) Create the sequence Prisma expects (name matches @default(autoincrement())
--    for the "questions.display_number" column).
CREATE SEQUENCE IF NOT EXISTS "questions_display_number_seq" AS INTEGER;

-- 5) Advance the sequence past the highest backfilled value so new inserts
--    never collide with a seeded reference. Using is_called=false means the
--    very next nextval() returns the given number (handles the empty-table
--    shadow-DB case where MAX is NULL).
SELECT setval(
  'questions_display_number_seq',
  GREATEST(COALESCE((SELECT MAX("display_number") FROM "questions"), 0) + 1, 1),
  false
);

-- 6) Wire the sequence to the column and enforce NOT NULL + UNIQUE.
ALTER TABLE "questions"
  ALTER COLUMN "display_number" SET DEFAULT nextval('questions_display_number_seq');
ALTER SEQUENCE "questions_display_number_seq" OWNED BY "questions"."display_number";
ALTER TABLE "questions" ALTER COLUMN "display_number" SET NOT NULL;
ALTER TABLE "questions"
  ADD CONSTRAINT "questions_display_number_key" UNIQUE ("display_number");
