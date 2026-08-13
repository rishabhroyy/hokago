-- Trickplay: sheets are disposable cache derived from the source file's
-- content hash (MediaFile.hash, the idempotency key for all derived work).
-- sourceHash records which hash a sheet set was generated from; a mismatch
-- with media_files.hash means the file changed and the sheets are stale.
-- Additive nullable column — no backfill needed (no rows exist yet).

-- AlterTable
ALTER TABLE "trickplay" ADD COLUMN "sourceHash" TEXT;
