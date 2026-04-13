-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Track" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "videoId" TEXT NOT NULL,
    "track" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "ytTitle" TEXT,
    "source" TEXT NOT NULL DEFAULT 'search',
    "checked" BOOLEAN NOT NULL DEFAULT false,
    "bugged" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Track" ("artist", "createdAt", "id", "source", "track", "updatedAt", "videoId", "ytTitle") SELECT "artist", "createdAt", "id", "source", "track", "updatedAt", "videoId", "ytTitle" FROM "Track";
DROP TABLE "Track";
ALTER TABLE "new_Track" RENAME TO "Track";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
