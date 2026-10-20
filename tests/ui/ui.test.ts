import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatInstantMy, formatMonthMy, formatRM, lastMalaysiaMonths } from "../../src/lib/format-my";
import { malaysiaDate } from "../../src/lib/malaysia";
import { PNG } from "../db/helpers";
import { BASE, type Account, type Ctx, api, freshUnit, setup, teardown } from "../api/helpers";

const run = promisify(execFile);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSWORD = process.env.SEED_PASSWORD!;

let browser: Browser;
let ctx: Ctx;
const consoleProblems: string[] = [];
const secretNeedles: string[] = [];
const contexts: BrowserContext[] = [];

beforeAll(async () => {
  ctx = await setup();
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  secretNeedles.push(process.env.SUPABASE_SECRET_KEY!, process.env.GATEWAY_X_SIGNATURE_KEY!, ["postgres", "postgres@"].join(":"));
});
afterAll(async () => {
  for (const c of contexts) await c.close().catch(() => undefined);
  await browser?.close();
  await teardown(ctx);
});

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const q = async (sql: string, params: unknown[] = []) => (await ctx.db.query(sql, params)).rows;

/** A lease with invoices already due (starts 40 days ago), on a brand-new unit. */
async function uiLease(tenant: Account = "ben@northwind.test", o: { rent?: number; deposit?: number } = {}) {
  const start = addDays(malaysiaDate(new Date()), -40);
  const body = { unitId: await freshUnit(ctx), tenantId: ctx.tenant[tenant], startDate: start, endDate: addDays(start, 400), monthlyRentSen: o.rent ?? 100000, depositSen: o.deposit ?? 50000 };
  const r = await api("/api/leases", { token: ctx.tok["manager@northwind.test"], body });
  if (r.status !== 201) throw new Error(`lease ${r.status} ${r.text}`);
  ctx.created.leases.push(r.data.id);
  return { id: r.data.id as string, unitId: body.unitId };
}

async function newPage(opts: { timezoneId?: string } = {}) {
  const context = await browser.newContext({ timezoneId: opts.timezoneId ?? "UTC", locale: "en-US", viewport: { width: 1280, height: 900 } });
  contexts.push(context);
  const page = await context.newPage();
  page.on("console", (m) => {
    const text = m.text();
    // deliberate failures (401/403/404/409/422 from the API) are logged by the browser as resource errors
    if ((m.type() === "error" || m.type() === "warning") && !/Failed to load resource/i.test(text)) consoleProblems.push(`[${m.type()}] ${text}`);
  });
  page.on("pageerror", (e) => consoleProblems.push(`[pageerror] ${e.message}`));
  page.on("request", (r) => {
    for (const needle of secretNeedles) if (needle && (r.url().includes(needle) || (r.postData() ?? "").includes(needle) || JSON.stringify(r.headers()).includes(needle))) consoleProblems.push(`[secret in request] ${r.url()}`);
  });
  return { context, page };
}

async function login(page: Page, email: string, expectUrl: RegExp) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(expectUrl, { timeout: 30_000 });
}
const loginStaff = (page: Page, who: string) => login(page, who, /\/dashboard$/);
const loginTenant = (page: Page, who: string) => login(page, who, /\/portal$/);

async function toast(page: Page, text: RegExp | string) {
  await page.locator("[data-sonner-toast]").filter({ hasText: text }).first().waitFor({ timeout: 15_000 });
}
const rowFor = (page: Page, paymentId: string) => page.locator(`[data-testid=payment-row][data-payment-id="${paymentId}"]`);

async function pickMethod(page: Page, label: "Cash" | "Bank transfer") {
  await page.locator("#pay-method").click();
  await page.getByRole("option", { name: label }).click();
}
async function fillPayment(page: Page, amount: string, receivedAt?: string) {
  await page.locator("#pay-amount").fill(amount);
  if (receivedAt) await page.locator("#pay-received").fill(receivedAt);
}
const submitPayment = (page: Page) => page.getByTestId("record-payment").click();

