-- AlterTable
ALTER TABLE "libraries" ADD COLUMN     "scanCursor" TEXT;

-- CreateTable
CREATE TABLE "job_failures" (
    "id" UUID NOT NULL,
    "mediaItemId" UUID NOT NULL,
    "jobType" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastFailedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_failures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_failures_mediaItemId_jobType_key" ON "job_failures"("mediaItemId", "jobType");

-- AddForeignKey
ALTER TABLE "job_failures" ADD CONSTRAINT "job_failures_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
