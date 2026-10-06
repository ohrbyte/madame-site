// Browser tests for the static site. Run with `npm test` (builds dist/styles.css
// first — the Tailwind output carries the [hidden] rule the specs depend on).
// Browser: Playwright's Chromium (`npx playwright install chromium`), or an
// installed Google Chrome with PW_CHANNEL=chrome.
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PORT || 4791);

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mjs",
  outputDir: "test-results", // relative to this file → tests/test-results (gitignored)
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: process.env.PW_CHANNEL || undefined,
    trace: "retain-on-failure",
  },
  // The customer who found the sign-in dead end was on a phone; desktop rides
  // along because the panel's type scale (clamp/vw) differs between the two.
  projects: [
    { name: "mobile", use: { ...devices["Pixel 7"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "node static-server.mjs",
    url: `http://127.0.0.1:${PORT}/version.txt`,
    // Always our own server — never silently test whatever else holds the port.
    reuseExistingServer: false,
    env: { PORT: String(PORT) },
  },
});
