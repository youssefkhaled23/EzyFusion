#!/usr/bin/env node
// Payment gateway simulator: sends a signed form-urlencoded callback to the webhook.
//
//   node gateway-sim.mjs <bill_id> <amount_sen> [true|false]
//
// Environment:
//   GATEWAY_X_SIGNATURE_KEY  shared HMAC key (required; also read from .env.local when not set)
//   WEBHOOK_URL              default http://localhost:3000/api/webhooks/gateway
import { createHmac, randomBytes } from 'node:crypto'

try {
  if (!process.env.GATEWAY_X_SIGNATURE_KEY) process.loadEnvFile('.env.local')
} catch {
  /* no .env.local */
}

const [billId, amount, paidArg = 'true'] = process.argv.slice(2)
if (!billId || !/^\d+$/.test(amount ?? '') || !['true', 'false'].includes(paidArg)) {
  console.error('usage: node gateway-sim.mjs <bill_id> <amount_sen> [true|false]')
  process.exit(2)
}
const key = process.env.GATEWAY_X_SIGNATURE_KEY
if (!key) {
  console.error('GATEWAY_X_SIGNATURE_KEY is not set')
  process.exit(2)
}
const url = process.env.WEBHOOK_URL ?? 'http://localhost:3000/api/webhooks/gateway'
const paid = paidArg === 'true'

// Malaysia wall-clock time "YYYY-MM-DD HH:mm:ss +0800"
const paidAt = `${new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ')} +0800`

const fields = {
  id: billId,
  paid: String(paid),
  paid_amount: amount,
  paid_at: paidAt,
  transaction_id: `TX-${randomBytes(4).toString('hex').toUpperCase()}`,
  transaction_status: paid ? 'completed' : 'failed',
}

// 1) all fields except x_signature  2) sort keys by character code  3) key+value  4) join with "|"  5) HMAC-SHA256 hex
const canonical = Object.keys(fields)
  .sort()
  .map((k) => `${k}${fields[k]}`)
  .join('|')
fields.x_signature = createHmac('sha256', key).update(canonical).digest('hex')

let res
try {
  res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
} catch {
  console.error(`could not reach ${url} (is the app running?)`)
  process.exit(1)
}
const text = await res.text()
console.log(`${res.status} ${text}`)
process.exit(res.ok ? 0 : 1)
