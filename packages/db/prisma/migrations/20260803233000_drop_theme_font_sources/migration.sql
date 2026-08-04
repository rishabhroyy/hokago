-- AlterEnum
BEGIN;
CREATE TYPE "FontSource_new" AS ENUM ('VENDORED', 'SUBTITLE', 'USER_DROP');
ALTER TABLE "fonts" ALTER COLUMN "source" TYPE "FontSource_new" USING ("source"::text::"FontSource_new");
ALTER TYPE "FontSource" RENAME TO "FontSource_old";
ALTER TYPE "FontSource_new" RENAME TO "FontSource";
DROP TYPE "public"."FontSource_old";
COMMIT;
