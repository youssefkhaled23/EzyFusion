import { configDefaults, defineConfig } from "vitest/config";

// `npm test` runs the pure unit tests (billing, date, format). Database/RLS tests need the local Supabase stack and
// run with `npm run test:db` (see vitest.db.config.ts).
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "tests/db/**", "tests/api/**", "tests/ui/**"] },
});
