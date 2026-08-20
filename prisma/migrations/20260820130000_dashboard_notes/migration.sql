-- CreateTable
CREATE TABLE "DashboardNote" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DashboardNote_pkey" PRIMARY KEY ("id")
);
