const { prisma } = require('../lib/db');
const fs = require('fs');
const path = require('path');

async function main() {
  const cacheFile = path.join(__dirname, '..', 'cache.json');
  if (!fs.existsSync(cacheFile)) {
    console.log('cache.json not found — nothing to migrate');
    await prisma.$disconnect();
    return;
  }

  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  let count = 0;

  for (const [id, val] of Object.entries(raw)) {
    const entry = typeof val === 'string' ? { videoId: val } : val;
    await prisma.track.upsert({
      where: { id },
      create: {
        id,
        videoId: entry.videoId,
        track: entry.track ?? '',
        artist: entry.artist ?? '',
        ytTitle: entry.ytTitle ?? null,
        source: entry.source ?? 'search',
      },
      update: {},
    });
    count++;
  }

  console.log(`Migrated ${count} tracks from cache.json`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
