import { defineConfig } from '@playwright/test';

const url = 'http://127.0.0.1:4173/PopuConnect/';

export default defineConfig({
  testDir: './tests/browser',
  outputDir: '../../artifacts/web-browser-tests',
  use: { baseURL: url, channel: process.env.POPUCONNECT_TEST_BROWSER_CHANNEL },
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --base /PopuConnect/ --strictPort',
    url,
  },
});
