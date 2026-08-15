-- CreateTable
CREATE TABLE "device_accounts" (
    "deviceId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "pairedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_accounts_pkey" PRIMARY KEY ("deviceId","accountId")
);

-- CreateIndex
CREATE INDEX "device_accounts_accountId_idx" ON "device_accounts"("accountId");

-- AddForeignKey
ALTER TABLE "device_accounts" ADD CONSTRAINT "device_accounts_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_accounts" ADD CONSTRAINT "device_accounts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;