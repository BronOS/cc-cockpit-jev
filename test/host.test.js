'use strict'
// The host against a fake ctx shaped after `ccc guide api`, with global fetch stubbed.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { fakeAppStorage } = require('./fake-app-storage')

function fakeCtx(app, appStorage = fakeAppStorage()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-host-'))
  const ctx = {
    api: 1,
    pluginId: 'bronos.jev',
    dataDir: path.join(root, 'plugin-data', 'p1', 'bronos.jev'),
    appStorage,
    callerId: 'acme.consumer',
    settings: { app: { endpoint: 'openrouter', model: 'typesafe/jev-1.13', monthlyCapUsd: 5, monthlyRequestCap: 0, monthlyTokenCap: 0, timeoutSeconds: 5, apiKey: 'sk', ...app }, project: {} },
    provided: {},
    cli: {},
    posts: [],
    log: { info() {}, warn() {}, error() {} },
    onSettingsChange: () => () => {},
    schedule: () => () => {},
    services: { provide: (n, impl) => { ctx.provided[n] = impl }, caller: () => ctx.callerId },
    panels: { onMessage: () => () => {}, post: async (id, m) => { ctx.posts.push(m) } },
    badge() {},
    cli: { register: (n, h) => { ctx.cli[n] = h } },
  }
  return ctx
}

function stubFetch(answerFor) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null })
    if (url.endsWith('/v1/key') || url.endsWith('/v1/credits')) return { ok: false, status: 403, text: async () => 'no' }
    const body = answerFor(JSON.parse(init.body))
    return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(body) }
  }
  return calls
}

function load(app, appStorage) {
  delete require.cache[require.resolve('../dist/host.js')]
  const host = require('../dist/host.js')
  const ctx = fakeCtx(app, appStorage)
  host.activate(ctx)
  return { host, ctx, jev: ctx.provided.jev }
}

const Q = { fail: { type: 'noul', instructions: 'Did it fail?' } }

test('ask: answers, cost, logged', async () => {
  stubFetch(() => ({ model: 'typesafe/jev-1.13', answers: { fail: { type: 'noul', noul: 0.97 } }, usage: { input_tokens: 50, cost: 0.0001 } }))
  const { host, ctx, jev } = load()
  const r = await jev.ask({ state: 'build failed', questions: Q, label: 't' })
  assert.equal(r.answers.fail.noul, 0.97)
  assert.equal(r.cost, 0.0001)
  const out = await ctx.cli.jev(['usage'], { stdin: '' })
  assert.match(out.stdout, /all projects: 1 requests/)
  assert.match(out.stdout, /acme\.consumer: 1 requests/) // the caller comes from the app, not the label
  assert.match(out.stdout, /acme\.consumer\/t +fail -> yes 0\.97/)
  host.deactivate()
})

test('ask: free-form and bad input are refused before any request', async () => {
  const calls = stubFetch(() => ({ answers: {} }))
  const { host, jev } = load()
  await assert.rejects(jev.ask({ state: 'x', questions: { q: { type: 'text', instructions: 'write' } } }), /^Error: jev: .*noul, choice or score/)
  await assert.rejects(jev.ask(null), /jev: ask\(request\)/)
  assert.equal(calls.filter((c) => c.url.endsWith('/systemone')).length, 0)
  host.deactivate()
})

test('grid: one request per item, min filter, per-item results', async () => {
  const calls = stubFetch((b) => ({ answers: { fail: { type: 'noul', noul: b.state === 'bad' ? 0.9 : 0.1 } }, usage: { input_tokens: 10, cost: 0.00001 } }))
  const { host, jev } = load()
  const r = await jev.grid([{ id: 'a', text: 'bad' }, { id: 'b', text: 'fine' }], Q, { min: 0.5 })
  assert.equal(calls.filter((c) => c.url.endsWith('/systemone')).length, 2)
  assert.deepEqual(Object.keys(r.results.a.answers), ['fail'])
  assert.deepEqual(r.results.b.answers, {})
  assert.equal(r.stats.items, 2)
  assert.equal(r.stats.tokens, 20)
  host.deactivate()
})

test('cap: refused once the month reaches it; other endpoints count requests', async () => {
  stubFetch(() => ({ answers: { fail: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: 10, cost: 1 } }))
  const { host, jev } = load({ monthlyCapUsd: 2 })
  await jev.ask({ state: 'a', questions: Q })
  await jev.ask({ state: 'b', questions: Q })
  await assert.rejects(jev.ask({ state: 'c', questions: Q }), /monthly spending cap reached/)
  host.deactivate()

  stubFetch(() => ({ answers: {}, usage: { input_tokens: 10, cost: 1 } }))
  const d = load({ endpoint: 'typesafe', monthlyCapUsd: 0.01, monthlyRequestCap: 1 })
  const r = await d.jev.ask({ state: 'a', questions: Q })
  assert.equal(r.cost, null) // cost is OpenRouter-only, even when the response reports one
  await assert.rejects(d.jev.ask({ state: 'b', questions: Q }), /monthly request cap reached/)
  d.host.deactivate()
})

