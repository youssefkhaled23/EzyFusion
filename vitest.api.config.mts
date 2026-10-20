import { defineConfig } from "vitest/config";

// Real HTTP tests against the production server (`npm run build && npm start -- -p 3300`) and the local Supabase stack.
export default defineConfig({
  test: {
    include: ["tests/api/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
