import { defineConfig } from "prisma/config";

// Prisma is used for server-side data access only. Schema changes live in supabase/migrations/*.sql.
try {
  process.loadEnvFile(".env.local");
} catch {
  /* rely on the process environment */
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  // DIRECT_URL: direct (non-pooled) connection for CLI commands; DATABASE_URL: runtime connection.
  datasource: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "" },
});
