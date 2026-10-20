/**
 * Verifies prisma/schema.prisma against the live database (which is built only from supabase/migrations):
 * every public table/column exists in both directions with matching type + nullability, and every Prisma relation
 * is backed by a real foreign key on the same columns. Read-only; does not use Prisma Migrate or introspection.
 */
import { readFileSync } from "node:fs";
import pg from "pg";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* rely on the process environment */
}

type Field = { name: string; column: string; type: string; optional: boolean; db?: string; relationFields?: string[] };
type Model = { name: string; table: string; fields: Field[] };

const source = readFileSync("prisma/schema.prisma", "utf8");
const scalarModels = new Set([...source.matchAll(/^model (\w+)/gm)].map((m) => m[1]));
const models: Model[] = [];
for (const block of source.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
  const [, name, body] = block;
  const table = /@@map\("(\w+)"\)/.exec(body)?.[1] ?? name;
  const fields: Field[] = [];
  for (const line of body.split("\n")) {
    const m = /^\s+(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line.replace(/\/\/.*$/, ""));
    if (!m || line.trim().startsWith("@@")) continue;
    const [, fname, type, list, optional, rest] = m;
    if (list || scalarModels.has(type)) {
      const rel = /@relation\(fields:\s*\[([^\]]+)\]/.exec(rest);
      if (rel) fields.push({ name: fname, column: "", type: "relation", optional: false, relationFields: rel[1].split(",").map((s) => s.trim()) });
      continue;
    }
    fields.push({ name: fname, column: /@map\("(\w+)"\)/.exec(rest)?.[1] ?? fname, type, optional: !!optional, db: /@db\.(\w+)/.exec(rest)?.[0] });
  }
  models.push({ name, table, fields });
}

const pgType = (f: Field): string => {
  const byDb: Record<string, string> = { "@db.Uuid": "uuid", "@db.Date": "date", "@db.Timestamptz": "timestamp with time zone" };
  const dbKey = f.db && Object.keys(byDb).find((k) => f.db!.startsWith(k));
  if (dbKey) return byDb[dbKey];
  return { String: "text", BigInt: "bigint", Int: "integer", Json: "jsonb", Boolean: "boolean", DateTime: "timestamp without time zone" }[f.type] ?? f.type;
};

const client = new pg.Client({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL });
await client.connect();
const problems: string[] = [];

const cols = (await client.query(
  `select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public'`,
)).rows as { table_name: string; column_name: string; data_type: string; is_nullable: string }[];
const dbTables = new Set(cols.map((c) => c.table_name));
const modelTables = new Set(models.map((m) => m.table));
for (const t of dbTables) if (!modelTables.has(t)) problems.push(`table ${t} exists in the database but has no Prisma model`);
for (const t of modelTables) if (!dbTables.has(t)) problems.push(`Prisma model for ${t} has no table in the database`);

for (const m of models) {
  const dbCols = cols.filter((c) => c.table_name === m.table);
  for (const f of m.fields.filter((x) => x.type !== "relation")) {
    const c = dbCols.find((x) => x.column_name === f.column);
    if (!c) {
      problems.push(`${m.table}.${f.column}: in Prisma but not in the database`);
      continue;
    }
    if (c.data_type !== pgType(f)) problems.push(`${m.table}.${f.column}: type ${pgType(f)} in Prisma vs ${c.data_type} in the database`);
    if ((c.is_nullable === "YES") !== f.optional) problems.push(`${m.table}.${f.column}: nullability differs (prisma optional=${f.optional}, db nullable=${c.is_nullable})`);
  }
  for (const c of dbCols) if (!m.fields.some((f) => f.column === c.column_name)) problems.push(`${m.table}.${c.column_name}: in the database but not in Prisma`);
}

const fks = (await client.query(
  `select (select relname::text from pg_class where oid = c.conrelid) as tbl, array_agg(a.attname::text order by k.ord) as cols
   from pg_constraint c
   join lateral unnest(c.conkey) with ordinality k(attnum, ord) on true
   join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
   where c.contype = 'f' and c.connamespace = 'public'::regnamespace
   group by c.oid, c.conrelid`,
)).rows as { tbl: string; cols: string[] }[];
for (const m of models) {
  for (const rel of m.fields.filter((f) => f.type === "relation")) {
    const columns = rel.relationFields!.map((n) => m.fields.find((f) => f.name === n)!.column);
    const ok = fks.some((fk) => fk.tbl === m.table && JSON.stringify(fk.cols) === JSON.stringify(columns));
    if (!ok) problems.push(`${m.table}: Prisma relation on (${columns.join(", ")}) has no matching foreign key in the database`);
  }
}

await client.end();
if (problems.length) {
  console.error(`Prisma schema is NOT consistent with the database:\n - ${problems.join("\n - ")}`);
  process.exit(1);
}
const relationCount = models.reduce((n, m) => n + m.fields.filter((f) => f.type === "relation").length, 0);
console.log(`Prisma schema consistent with the database: ${models.length} models, ${cols.length} columns, ${relationCount} relations backed by foreign keys.`);
