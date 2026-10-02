// Optional browser-level journey test. Intentionally SMALL scale:
// a real browser costs ~100-300 MB RAM and noticeable CPU each, versus a few MB
// for a k6 virtual user. Browsers validate the experience; k6 generates load.
const { defineConfig } = require('@playwright/test');
require('../scripts/load-env').loadEnv();

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: true,
  // 2-3 concurrent browsers is plenty to validate the journey.
  workers: Number(process.env.BROWSER_WORKERS || 2),
  repeatEach: Number(process.env.BROWSER_REPEAT || 2),
  reporter: [['list'], ['json', { outputFile: '../results/browser-journey.json' }]],
  outputDir: './test-results',
  use: {
    baseURL: process.env.BROWSER_BASE_URL || process.env.TARGET_BASE_URL || 'http://localhost:8080',
    headless: true,
    trace: 'retain-on-failure',
    extraHTTPHeaders: { 'X-Load-Test': 'true' },
  },
});
