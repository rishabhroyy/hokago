-- CreateEnum
CREATE TYPE "AnicliStatus" AS ENUM ('QUEUED','SEARCHING','DOWNLOADING','IMPORTING','DONE','FAILED','CANCELLED');

-- CreateTable
CREATE TABLE "anicli_downloads" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "libraryId" UUID NOT NULL,
    "query" TEXT NOT NULL,
    "title" TEXT,
    "episodeRange" TEXT,
    "dub" BOOLEAN NOT NULL DEFAULT false,
    "status" "AnicliStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" JSONB,
    "bytesWritten" BIGINT NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "anicli_downloads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "anicli_downloads_accountId_idx" ON "anicli_downloads"("accountId");
CREATE INDEX "anicli_downloads_libraryId_idx" ON "anicli_downloads"("libraryId");
CREATE INDEX "anicli_downloads_status_idx" ON "anicli_downloads"("status");

-- AddForeignKey
ALTER TABLE "anicli_downloads" ADD CONSTRAINT "anicli_downloads_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "anicli_downloads" ADD CONSTRAINT "anicli_downloads_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "libraries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
