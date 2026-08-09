-- Remove the optional user-key tier entirely (TMDB was its only member).
-- Drop the provider_config table and strip TMDB out of the Provider enum.
-- provider_config holds no rows that matter (optional tier shipped off and was
-- never wired to a real adapter), and no library references TMDB in
-- providerOrder, so the enum recast is lossless.

-- DropTable
DROP TABLE "provider_config";

-- AlterEnum (recreate-type dance: PG can't drop a value in place)
BEGIN;
CREATE TYPE "Provider_new" AS ENUM ('LOCAL', 'EMBEDDED', 'GENERATED', 'TVMAZE', 'ANILIST', 'MAL', 'ANIDB', 'IMDB', 'WIKIDATA');
ALTER TABLE "libraries" ALTER COLUMN "providerOrder" TYPE "Provider_new"[] USING ("providerOrder"::text[]::"Provider_new"[]);
ALTER TYPE "Provider" RENAME TO "Provider_old";
ALTER TYPE "Provider_new" RENAME TO "Provider";
DROP TYPE "public"."Provider_old";
COMMIT;
