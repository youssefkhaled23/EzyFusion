import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PNG, ownerClient, signIn, storage } from "./helpers";

// Private payment-slips bucket: only staff/managers of the path's organization may upload, list, read or sign.

let owner: pg.Client;
let nw: string;
let beta: string;
let seededSlip: string;
const tok: Record<string, string> = {};
const uploaded: string[] = [];

const upload = (path: string, token?: string) =>
  storage(`object/payment-slips/${path}`, { token, method: "POST", body: new Uint8Array(PNG), headers: { "content-type": "image/png" } });
const download = (path: string, token?: string) => storage(`object/authenticated/payment-slips/${path}`, { token });
const list = (prefix: string, token?: string) => storage("object/list/payment-slips", { token, method: "POST", body: JSON.stringify({ prefix, limit: 100 }), headers: { "content-type": "application/json" } });
const sign = (path: string, token?: string) => storage(`object/sign/payment-slips/${path}`, { token, method: "POST", body: JSON.stringify({ expiresIn: 60 }), headers: { "content-type": "application/json" } });
const names = (res: { json: unknown }) => (Array.isArray(res.json) ? (res.json as { name: string }[]).map((o) => o.name) : []);

beforeAll(async () => {
  owner = await ownerClient();
  const orgs = (await owner.query("select id, name from organizations")).rows as { id: string; name: string }[];
  nw = orgs.find((o) => o.name === "Northwind Properties")!.id;
  beta = orgs.find((o) => o.name === "Beta Realty")!.id;
  seededSlip = ((await owner.query("select slip_path from payments where slip_path is not null")).rows[0] as { slip_path: string }).slip_path;
  for (const email of ["manager@northwind.test", "staff@northwind.test", "aisyah@northwind.test", "manager@beta.test", "chen@beta.test"]) tok[email] = await signIn(email);
});

afterAll(async () => {
  await owner?.end();
  if (uploaded.length) await storage("object/payment-slips", { secret: true, method: "DELETE", body: JSON.stringify({ prefixes: uploaded }), headers: { "content-type": "application/json" } });
});

describe("bucket configuration", () => {
  it("payment-slips exists, is private, and has size/type limits", async () => {
    const b = (await owner.query("select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'payment-slips'")).rows[0];
    expect(b.public).toBe(false);
    expect(Number(b.file_size_limit)).toBeGreaterThan(0);
    expect(b.allowed_mime_types).toContain("application/pdf");
  });

  it("the seeded slip is a real object in the bucket under <org_id>/", async () => {
    expect(seededSlip.startsWith(`${nw}/`)).toBe(true);
    const o = await owner.query("select 1 from storage.objects where bucket_id = 'payment-slips' and name = $1", [seededSlip]);
    expect(o.rowCount).toBe(1);
  });

  it("only SELECT and INSERT policies exist for payment-slips (slips are immutable)", async () => {
    const p = (await owner.query("select cmd, roles::text from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'payment_slips_%' order by cmd")).rows;
    expect(p.map((x) => x.cmd)).toEqual(["INSERT", "SELECT"]);
    expect(p.every((x) => x.roles === "{authenticated}")).toBe(true);
  });

  it("public URLs never work", async () => {
    const r = await storage(`object/public/payment-slips/${seededSlip}`);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.buf.equals(PNG)).toBe(false);
  });
});