describe("authentication and navigation", () => {
  it("rejects invalid credentials with a clear error and stays on /login", async () => {
    const { page } = await newPage();
    await page.goto(`${BASE}/login`);
    await page.getByLabel("Email").fill("manager@northwind.test");
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByText("Invalid email or password.").first().waitFor();
    expect(new URL(page.url()).pathname).toBe("/login");
    await page.getByLabel("Email").fill("");
    await page.getByLabel("Password").fill("");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByText("Enter your email and password.").waitFor();
  });

  it("protects pages: anonymous visitors are sent to /login", async () => {
    const { page } = await newPage();
    const lease = ctx.leaseOf["aisyah@northwind.test"];
    for (const path of ["/dashboard", "/leases", `/leases/${lease}`, "/portal", `/portal/leases/${lease}`]) {
      await page.goto(`${BASE}${path}`);
      await page.waitForURL(/\/login$/, { timeout: 15_000 });
    }
    await page.goto(`${BASE}/`);
    await page.waitForURL(/\/login$/);
  });

  it("each role lands in its own portal with role-aware navigation, and logout ends the session", async () => {
    const m = await newPage();
    await loginStaff(m.page, "manager@northwind.test");
    expect(await m.page.getByTestId("account-role").first().textContent()).toBe("Manager");
    expect(await m.page.getByTestId("account-email").first().textContent()).toBe("manager@northwind.test");
    await m.page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Leases" }).waitFor();
    expect(await m.page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "My leases" }).count()).toBe(0);

    const s = await newPage();
    await loginStaff(s.page, "staff@northwind.test");
    expect(await s.page.getByTestId("account-role").first().textContent()).toBe("Staff");

    const t = await newPage();
    await loginTenant(t.page, "ben@northwind.test");
    expect(await t.page.getByTestId("account-role").first().textContent()).toBe("Tenant");
    expect(await t.page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Dashboard" }).count()).toBe(0);

    // a signed-in user visiting /login goes straight to their portal
    await t.page.goto(`${BASE}/login`);
    await t.page.waitForURL(/\/portal$/);

    // logout clears the session: protected pages redirect again and cookies are gone
    await t.page.getByRole("button", { name: "Log out" }).click();
    await t.page.waitForURL(/\/login$/);
    await toast(t.page, "Signed out");
    expect((await t.context.cookies()).filter((c) => c.name.startsWith("sb-") && c.value).length).toBe(0);
    await t.page.goto(`${BASE}/portal`);
    await t.page.waitForURL(/\/login$/);
  });

  it("cross-role and cross-tenant navigation is blocked", async () => {
    const lease = await uiLease("ben@northwind.test");
    const aisyahLease = ctx.leaseOf["aisyah@northwind.test"];
    const betaLease = ctx.leaseOf["chen@beta.test"];

    const ben = await newPage();
    await loginTenant(ben.page, "ben@northwind.test");
    await ben.page.goto(`${BASE}/dashboard`);
    await ben.page.waitForURL(/\/portal$/);
    await ben.page.goto(`${BASE}/leases/${lease.id}`); // the staff page for his own lease
    await ben.page.waitForURL(/\/portal$/);
    for (const id of [aisyahLease, betaLease]) {
      await ben.page.goto(`${BASE}/portal/leases/${id}`);
      await ben.page.getByText("This page could not be found").waitFor();
      expect(await ben.page.content()).not.toContain("Aisyah");
    }
    await ben.page.goto(`${BASE}/portal/leases/${lease.id}`);
    await ben.page.getByTestId("pay-now").waitFor();

    const mgr = await newPage();
    await loginStaff(mgr.page, "manager@northwind.test");
    await mgr.page.goto(`${BASE}/portal`);
    await mgr.page.waitForURL(/\/dashboard$/);
    await mgr.page.goto(`${BASE}/leases/${betaLease}`); // another organization's lease
    await mgr.page.getByText("This page could not be found").waitFor();
    await mgr.page.goto(`${BASE}/portal/leases/${lease.id}`); // organization users have no tenant portal
    await mgr.page.waitForURL(/\/dashboard$/);

    const beta = await newPage();
    await loginStaff(beta.page, "manager@beta.test");
    await beta.page.goto(`${BASE}/leases/${aisyahLease}`);
    await beta.page.getByText("This page could not be found").waitFor();
    await beta.page.goto(`${BASE}/leases`);
    expect(await beta.page.locator("[data-testid=lease-row]").count()).toBe(1); // Beta sees only its own lease
    expect(await beta.page.content()).not.toContain("A-12-3");

    const chen = await newPage();
    await loginTenant(chen.page, "chen@beta.test");
    await chen.page.goto(`${BASE}/portal/leases/${lease.id}`);
    await chen.page.getByText("This page could not be found").waitFor();
  });
});

