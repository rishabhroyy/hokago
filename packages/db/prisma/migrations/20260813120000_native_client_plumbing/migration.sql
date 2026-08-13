-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('WEB', 'IOS', 'IPADOS', 'ANDROID', 'MACOS', 'WINDOWS', 'LINUX', 'TVOS', 'ANDROIDTV', 'GOOGLETV');

-- CreateEnum
CREATE TYPE "PairingStatus" AS ENUM ('PENDING', 'APPROVED', 'COMPLETE', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DownloadStatus" AS ENUM ('QUEUED', 'PROCESSING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "deviceId" UUID;

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "clientKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pairing_codes" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "status" "PairingStatus" NOT NULL DEFAULT 'PENDING',
    "deviceName" TEXT NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "clientKey" TEXT,
    "accountId" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "pairing_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "downloads" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "mediaItemId" UUID NOT NULL,
    "mediaFileId" UUID NOT NULL,
    "variant" TEXT NOT NULL,
    "targetHeight" INTEGER,
    "targetBitrateKbps" INTEGER,
    "subtitleTrackIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "DownloadStatus" NOT NULL DEFAULT 'QUEUED',
    "artifactPath" TEXT,
    "sizeBytes" BIGINT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "downloads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "devices_clientKey_key" ON "devices"("clientKey");

-- CreateIndex
CREATE INDEX "devices_accountId_idx" ON "devices"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pairing_codes_code_key" ON "pairing_codes"("code");

-- CreateIndex
CREATE INDEX "pairing_codes_status_idx" ON "pairing_codes"("status");

-- CreateIndex
CREATE INDEX "downloads_accountId_idx" ON "downloads"("accountId");

-- CreateIndex
CREATE INDEX "downloads_deviceId_idx" ON "downloads"("deviceId");

-- CreateIndex
CREATE INDEX "sessions_deviceId_idx" ON "sessions"("deviceId");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "downloads" ADD CONSTRAINT "downloads_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "downloads" ADD CONSTRAINT "downloads_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "downloads" ADD CONSTRAINT "downloads_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "downloads" ADD CONSTRAINT "downloads_mediaFileId_fkey" FOREIGN KEY ("mediaFileId") REFERENCES "media_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

