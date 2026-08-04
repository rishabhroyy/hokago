-- Add genres, rating, studio descriptive columns to media_items
ALTER TABLE "media_items" ADD COLUMN "genres" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "media_items" ADD COLUMN "rating" DOUBLE PRECISION;
ALTER TABLE "media_items" ADD COLUMN "studio" TEXT;