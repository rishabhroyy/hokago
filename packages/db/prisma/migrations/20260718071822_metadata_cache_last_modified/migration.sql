/*
  Warnings:

  - You are about to drop the column `etag` on the `metadata_cache` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "metadata_cache" DROP COLUMN "etag",
ADD COLUMN     "lastModified" TEXT;
