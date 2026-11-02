'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Counters, UsageLog, capRefusal } = require('../dist/lib/usage')
const { fakeAppStorage } = require('./fake-app-storage')

const now = () => new Date('2026-11-02T10:00:00Z')

test('Counters: app-wide totals across windows and per caller', async () => {
  const store = fakeAppStorage()
  const a = new Counters(store, { now }) // two windows, one store
  const b = new Counters(store, { now })
  await a.add({ tokens: 10, cost: 0.1 }, 'acme.triage')
  await a.add({ tokens: 5, cost: null, error: 'HTTP 500' }, 'acme.triage')
  await b.add({ tokens: 7, cost: 0.2, costEstimated: true }, 'cli')
  const t = await new Counters(store, { now }).month()
  assert.equal(t.requests, 3)
  assert.equal(t.errors, 1)
  assert.equal(t.tokens, 22)
  assert.ok(Math.abs(t.cost - 0.3) < 1e-9)
  assert.equal(t.costRequests, 2)
  assert.equal(t.estimatedRequests, 1)
  assert.deepEqual(await a.byCaller(), [
    { caller: 'acme.triage', requests: 2, tokens: 15, cost: 0.1 },
    { caller: 'cli', requests: 1, tokens: 7, cost: 0.2 },
  ])
  assert.ok(store.map.has('m:2026-11:requests'))
})

test('Counters: a new month starts at zero; own adds bypass the cache', async () => {
  const store = fakeAppStorage()
  let d = new Date('2026-10-31T23:59:00Z')
  const c = new Counters(store, { now: () => d })
  await c.add({ tokens: 1 }, 'x')
  assert.equal((await c.month()).requests, 1)
  await c.add({ tokens: 1 }, 'x')
  assert.equal((await c.month()).requests, 2) // not the cached 1
  d = new Date('2026-11-01T00:00:01Z')
  assert.equal((await c.month()).requests, 0)
})

test('UsageLog: per project file, recent newest first, torn line skipped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-usage-'))
  const log = new UsageLog(dir, { now })
  await log.append({ ts: '1', tokens: 10, cost: 0.1 })
  await log.append({ ts: '2', tokens: 5, cost: null, error: 'x' })
  fs.appendFileSync(log.file(), '{"ts": "3"')
  const t = await log.projectTotals()
  assert.equal(t.requests, 2)
  assert.equal(t.errors, 1)
  assert.deepEqual((await log.recent(5)).map((r) => r.ts), ['2', '1'])
  assert.ok(fs.existsSync(path.join(dir, 'usage-2026-11.jsonl')))
})

test('capRefusal: dollars on OpenRouter only, requests and tokens anywhere, in-flight counted', () => {
  const t = (x) => ({ requests: 0, tokens: 0, cost: 0, costRequests: 0, ...x })
  const o = (x) => ({ month: '2026-11', ...x })
  const caps = { usd: 1, requests: 0, tokens: 0 }
  assert.equal(capRefusal(t({ cost: 0.5, costRequests: 5 }), caps, o({ isOpenRouter: true })), null)
  assert.match(capRefusal(t({ cost: 1, costRequests: 5 }), caps, o({ isOpenRouter: true })), /spending cap/)
  assert.equal(capRefusal(t({ cost: 1, costRequests: 5 }), caps, o({ isOpenRouter: false })), null)
  assert.match(capRefusal(t({ cost: 0.9, costRequests: 9 }), caps, o({ isOpenRouter: true, inflight: 1 })), /spending cap/)
  assert.match(capRefusal(t({ requests: 9 }), { usd: 0, requests: 10, tokens: 0 }, o({ isOpenRouter: false, inflight: 1 })), /request cap/)
  assert.match(capRefusal(t({ tokens: 100 }), { usd: 0, requests: 0, tokens: 100 }, o({ isOpenRouter: false })), /token cap/)
  assert.equal(capRefusal(t({ cost: 99, requests: 99 }), { usd: 0, requests: 0, tokens: 0 }, o({ isOpenRouter: true })), null)
})