describe("upload", () => {
  it.each(["staff@northwind.test", "manager@northwind.test"])("%s can upload under their organization's prefix", async (who) => {
    const path = `${nw}/test-${randomUUID()}.png`;
    const r = await upload(path, tok[who]);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    uploaded.push(path);
  });

  it("tenants cannot upload (not even for their own organization)", async () => {
    expect((await upload(`${nw}/tenant-${randomUUID()}.png`, tok["aisyah@northwind.test"])).status).toBeGreaterThanOrEqual(400);
    expect((await upload(`${beta}/tenant-${randomUUID()}.png`, tok["chen@beta.test"])).status).toBeGreaterThanOrEqual(400);
  });

  it("anonymous users cannot upload", async () => {
    expect((await upload(`${nw}/anon-${randomUUID()}.png`)).status).toBeGreaterThanOrEqual(400);
  });

  it("staff and managers cannot upload into another organization's prefix", async () => {
    expect((await upload(`${beta}/x-${randomUUID()}.png`, tok["staff@northwind.test"])).status).toBeGreaterThanOrEqual(400);
    expect((await upload(`${beta}/x-${randomUUID()}.png`, tok["manager@northwind.test"])).status).toBeGreaterThanOrEqual(400);
    expect((await upload(`${nw}/x-${randomUUID()}.png`, tok["manager@beta.test"])).status).toBeGreaterThanOrEqual(400);
  });

  it("paths must start with <org_id>/: other first segments are rejected", async () => {
    for (const path of [`not-a-uuid/x-${randomUUID()}.png`, `x-${randomUUID()}.png`, `${randomUUID()}/x.png`, `${nw.toUpperCase()}x/${randomUUID()}.png`]) {
      expect((await upload(path, tok["manager@northwind.test"])).status, path).toBeGreaterThanOrEqual(400);
    }
  });

  it("existing slips cannot be overwritten or deleted through the API (no UPDATE/DELETE policy)", async () => {
    const overwrite = await storage(`object/payment-slips/${seededSlip}`, { token: tok["manager@northwind.test"], method: "PUT", body: new Uint8Array(PNG), headers: { "content-type": "image/png" } });
    expect(overwrite.status).toBeGreaterThanOrEqual(400);
    const del = await storage("object/payment-slips", { token: tok["manager@northwind.test"], method: "DELETE", body: JSON.stringify({ prefixes: [seededSlip] }), headers: { "content-type": "application/json" } });
    expect(Array.isArray(del.json) ? del.json : []).toEqual([]);
    expect((await owner.query("select 1 from storage.objects where bucket_id = 'payment-slips' and name = $1", [seededSlip])).rowCount).toBe(1);
  });
});

describe("read, list and signed URLs", () => {
  it.each(["staff@northwind.test", "manager@northwind.test"])("%s can download, list and sign the seeded slip", async (who) => {
    const d = await download(seededSlip, tok[who]);
    expect(d.status).toBe(200);
    expect(d.buf.equals(PNG)).toBe(true);
    expect(names(await list(`${nw}/`, tok[who]))).toContain(seededSlip.slice(nw.length + 1));
    const s = await sign(seededSlip, tok[who]);
    expect(s.status).toBe(200);
    const signedUrl = (s.json as { signedURL: string }).signedURL;
    const viaUrl = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1${signedUrl}`); // no credentials
    expect(viaUrl.status).toBe(200);
    expect(Buffer.from(await viaUrl.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("tenants cannot read, list or sign slips (including slips of their own payments)", async () => {
    const t = tok["aisyah@northwind.test"];
    expect((await download(seededSlip, t)).status).toBeGreaterThanOrEqual(400);
    expect(names(await list(`${nw}/`, t))).toEqual([]);
    expect((await sign(seededSlip, t)).status).toBeGreaterThanOrEqual(400);
    const chen = tok["chen@beta.test"];
    expect((await download(seededSlip, chen)).status).toBeGreaterThanOrEqual(400);
    expect(names(await list(`${beta}/`, chen))).toEqual([]);
  });

  it("anonymous users cannot read, list or sign", async () => {
    expect((await download(seededSlip)).status).toBeGreaterThanOrEqual(400);
    expect(names(await list(`${nw}/`))).toEqual([]);
    expect((await sign(seededSlip)).status).toBeGreaterThanOrEqual(400);
  });

  it("another organization's staff cannot read, list or sign Northwind slips", async () => {
    const b = tok["manager@beta.test"];
    expect((await download(seededSlip, b)).status).toBeGreaterThanOrEqual(400);
    expect(names(await list(`${nw}/`, b))).toEqual([]);
    expect((await sign(seededSlip, b)).status).toBeGreaterThanOrEqual(400);
  });

  it("Northwind staff cannot read, list or sign objects under another organization's prefix", async () => {
    const path = `${beta}/beta-${randomUUID()}.png`;
    const up = await storage(`object/payment-slips/${path}`, { secret: true, method: "POST", body: new Uint8Array(PNG), headers: { "content-type": "image/png" } });
    expect(up.status).toBe(200);
    uploaded.push(path);
    const s = tok["staff@northwind.test"];
    expect((await download(path, s)).status).toBeGreaterThanOrEqual(400);
    expect(names(await list(`${beta}/`, s))).toEqual([]);
    expect((await sign(path, s)).status).toBeGreaterThanOrEqual(400);
    expect((await download(path, tok["manager@beta.test"])).status).toBe(200); // positive control
  });
});
