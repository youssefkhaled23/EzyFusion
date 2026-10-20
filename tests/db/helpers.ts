import pg from "pg";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* rely on the process environment */
}

export const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
export const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
export const SECRET = process.env.SUPABASE_SECRET_KEY!;
export const PASSWORD = process.env.SEED_PASSWORD!;
export const DB_URL = process.env.DATABASE_URL!;

export const TABLES = [
  "organizations",
  "memberships",
  "units",
  "tenants",
  "leases",
  "invoices",
  "payments",
  "payment_allocations",
  "gateway_bills",
  "audit_log",
] as const;
export type Table = (typeof TABLES)[number];

export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

export async function signIn(email: string): Promise<string> {
  const res = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE, "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = (await res.json()) as { access_token?: string };
  if (!res.ok || !body.access_token) throw new Error(`sign-in failed for ${email}: ${res.status} ${JSON.stringify(body)}`);
  return body.access_token;
}

/** Direct PostgREST request. token = user JWT, or undefined for the anonymous role (publishable key only). */
export async function rest(path: string, opts: { token?: string; secret?: boolean; method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { apikey: opts.secret ? SECRET : PUBLISHABLE, ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${URL_}/rest/v1/${path}`, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data: data as Record<string, unknown>[] & { code?: string; message?: string } };
}

export const rows = async (token: string | undefined, table: string, query = "select=*") => {
  const r = await rest(`${table}?${query}`, { token });
  if (r.status !== 200) throw new Error(`GET ${table} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};

export async function ownerClient() {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  return c;
}

/** Runs fn in a transaction that is always rolled back. */
export async function rolledBack<T>(c: pg.Client, fn: () => Promise<T>): Promise<T> {
  await c.query("begin");
  try {
    return await fn();
  } finally {
    await c.query("rollback");
  }
}

/** Executes a statement that must fail; returns the Postgres error (SQLSTATE in .code) and keeps the transaction usable. */
export async function pgError(c: pg.Client, sql: string, params: unknown[] = []): Promise<{ code?: string; message: string }> {
  await c.query("savepoint s");
  try {
    await c.query(sql, params);
  } catch (e) {
    await c.query("rollback to savepoint s");
    const err = e as { code?: string; message: string };
    return { code: err.code, message: err.message };
  }
  await c.query("rollback to savepoint s");
  throw new Error(`expected an error but the statement succeeded: ${sql}`);
}

export const storage = async (path: string, init: { token?: string; secret?: boolean; method?: string; body?: BodyInit; headers?: Record<string, string> } = {}) => {
  const headers: Record<string, string> = { apikey: init.secret ? SECRET : PUBLISHABLE, ...init.headers };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const res = await fetch(`${URL_}/storage/v1/${path}`, { method: init.method ?? "GET", headers, body: init.body });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: Record<string, unknown> | unknown[] | null = null;
  try {
    json = JSON.parse(buf.toString());
  } catch {
    /* binary */
  }
  return { status: res.status, json, buf };
};