describe("manager dashboard and lease pages", () => {
  it("shows the overdue invoice count, six Malaysia months of collections (zeros included) and organization-scoped leases", async () => {
    const lease = await uiLease("ben@northwind.test");
    expect((await api(`/api/leases/${lease.id}/payments`, { token: ctx.tok["manager@northwind.test"], body: { amountSen: 12345, method: "cash", receivedAt: new Date().toISOString().replace("Z", "+00:00") } })).status).toBe(201);
    const { page } = await newPage();
    await loginStaff(page, "manager@northwind.test");

    const today = malaysiaDate(new Date());
    const overdue = (await q(
      "select count(*)::int n from invoices i where i.org_id = $1 and i.due_date < $2 and i.amount_sen > (select coalesce(sum(amount_sen), 0) from payment_allocations where invoice_id = i.id)",
      [ctx.nw, today],
    ))[0].n;
    expect(Number(await page.getByTestId("overdue-count").textContent())).toBe(overdue);
    expect(overdue).toBeGreaterThan(0);

    const months = lastMalaysiaMonths(new Date(), 6);
    const rows = page.getByTestId("collections-row");
    expect(await rows.count()).toBe(6);
    for (let i = 0; i < 6; i++) {
      const month = months[i];
      const expected = Number((await q("select coalesce(sum(amount_sen), 0)::text s from payments where org_id = $1 and status = 'approved' and to_char(received_at at time zone 'Asia/Kuala_Lumpur', 'YYYY-MM') = $2", [ctx.nw, month]))[0].s);
      const row = rows.nth(i);
      expect(await row.getAttribute("data-month")).toBe(month);
      expect(await row.textContent()).toContain(formatMonthMy(month));
      expect(await row.textContent()).toContain(formatRM(expected));
    }
    expect(await page.getByTestId("collections-table").textContent()).toContain(formatRM(0)); // a zero month is listed

    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Leases" }).click();
    await page.waitForURL(/\/leases$/);
    const leaseRows = page.getByTestId("lease-row");
    await leaseRows.first().waitFor();
    const dbCount = (await q("select count(*)::int n from leases where org_id = $1", [ctx.nw]))[0].n;
    expect(await leaseRows.count()).toBe(dbCount);
    expect(await page.content()).not.toContain("KL-1"); // the other organization's unit
    await page.getByTestId("lease-link").first().click();
    await page.waitForURL(/\/leases\/[0-9a-f-]{36}$/);
  });

  it("lease detail: invoice and payment tables with the required columns, Malaysia times and status badges", async () => {
    const { page } = await newPage();
    await loginStaff(page, "manager@northwind.test");
    await page.goto(`${BASE}/leases/${ctx.leaseOf["aisyah@northwind.test"]}`);
    const invHeads = (await page.getByTestId("invoice-table").locator("thead th").allTextContents()).map((t) => t.trim());
    expect(invHeads).toEqual(["Period", "Due date", "Amount", "Paid", "Status"]);
    const invRows = page.getByTestId("invoice-row");
    expect(await invRows.count()).toBe(7);
    const first = (await invRows.nth(0).textContent())!;
    expect(first).toContain("Deposit");
    expect(first).toContain("31 Jan 2026");
    expect(first).toContain("RM 3,000.00");
    expect(first).toContain("Paid");
    const last = (await invRows.nth(6).textContent())!;
    expect(last).toContain("30 Jun 2026 – 15 Jul 2026");
    expect(last).toContain("RM 774.19");
    expect(await invRows.nth(2).getAttribute("data-status")).toMatch(/overdue|partially_paid/);

    const payHeads = (await page.getByTestId("payment-table").locator("thead th").allTextContents()).map((t) => t.trim());
    expect(payHeads.slice(0, 5)).toEqual(["Method", "Amount", "Received (Malaysia time)", "Status", "Slip"]);
    const pays = page.getByTestId("payment-row");
    expect(await pays.count()).toBe(2);
    expect(await pays.nth(0).textContent()).toContain("31 Jan 2026, 10:00 MYT");
    expect(await pays.nth(1).textContent()).toContain("1 Mar 2026, 00:30 MYT");
    expect(await pays.nth(1).textContent()).toContain("Bank transfer");
    await pays.nth(1).getByTestId("slip-link").waitFor(); // the bank transfer has a slip link; the cash payment does not
    expect(await pays.nth(0).getByTestId("slip-link").count()).toBe(0);
    const [popup] = await Promise.all([page.waitForEvent("popup"), pays.nth(1).getByTestId("slip-link").click()]);
    await popup.waitForLoadState("domcontentloaded").catch(() => undefined);
    expect(popup.url()).toMatch(/\/storage\/v1\/object\/sign\/payment-slips\//);
    await popup.close();
  });
});

describe("manual payment form, staff pending and manager actions", () => {
  it("staff record a payment (RM input, Malaysia time) that stays pending_verification; staff see no manager actions", async () => {
    const lease = await uiLease();
    const { page } = await newPage({ timezoneId: "America/Los_Angeles" });
    await loginStaff(page, "staff@northwind.test");
    await page.goto(`${BASE}/leases/${lease.id}`);
    await page.getByTestId("payment-form").waitFor();

    // validation: amount and time errors are specific and nothing is created
    for (const bad of ["", "abc", "1.234", "-5", "1,23", "RM 10", "0"]) {
      await fillPayment(page, bad);
      await submitPayment(page);
      await page.locator("#pay-amount-error").waitFor();
    }
    expect((await q("select count(*)::int n from payments where lease_id = $1", [lease.id]))[0].n).toBe(0);

    // the default "received" time is NOW IN MALAYSIA even though the browser is in Los Angeles
    const defaultValue = await page.locator("#pay-received").inputValue();
    const asIso = new Date(`${defaultValue}:00+08:00`).getTime();
    expect(Math.abs(asIso - Date.now())).toBeLessThan(120_000);

    await fillPayment(page, "1,000.50", "2026-05-05T09:30");
    await submitPayment(page);
    await toast(page, /recorded, pending verification/);
    const row = page.getByTestId("payment-row").first();
    await row.waitFor();
    expect(await row.getAttribute("data-status")).toBe("pending_verification");
    expect(await row.textContent()).toContain("RM 1,000.50");
    expect(await row.textContent()).toContain("5 May 2026, 09:30 MYT");
    const db = (await q("select status, amount_sen::text, received_at from payments where lease_id = $1", [lease.id]))[0];
    expect(db.status).toBe("pending_verification");
    expect(db.amount_sen).toBe("100050");
    expect(new Date(db.received_at).toISOString()).toBe("2026-05-05T01:30:00.000Z"); // 09:30 +08:00 even though the browser is in Los Angeles
    expect(await page.getByTestId("approve-payment").count()).toBe(0);
    expect(await page.getByTestId("reject-payment").count()).toBe(0);
    expect(await page.getByTestId("void-payment").count()).toBe(0);
    expect(await page.getByTestId("lease-role").textContent()).toBe("staff");
  });

  it("manager-recorded payments are approved immediately and the invoices update", async () => {
    const lease = await uiLease();
    const { page } = await newPage();
    await loginStaff(page, "manager@northwind.test");
    await page.goto(`${BASE}/leases/${lease.id}`);
    await fillPayment(page, "500.00");
    await submitPayment(page);
    await toast(page, /recorded and approved/);
    const row = page.getByTestId("payment-row").first();
    await row.waitFor();
    expect(await row.getAttribute("data-status")).toBe("approved");
    expect(await page.getByTestId("invoice-row").first().textContent()).toContain("RM 500.00"); // deposit (RM 500) is now paid
    expect(await page.getByTestId("invoice-row").first().getAttribute("data-status")).toBe("paid");
  });

  it("bank transfer slips: required, type- and size-checked, uploaded privately under the organization folder, viewable by staff", async () => {
    const lease = await uiLease();
    const { page } = await newPage();
    await loginStaff(page, "staff@northwind.test");
    await page.goto(`${BASE}/leases/${lease.id}`);
    await pickMethod(page, "Bank transfer");
    await fillPayment(page, "200");
    await submitPayment(page);
    await page.getByText("Attach the bank transfer slip").waitFor();
    await page.setInputFiles("#pay-slip", { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    await submitPayment(page);
    await page.getByText("The slip must be a JPEG, PNG or PDF file.").waitFor();
    await page.setInputFiles("#pay-slip", { name: "big.png", mimeType: "image/png", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
    await submitPayment(page);
    await page.getByText("The slip must be 5 MB or smaller.").waitFor();
    expect((await q("select count(*)::int n from payments where lease_id = $1", [lease.id]))[0].n).toBe(0);

    await page.setInputFiles("#pay-slip", { name: "slip.png", mimeType: "image/png", buffer: PNG });
    await submitPayment(page);
    await toast(page, /pending verification/);
    const db = (await q("select slip_path, method from payments where lease_id = $1", [lease.id]))[0];
    expect(db.method).toBe("bank_transfer");
    expect(db.slip_path.startsWith(`${ctx.nw}/`)).toBe(true);
    ctx.created.slips.push(db.slip_path);
    expect((await q("select count(*)::int n from storage.objects where bucket_id = 'payment-slips' and name = $1", [db.slip_path]))[0].n).toBe(1);
    await page.getByTestId("slip-link").first().waitFor();
  });

  it("removes an uploaded slip when recording fails, but never a slip another payment references", async () => {
    const lease = await uiLease("ben@northwind.test", { rent: 10000, deposit: 0 }); // small balance: a large payment is over the cap
    const { page } = await newPage();
    await loginStaff(page, "staff@northwind.test");
    await page.goto(`${BASE}/leases/${lease.id}`);
    const before = (await q("select count(*)::int n from storage.objects where bucket_id = 'payment-slips'"))[0].n;
    await pickMethod(page, "Bank transfer");
    await fillPayment(page, "999,999.00");
    await page.setInputFiles("#pay-slip", { name: "slip.png", mimeType: "image/png", buffer: PNG });
    await submitPayment(page);
    await toast(page, /more than the lease can accept|maximum payable|exceeds/i);
    await page.waitForTimeout(1500);
    expect((await q("select count(*)::int n from storage.objects where bucket_id = 'payment-slips'"))[0].n).toBe(before); // orphan removed
    expect((await q("select count(*)::int n from payments where lease_id = $1", [lease.id]))[0].n).toBe(0);
    const seededSlip = (await q("select slip_path from payments where slip_path is not null limit 1"))[0].slip_path;
    expect((await q("select count(*)::int n from storage.objects where bucket_id = 'payment-slips' and name = $1", [seededSlip]))[0].n).toBe(1); // referenced slips stay
  });

  it("manager approves, rejects (reason of 5+ characters) and voids (with confirmation); data refreshes after each action", async () => {
    const lease = await uiLease("ben@northwind.test", { rent: 100000, deposit: 50000 });
    const staffToken = ctx.tok["staff@northwind.test"];
    const mk = async (amountSen: number) => (await api(`/api/leases/${lease.id}/payments`, { token: staffToken, body: { amountSen, method: "cash", receivedAt: "2026-05-05T10:00:00+08:00" } })).data.id as string;
    const toApprove = await mk(50000);
    const toReject = await mk(10000);

    const { page } = await newPage();
    await loginStaff(page, "manager@northwind.test");
    await page.goto(`${BASE}/leases/${lease.id}`);

    // approve
    await rowFor(page, toApprove).getByTestId("approve-payment").click();
    await toast(page, /approved/);
    await page.waitForFunction((id) => document.querySelector(`[data-payment-id="${id}"]`)?.getAttribute("data-status") === "approved", toApprove);
    expect(await page.getByTestId("invoice-row").first().getAttribute("data-status")).toBe("paid"); // deposit 50000 settled
    expect(await rowFor(page, toApprove).getByTestId("approve-payment").count()).toBe(0);

    // reject: needs a reason
    await rowFor(page, toReject).getByTestId("reject-payment").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("reason-confirm").click();
    await dialog.getByText("Enter a reason of at least 5 characters.").waitFor();
    await dialog.getByLabel(/Reason/).fill("abcd");
    await dialog.getByTestId("reason-confirm").click();
    await dialog.getByText("Enter a reason of at least 5 characters.").waitFor();
    await dialog.getByLabel(/Reason/).fill("amount does not match the slip");
    await dialog.getByTestId("reason-confirm").click();
    await toast(page, /rejected/);
    await page.waitForFunction((id) => document.querySelector(`[data-payment-id="${id}"]`)?.getAttribute("data-status") === "rejected", toReject);
    expect((await q("select details->>'reason' r from audit_log where entity_id = $1 and action = 'payment.rejected'", [toReject]))[0].r).toBe("amount does not match the slip");

    // void: confirmation dialog, cancel keeps it, reason required
    await rowFor(page, toApprove).getByTestId("void-payment").click();
    await page.getByRole("dialog").getByText(/cannot be undone/).waitFor();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    expect((await q("select status from payments where id = $1", [toApprove]))[0].status).toBe("approved");
    await rowFor(page, toApprove).getByTestId("void-payment").click();
    await page.getByRole("dialog").getByLabel(/Reason/).fill("dup");
    await page.getByRole("dialog").getByTestId("reason-confirm").click();
    await page.getByRole("dialog").getByText("Enter a reason of at least 5 characters.").waitFor();
    await page.getByRole("dialog").getByLabel(/Reason/).fill("paid twice by mistake");
    await page.getByRole("dialog").getByTestId("reason-confirm").click();
    await toast(page, /voided/);
    await page.waitForFunction((id) => document.querySelector(`[data-payment-id="${id}"]`)?.getAttribute("data-status") === "voided", toApprove);
    expect(await page.getByTestId("invoice-row").first().getAttribute("data-status")).not.toBe("paid"); // the voided payment no longer pays the deposit
    expect((await q("select count(*)::int n from payment_allocations where payment_id = $1", [toApprove]))[0].n).toBe(0);
  });

  it("a stale page: approving an already-approved payment shows a conflict message and refreshes", async () => {
    const lease = await uiLease();
    const id = (await api(`/api/leases/${lease.id}/payments`, { token: ctx.tok["staff@northwind.test"], body: { amountSen: 1000, method: "cash", receivedAt: "2026-05-05T10:00:00+08:00" } })).data.id as string;
    const { page } = await newPage();
    await loginStaff(page, "manager@northwind.test");
    await page.goto(`${BASE}/leases/${lease.id}`);
    await rowFor(page, id).waitFor();
    expect((await api(`/api/payments/${id}/approve`, { token: ctx.tok["manager@northwind.test"], body: {} })).status).toBe(200); // someone else approves first
    await rowFor(page, id).getByTestId("approve-payment").click();
    await toast(page, /only pending_verification|changed in the meantime|approved/i);
    await page.waitForFunction((pid) => document.querySelector(`[data-payment-id="${pid}"]`)?.getAttribute("data-status") === "approved", id);
  });
});

describe("create lease form", () => {
  const pickDay = async (page: Page, trigger: string, month: string, day: string) => {
    await page.locator(trigger).click();
    const [y, m] = month.split("-");
    await page.locator(`button[data-day="${Number(m)}/${Number(day)}/${y}"]`).last().click(); // the calendar renders en-US dates (M/D/YYYY) in this browser context
  };
  const pickOption = async (page: Page, trigger: string, name: string | RegExp) => {
    await page.locator(trigger).click();
    await page.getByRole("option", { name }).click();
  };

  it("only managers see the Create Lease button; staff and tenants cannot open the page", async () => {
    const mgr = await newPage();
    await loginStaff(mgr.page, "manager@northwind.test");
    await mgr.page.goto(`${BASE}/leases`);
    await mgr.page.getByTestId("create-lease-link").click();
    await mgr.page.waitForURL(/\/leases\/new$/);
    await mgr.page.getByTestId("lease-form").waitFor();

    const staff = await newPage();
    await loginStaff(staff.page, "staff@northwind.test");
    await staff.page.goto(`${BASE}/leases`);
    await staff.page.getByTestId("lease-row").first().waitFor();
    expect(await staff.page.getByTestId("create-lease-link").count()).toBe(0);
    await staff.page.goto(`${BASE}/leases/new`);
    await staff.page.waitForURL(/\/leases$/); // redirected, no form

    const tenant = await newPage();
    await loginTenant(tenant.page, "aisyah@northwind.test");
    await tenant.page.goto(`${BASE}/leases/new`);
    await tenant.page.waitForURL(/\/portal$/);
  });

  it("invalid input is explained inline and nothing is submitted", async () => {
    const { page } = await newPage();
    await loginStaff(page, "manager@northwind.test");
    await page.goto(`${BASE}/leases/new`);
    await page.getByTestId("create-lease").click();
    for (const text of ["Select a unit.", "Select a tenant.", "Select the start date.", "Select the end date.", "Enter the monthly rent."]) {
      await page.getByText(text).first().waitFor();
    }
    await page.locator("#lease-rent").fill("1,50.0");
    await page.locator("#lease-deposit").fill("abc");
    await page.getByTestId("create-lease").click();
    await page.getByText("Enter the deposit in ringgit").waitFor();
    expect(page.url()).toMatch(/\/leases\/new$/);
  });

  it("creates a lease (exact sen, Malaysia calendar dates, invoices) and opens its detail page", async () => {
    const unitId = await freshUnit(ctx);
    const unitName = (await q("select name from units where id = $1", [unitId]))[0].name as string;
    const month = new Date().toISOString().slice(0, 7);
    const { page } = await newPage();
    await loginStaff(page, "manager@northwind.test");
    await page.goto(`${BASE}/leases/new`);
    await pickOption(page, "#lease-unit", unitName);
    await pickOption(page, "#lease-tenant", /ben@northwind\.test/);
    await pickDay(page, "#lease-start", month, "01");
    await pickDay(page, "#lease-end", month, "28");
    await page.locator("#lease-rent").fill("1,500.50");
    await page.locator("#lease-deposit").fill("3000");
    await page.getByTestId("create-lease").click();
    await page.waitForURL(/\/leases\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const id = page.url().split("/").pop()!;
    ctx.created.leases.push(id);
    await page.getByTestId("invoice-table").waitFor();
    const [row] = await q("select unit_id, tenant_id, to_char(start_date, 'YYYY-MM-DD') s, to_char(end_date, 'YYYY-MM-DD') e, monthly_rent_sen::int rent, deposit_sen::int dep from leases where id = $1", [id]);
    expect(row).toMatchObject({ unit_id: unitId, tenant_id: ctx.tenant["ben@northwind.test"], s: `${month}-01`, e: `${month}-28`, rent: 150050, dep: 300000 });
    expect((await q("select count(*)::int n from invoices where lease_id = $1", [id]))[0].n).toBe(2); // deposit + one month
    expect((await q("select count(*)::int n from audit_log where entity_id = $1 and action = 'lease.created'", [id]))[0].n).toBe(1);
    expect(await page.getByTestId("invoice-row").count()).toBe(2);
  });

  it("an overlapping lease is rejected with a clear conflict message and nothing is created", async () => {
    const existing = await uiLease("ben@northwind.test"); // starts 40 days ago, runs 400 days, on a brand-new unit
    const unitName = (await q("select name from units where id = $1", [existing.unitId]))[0].name as string;
    const month = new Date().toISOString().slice(0, 7);
    const before = (await q("select count(*)::int n from leases where unit_id = $1", [existing.unitId]))[0].n;
    const { page } = await newPage();
    await loginStaff(page, "manager@northwind.test");
    await page.goto(`${BASE}/leases/new`);
    await pickOption(page, "#lease-unit", unitName);
    await page.getByText("Already leased:").waitFor(); // the unit's existing range is shown
    await pickOption(page, "#lease-tenant", /aisyah@northwind\.test/);
    await pickDay(page, "#lease-start", month, "01");
    await pickDay(page, "#lease-end", month, "28");
    await page.locator("#lease-rent").fill("1000");
    await page.getByTestId("create-lease").click();
    await page.getByTestId("lease-form-error").getByText(/overlapping/).waitFor();
    expect(page.url()).toMatch(/\/leases\/new$/);
    expect((await q("select count(*)::int n from leases where unit_id = $1", [existing.unitId]))[0].n).toBe(before);
  });
});

describe("tenant portal", () => {
  it("lists only the tenant's own leases and shows invoices, computed statuses, payments and the amount due now (Malaysia date)", async () => {
    const lease = await uiLease("ben@northwind.test");
    expect((await api(`/api/leases/${lease.id}/payments`, { token: ctx.tok["manager@northwind.test"], body: { amountSen: 20000, method: "cash", receivedAt: "2026-05-05T10:00:00+08:00" } })).status).toBe(201);
    const { page } = await newPage();
    await loginTenant(page, "ben@northwind.test");
    const own = (await q("select count(*)::int n from leases l join tenants t on t.id = l.tenant_id where t.email = 'ben@northwind.test'"))[0].n;
    await page.getByTestId("tenant-lease").first().waitFor(); // the page streams in after the redirect
    expect(await page.getByTestId("tenant-lease").count()).toBe(own);
    expect(await page.content()).not.toContain("A-12-3"); // Aisyah's unit
    await page.locator(`a[href="/portal/leases/${lease.id}"]`).click();
    await page.waitForURL(`**/portal/leases/${lease.id}`);
    const today = malaysiaDate(new Date());
    const facts = (await q("select i.due_date::text d, i.amount_sen::text a, (select coalesce(sum(amount_sen), 0) from payment_allocations where invoice_id = i.id)::text p from invoices i where i.lease_id = $1", [lease.id]));
    const expectedDue = facts.reduce((s, f) => (f.d <= today ? s + Math.max(0, Number(f.a) - Number(f.p)) : s), 0);
    expect(await page.getByTestId("due-now").textContent()).toBe(formatRM(expectedDue));
    expect(await page.getByTestId("invoice-row").count()).toBe(facts.length);
    expect(await page.getByTestId("invoice-row").first().getAttribute("data-status")).toBe("overdue"); // deposit RM 500 is only part-paid (RM 200) and its due date has passed
  });

  it("creates a gateway bill with Pay now, shows the bill id and amount, and the return page reflects the REAL status", async () => {
    const lease = await uiLease("ben@northwind.test");
    const { page } = await newPage();
    await loginTenant(page, "ben@northwind.test");
    await page.goto(`${BASE}/portal/leases/${lease.id}`);
    const shown = (await page.getByTestId("due-now").textContent())!;
    await page.getByTestId("pay-now-button").click();
    await page.getByTestId("bill-created").waitFor();
    const billId = (await page.getByTestId("bill-id").textContent())!;
    expect(billId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await page.getByTestId("bill-created").textContent()).toContain(shown);
    const bill = (await q("select status, amount_sen::text a from gateway_bills where id = $1", [billId]))[0];
    expect(bill.status).toBe("pending");
    expect(formatRM(Number(bill.a))).toBe(shown);

    await page.getByTestId("bill-return-link").click();
    await page.waitForURL(/\/payments\/return\?bill_id=/);
    await page.locator("[data-bill-status=pending]").waitFor();

    // a forged URL does not settle anything
    await page.goto(`${BASE}/payments/return?bill_id=${billId}&paid=true&status=paid`);
    await page.locator("[data-bill-status=pending]").waitFor();
    expect((await q("select status from gateway_bills where id = $1", [billId]))[0].status).toBe("pending");
    expect((await q("select count(*)::int n from payments where lease_id = $1", [lease.id]))[0].n).toBe(0);

    // the gateway (simulator) settles it; only then does the page say paid
    const sim = await run("node", ["gateway-sim.mjs", billId, bill.a], { env: { ...process.env, WEBHOOK_URL: `${BASE}/api/webhooks/gateway` } });
    expect(sim.stdout).toMatch(/^200 /);
    await page.goto(`${BASE}/payments/return?bill_id=${billId}&paid=false`);
    await page.locator("[data-bill-status=paid]").waitFor();
    await page.goto(`${BASE}/portal/leases/${lease.id}`);
    await page.locator("[data-testid=payment-row][data-status=approved]").waitFor();
    expect(await page.getByTestId("payment-table").textContent()).toContain("Online");
    expect(await page.getByTestId("slip-link").count()).toBe(0); // tenants never get slip links
    expect(await page.getByTestId("approve-payment").count()).toBe(0);
  });

  it("another tenant cannot see the bill on the return page", async () => {
    const lease = await uiLease("ben@northwind.test");
    const bill = await api(`/api/leases/${lease.id}/gateway-bills`, { token: ctx.tok["ben@northwind.test"], body: {} });
    const { page } = await newPage();
    await loginTenant(page, "aisyah@northwind.test");
    await page.goto(`${BASE}/payments/return?bill_id=${bill.data.billId}&paid=true`);
    await page.locator("[data-state=not-found]").waitFor();
    expect(await page.locator("[data-bill-status]").count()).toBe(0);
  });

  it("edits the phone number directly through the Data API with the user's own session; validation errors are specific", async () => {
    const { page } = await newPage();
    await loginTenant(page, "probe@northwind.test");
    const original = (await q("select phone from tenants where email = 'probe@northwind.test'"))[0].phone;
    const restRequests: { method: string; url: string; apikey: string | undefined; auth: string | undefined; body: string | null }[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/rest/v1/tenants")) restRequests.push({ method: r.method(), url: r.url(), apikey: r.headers()["apikey"], auth: r.headers()["authorization"], body: r.postData() });
    });
    try {
      await page.locator("#tenant-phone").fill("abc");
      await page.getByTestId("save-phone").click();
      await page.locator("#tenant-phone-error").waitFor();
      await page.locator("#tenant-phone").fill("+60 19 876 5432");
      await page.getByTestId("save-phone").click();
      await toast(page, "Phone number updated");
      expect((await q("select phone from tenants where email = 'probe@northwind.test'"))[0].phone).toBe("+60 19 876 5432");
      const patch = restRequests.find((r) => r.method === "PATCH");
      expect(patch, "the update goes straight to PostgREST").toBeTruthy();
      expect(patch!.apikey).toBe(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
      expect(patch!.apikey).not.toBe(process.env.SUPABASE_SECRET_KEY);
      expect(JSON.parse(patch!.body!)).toEqual({ phone: "+60 19 876 5432" }); // only the phone is sent
      expect(patch!.auth).toMatch(/^Bearer eyJ/); // the user's own access token, not a key
      await page.reload();
      expect(await page.locator("#tenant-phone").inputValue()).toBe("+60 19 876 5432");
    } finally {
      await q("update tenants set phone = $1 where email = 'probe@northwind.test'", [original]);
    }
  });
});

describe("timezones, hydration and secrets", () => {
  it("renders identical Malaysia times in every browser timezone (UTC, Los Angeles, Kuala Lumpur, Kiritimati)", async () => {
    const lease = ctx.leaseOf["aisyah@northwind.test"];
    const seen: string[] = [];
    for (const tz of ["UTC", "America/Los_Angeles", "Asia/Kuala_Lumpur", "Pacific/Kiritimati"]) {
      const { page, context } = await newPage({ timezoneId: tz });
      await loginStaff(page, "manager@northwind.test");
      await page.goto(`${BASE}/leases/${lease}`);
      await page.getByTestId("payment-table").waitFor();
      const text = (await page.getByTestId("payment-table").locator("tbody").textContent())!;
      expect(text, tz).toContain(formatInstantMy("2026-01-31T02:00:00.000Z"));
      expect(text, tz).toContain(formatInstantMy("2026-02-28T16:30:00.000Z"));
      seen.push(text.replace(/\s+/g, " "));
      const inv = (await page.getByTestId("invoice-table").locator("tbody").textContent())!;
      expect(inv, tz).toContain("31 Jan 2026");
      expect(inv, tz).toContain("28 Feb 2026");
      const browserTz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
      expect(browserTz).toBe(tz); // the emulation really applied
      await context.close();
    }
    expect(new Set(seen).size).toBe(1);
  });

  it("a payment entered in Malaysia time is stored as the same instant from any browser timezone", async () => {
    for (const tz of ["Pacific/Kiritimati", "America/New_York"]) {
      const lease = await uiLease();
      const { page, context } = await newPage({ timezoneId: tz });
      await loginStaff(page, "manager@northwind.test");
      await page.goto(`${BASE}/leases/${lease.id}`);
      await fillPayment(page, "100", "2026-03-01T00:30");
      await submitPayment(page);
      await toast(page, /recorded and approved/);
      const row = page.getByTestId("payment-row").first();
      await row.waitFor();
      expect(await row.textContent()).toContain("1 Mar 2026, 00:30 MYT");
      expect(new Date((await q("select received_at from payments where lease_id = $1", [lease.id]))[0].received_at).toISOString(), tz).toBe("2026-02-28T16:30:00.000Z");
      await context.close();
    }
  });

  it("control: the console watcher really records errors", async () => {
    const { page } = await newPage();
    await page.goto(`${BASE}/login`);
    await page.evaluate(() => console.error("control error"));
    await page.evaluate(() => { throw new Error("control page error"); }).catch(() => undefined);
    await page.waitForTimeout(200);
    const recorded = consoleProblems.filter((p) => p.includes("control"));
    expect(recorded.length).toBeGreaterThanOrEqual(1);
    for (const p of recorded) consoleProblems.splice(consoleProblems.indexOf(p), 1);
  });

  it("produced no hydration warnings, console errors or page errors anywhere in this run", () => {
    expect(consoleProblems).toEqual([]);
  });

  it("no secrets reach the browser: client bundles, rendered pages and cookies are clean", async () => {
    const walk = (dir: string, out: string[] = []) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p, out);
        else out.push(p);
      }
      return out;
    };
    const files = walk(".next/static");
    const corpus = files.map((f) => readFileSync(f, "utf8"));
    const { page, context } = await newPage();
    await loginStaff(page, "manager@northwind.test");
    for (const path of ["/dashboard", "/leases", `/leases/${ctx.leaseOf["aisyah@northwind.test"]}`]) {
      await page.goto(`${BASE}${path}`);
      corpus.push(await page.content());
    }
    corpus.push(JSON.stringify(await context.cookies()), await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })));
    for (const needle of [...secretNeedles, "SUPABASE_SECRET_KEY", "GATEWAY_X_SIGNATURE_KEY", "DATABASE_URL"]) {
      expect(corpus.filter((c) => c.includes(needle)).length, needle.slice(0, 12)).toBe(0);
    }
    expect(corpus.some((c) => c.includes(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!))).toBe(true); // positive control: the public key is there
  });
});
