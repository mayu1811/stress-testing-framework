#!/usr/bin/env node
// Cross-platform k6 launcher: loads .env, makes sure results/ exists, then
// runs `k6 run <script> [extra args]`. k6 reads the environment, so every
// variable in .env becomes available to the scripts as __ENV.X.
//
//   node scripts/run-k6.js k6/load-test.js
//   node scripts/run-k6.js k6/stress-test.js --out json=results/stress-raw.json
//
// Set K6_BIN if k6 is not on PATH.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./load-env');

const root = path.join(__dirname, '..');
const [script, ...extra] = process.argv.slice(2);
if (!script) {
  console.error('usage: node scripts/run-k6.js <k6-script> [k6 args...]');
  process.exit(2);
}

console.log(loadEnv() ? 'Loaded .env' : 'No .env found - using defaults / shell environment');

// k6's handleSummary cannot create directories, so create the results folder
// k6 will write to. Same rule as k6/config.js: RESULTS_DIR if set, else
// results/ for retail-mock and results/<profile>/ for other profiles.
// `-e KEY=VALUE` arguments override the environment, exactly as in k6.
const cli = {};
extra.forEach((arg, i) => {
  if ((arg === '-e' || arg === '--env') && extra[i + 1]) {
    const [k, ...v] = extra[i + 1].split('=');
    cli[k] = v.join('=');
  }
});
const setting = (k) => (cli[k] !== undefined && cli[k] !== '' ? cli[k] : process.env[k] || '');
const profile = setting('TARGET_PROFILE') || 'retail-mock';
const resultsDir = setting('RESULTS_DIR') || (profile === 'retail-mock' ? 'results' : `results/${profile}`);
fs.mkdirSync(path.join(root, resultsDir), { recursive: true });

const k6 = process.env.K6_BIN || 'k6';
const result = spawnSync(k6, ['run', script, ...extra], { cwd: root, stdio: 'inherit', env: process.env });
if (result.error) {
  console.error(`Could not start k6 (${result.error.message}). Install k6 or set K6_BIN. See README > Installation.`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
