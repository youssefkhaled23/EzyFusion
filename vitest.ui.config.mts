import { defineConfig } from "vitest/config";

// Real-browser UI tests (Chrome via playwright-core) against the production server and the local Supabase stack.
export default defineConfig({
  test: {
    include: ["tests/ui/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
