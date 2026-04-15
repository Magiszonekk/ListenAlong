#!/usr/bin/env node
// db-cleanup.js — usuwa stare wpisy z tabel Play, UserEvent, AuthEvent i wygasłe URL-e z UrlCache.
// Użycie:
//   node scripts/db-cleanup.js            # domyślnie usuwa rekordy starsze niż 30 dni
//   node scripts/db-cleanup.js --days=7   # starsze niż 7 dni
//   node scripts/db-cleanup.js --dry-run  # tylko pokaż co by zostało usunięte

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const days = parseInt(args.days ?? 30, 10);
if (isNaN(days) || days < 1) {
  console.error('--days musi być liczbą >= 1');
  process.exit(1);
}

const dryRun = args['dry-run'] === true || args['dry-run'] === 'true';
const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

console.log(`Czystka DB — rekordy starsze niż ${days} dni (przed ${cutoff.toISOString()})${dryRun ? ' [DRY RUN]' : ''}`);

async function run() {
  const [playCount, eventCount, authCount, urlCount] = await Promise.all([
    prisma.play.count({ where: { playedAt: { lt: cutoff } } }),
    prisma.userEvent.count({ where: { createdAt: { lt: cutoff } } }),
    prisma.authEvent.count({ where: { createdAt: { lt: cutoff } } }),
    prisma.urlCache.count({ where: { expiresAt: { lt: new Date() } } }),
  ]);

  console.log(`Do usunięcia:`);
  console.log(`  Play:       ${playCount}`);
  console.log(`  UserEvent:  ${eventCount}`);
  console.log(`  AuthEvent:  ${authCount}`);
  console.log(`  UrlCache:   ${urlCount} (wygasłe)`);

  if (dryRun) {
    console.log('\nDry run — nic nie usunięto.');
    return;
  }

  const [p, e, a, u] = await Promise.all([
    prisma.play.deleteMany({ where: { playedAt: { lt: cutoff } } }),
    prisma.userEvent.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.authEvent.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.urlCache.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
  ]);

  console.log(`\nUsunięto:`);
  console.log(`  Play:       ${p.count}`);
  console.log(`  UserEvent:  ${e.count}`);
  console.log(`  AuthEvent:  ${a.count}`);
  console.log(`  UrlCache:   ${u.count}`);
}

run()
  .catch(err => { console.error('Błąd:', err.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
