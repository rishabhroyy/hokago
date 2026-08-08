-- AlterTable
ALTER TABLE "playback_state" ADD COLUMN     "lastWatchedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "watch_day" (
    "id" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "mediaItemId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "watchedMs" INTEGER NOT NULL DEFAULT 0,
    "firstStartedAt" TIMESTAMP(3),
    "lastEndedAt" TIMESTAMP(3),
    "completions" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "watch_day_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "watch_day_profileId_date_idx" ON "watch_day"("profileId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "watch_day_profileId_mediaItemId_date_key" ON "watch_day"("profileId", "mediaItemId", "date");

-- AddForeignKey
ALTER TABLE "watch_day" ADD CONSTRAINT "watch_day_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watch_day" ADD CONSTRAINT "watch_day_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
