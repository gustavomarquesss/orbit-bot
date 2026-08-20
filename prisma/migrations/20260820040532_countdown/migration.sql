-- CreateTable
CREATE TABLE "ScheduledCountdownEdit" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "markerTemplate" TEXT NOT NULL,
    "totalSeconds" INTEGER NOT NULL,
    "intervalSeconds" INTEGER NOT NULL,
    "deleteOnZero" BOOLEAN NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextTickAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ScheduledCountdownEdit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledCountdownEdit_nextTickAt_idx" ON "ScheduledCountdownEdit"("nextTickAt");
