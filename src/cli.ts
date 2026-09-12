#!/usr/bin/env node
import { Command } from 'commander';
import { config as loadDotenv } from 'dotenv';
import { join } from 'node:path';
import { loadConfig } from './config/load.js';
import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { syncConfig } from './db/sync.js';
import { runChecks } from './doctor/checks.js';
import { exitCode, formatReport } from './doctor/report.js';
import { createLogger } from './lib/log.js';
import { resolvePaths } from './lib/paths.js';
import { runStage } from './lib/run-stage.js';

const paths = resolvePaths();
loadDotenv({ path: join(paths.root, '.env'), quiet: true });
const log = createLogger({ dir: paths.logs });

const program = new Command().name('lantern').description('Automated educational social content engine');

program
  .command('migrate')
  .description('Apply pending migrations and sync config/ into the database')
  .action(async () => {
    const db = openDb(paths.db);
    const { applied } = migrate(db, paths.migrations);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'migrations: up to date');
    const counts = await runStage(db, { stage: 'migrate' }, () => syncConfig(db, loadConfig(paths.root)));
    console.log(`verticals: ${JSON.stringify(counts.verticals)}`);
    console.log(`channels:  ${JSON.stringify(counts.channels)}`);
    log.info('migrate complete', { applied, counts });
  });

program
  .command('doctor')
  .description('Report system health; exits 1 if any check fails')
  .option('--json', 'emit JSON instead of a table')
  .action((opts: { json?: boolean }) => {
    const db = openDb(paths.db);
    const results = runChecks({
      db,
      root: paths.root,
      migrationsDir: paths.migrations,
      env: process.env,
      now: new Date(),
    });
    console.log(opts.json ? JSON.stringify(results, null, 2) : formatReport(results));
    log.info('doctor complete', { results });
    process.exitCode = exitCode(results);
  });

program.parseAsync().catch((err: unknown) => {
  log.error('command failed', { err });
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
