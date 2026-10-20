import { defineConfig } from "vitest/config";

// Integration tests against the running local Supabase stack (npx supabase start; npx supabase db reset; npm run seed).
export default defineConfig({
  test: {
    include: ["tests/db/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
