import { defineConfig } from 'vitest/config';

// Vitest covers the Electron/Node side. Angular specs (src/**/*.spec.ts) run in Karma.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
