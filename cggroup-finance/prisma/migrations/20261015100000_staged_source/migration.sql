-- DropTable
DROP TABLE "StagedTotal";

-- CreateTable
CREATE TABLE "StagedSource" (
    "source" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "file" TEXT NOT NULL,
    "fxRate" DECIMAL(18,6),
    "totals" JSONB NOT NULL,
    "warnings" TEXT[],
    "stagedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StagedSource_pkey" PRIMARY KEY ("source")
);