test('grid: parallel workers do not overshoot the request cap', async () => {
  stubFetch(() => ({ answers: {}, usage: { input_tokens: 1 } }))
  const { host, jev } = load({ endpoint: 'typesafe', monthlyRequestCap: 3 })
  const items = Array.from({ length: 10 }, (_, i) => ({ id: i, text: 't' }))
  const r = await jev.grid(items, Q, { workers: 8 })
  assert.equal(Object.values(r.results).filter((x) => x.answers).length, 3)
  assert.equal(r.stats.errors, 7)
  host.deactivate()
})

test('cap: counted app-wide, so a second window sees what the first spent', async () => {
  stubFetch(() => ({ answers: {}, usage: { input_tokens: 10, cost: 1 } }))
  const shared = fakeAppStorage()
  const w1 = load({ monthlyCapUsd: 1 }, shared)
  await w1.jev.ask({ state: 'a', questions: Q })
  const w2 = load({ monthlyCapUsd: 1 }, shared)
  await assert.rejects(w2.jev.ask({ state: 'b', questions: Q }), /monthly spending cap reached/)
  w1.host.deactivate()
  w2.host.deactivate()
})

test('cli: help, unknown subcommand, ask counted as cli', async () => {
  stubFetch(() => ({ answers: { fail: { type: 'noul', noul: 0.2 } }, usage: { input_tokens: 3, cost: 0.000001 } }))
  const { host, ctx } = load()
  assert.match((await ctx.cli.jev(['help'], { stdin: '' })).stdout, /ccc jev balance/)
  assert.match((await ctx.cli.jev(['ask', '--help'], { stdin: '' })).stdout, /req\.json/)
  assert.equal((await ctx.cli.jev(['nope'], { stdin: '' })).code, 2)
  const r = await ctx.cli.jev(['ask'], { stdin: JSON.stringify({ state: 's', questions: Q }) })
  assert.equal(r.code, undefined)
  assert.match((await ctx.cli.jev([], { stdin: '' })).stdout, /\n  cli: 1 requests/)
  host.deactivate()
})

test('title bar (cc-cockpit 0.9.0+): ↻ in the header, spinning while the balance is read; a click reads it again', async () => {
  // A balance request that waits until the test releases it, so the spinning state can be seen.
  // A balance read is two requests in a row (/v1/key, then /v1/credits): once released, every
  // request (the waiting one and later ones) answers at once, until the test holds them again.
  const calls = []
  let held = true
  const waiting = []
  const answer = () => ({ ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ data: { total_credits: 10, total_usage: 1 } }) })
  globalThis.fetch = (url) => {
    calls.push(url)
    if (!held) return Promise.resolve(answer())
    return new Promise((resolve) => waiting.push(() => resolve(answer())))
  }
  const release = () => {
    held = false
    for (const go of waiting.splice(0)) go()
  }
  const hold = () => {
    held = true
  }
  delete require.cache[require.resolve('../dist/host.js')]
  const host = require('../dist/host.js')
  const ctx = fakeCtx()
  const headers = []
  let onAction = null
  ctx.panels.header = (id, h) => headers.push(structuredClone(h))
  ctx.panels.onAction = (id, fn) => ((onAction = fn), () => {})
  host.activate(ctx)
  // The activation's balance read is running: the icon spins.
  assert.equal(headers.at(-1).actions[0].id, 'refresh')
  assert.equal(headers.at(-1).actions[0].icon, 'refresh')
  assert.equal(headers.at(-1).actions[0].busy, true)
  release()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(headers.at(-1).actions[0].busy, false)
  const before = calls.length
  hold()
  onAction('refresh')
  assert.equal(headers.at(-1).actions[0].busy, true)
  release()
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(calls.length > before, 'the click read the balance again')
  host.deactivate()
})

test('without ctx.panels.header (cc-cockpit 0.8) nothing breaks and the page keeps its own row', async () => {
  stubFetch(() => ({ data: { total_credits: 10, total_usage: 1 } }))
  const { host, ctx } = load()
  await new Promise((r) => setTimeout(r, 400))
  const st = ctx.posts.find((m) => m && m.type === 'state')
  if (st) assert.equal(st.coreHeader, false)
  host.deactivate()
})
