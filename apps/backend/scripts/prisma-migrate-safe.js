#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const BASELINE_MIGRATION = '20260416_baseline';
const PROJECT_ROOT = require('node:path').join(__dirname, '..');
const PRISMA_SCHEMA = 'prisma/schema.prisma';

function runPrisma(args) {
  return spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['prisma', ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  });
}

function printResult(result) {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

function exitWith(result) {
  printResult(result);
  process.exit(result.status ?? 1);
}

const deployResult = runPrisma(['migrate', 'deploy']);
if (deployResult.status === 0) {
  exitWith(deployResult);
}

const deployOutput = `${deployResult.stdout ?? ''}\n${deployResult.stderr ?? ''}`;
const isFailedBaseline =
  deployOutput.includes('Error: P3009') &&
  deployOutput.includes(`The \`${BASELINE_MIGRATION}\` migration`);

if (!isFailedBaseline) {
  exitWith(deployResult);
}

const diffResult = runPrisma([
  'migrate',
  'diff',
  '--from-schema-datasource',
  PRISMA_SCHEMA,
  '--to-schema-datamodel',
  PRISMA_SCHEMA,
  '--exit-code',
]);

if (diffResult.status !== 0) {
  printResult(deployResult);
  console.error(
    `\nRefusing to auto-resolve ${BASELINE_MIGRATION}: the current database schema still differs from prisma/schema.prisma.`,
  );
  printResult(diffResult);
  process.exit(deployResult.status ?? 1);
}

printResult(deployResult);
console.log(`\nDetected an already-compatible database for ${BASELINE_MIGRATION}; marking it as applied.`);

const resolveResult = runPrisma(['migrate', 'resolve', '--applied', BASELINE_MIGRATION]);
if (resolveResult.status !== 0) {
  exitWith(resolveResult);
}
printResult(resolveResult);

const retryResult = runPrisma(['migrate', 'deploy']);
exitWith(retryResult);
