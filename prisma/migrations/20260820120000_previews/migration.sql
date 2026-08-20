-- Prévias que somem (Fase 2, Milestone 9).

CREATE TABLE "PreviewConfig" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "buttonLabel" TEXT,
    "deleteAfterSeconds" INTEGER NOT NULL DEFAULT 15,
    "protectContent" BOOLEAN NOT NULL DEFAULT true,
    "caption" TEXT,
    "expiredMessage" TEXT,
    "expiredShowPlansButton" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PreviewConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PreviewConfig_flowId_key" ON "PreviewConfig"("flowId");

ALTER TABLE "PreviewConfig" ADD CONSTRAINT "PreviewConfig_flowId_fkey"
    FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PreviewMedia" (
    "id" TEXT NOT NULL,
    "previewConfigId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "mediaType" "MediaType" NOT NULL,
    "fileId" TEXT NOT NULL,

    CONSTRAINT "PreviewMedia_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PreviewMedia_previewConfigId_order_key" ON "PreviewMedia"("previewConfigId", "order");

ALTER TABLE "PreviewMedia" ADD CONSTRAINT "PreviewMedia_previewConfigId_fkey"
    FOREIGN KEY ("previewConfigId") REFERENCES "PreviewConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PreviewView" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PreviewView_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PreviewView_flowId_leadId_key" ON "PreviewView"("flowId", "leadId");

ALTER TABLE "PreviewView" ADD CONSTRAINT "PreviewView_flowId_fkey"
    FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ScheduledPreviewCleanup" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "messageIds" INTEGER[],
    "expiredMessage" TEXT,
    "expiredShowPlansButton" BOOLEAN NOT NULL DEFAULT true,
    "deleteAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ScheduledPreviewCleanup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ScheduledPreviewCleanup_deleteAt_idx" ON "ScheduledPreviewCleanup"("deleteAt");
