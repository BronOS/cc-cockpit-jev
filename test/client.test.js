'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const c = require('../dist/lib/client')

const KEY = { apiKey: 'sk-test' }
const NOUL = { q: { type: 'noul', instructions: 'Is it?' } }

// A scripted fetch: each entry is { status, body, headers } or an Error to throw.
function fakeFetch(script) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    const step = script.shift()
    if (!step) throw new Error('no more scripted responses')
    if (step instanceof Error) throw step
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      headers: new Map(Object.entries(step.headers || {})),
      text: async () => (typeof step.body === 'string' ? step.body : JSON.stringify(step.body)),
    }
  }
  fn.calls = calls
  return fn
}

test('resolveConfig: endpoints, defaults and refusals', () => {
  const or = c.resolveConfig(KEY)
  assert.equal(or.baseUrl, 'https://openrouter.ai/api')
  assert.equal(or.model, 'typesafe/jev-1.14')
  assert.equal(or.isOpenRouter, true)
  const ts = c.resolveConfig({ ...KEY, endpoint: 'typesafe' })
  assert.equal(ts.baseUrl, 'https://api.typesafe.ai')
  assert.equal(ts.isOpenRouter, false)
  assert.equal(c.resolveConfig({ ...KEY, endpoint: 'custom', customBaseUrl: 'https://gw.example/jev/' }).baseUrl, 'https://gw.example/jev')
  assert.equal(c.resolveConfig({ ...KEY, endpoint: 'custom', customBaseUrl: 'http://localhost:4000' }).isOpenRouter, false)
  assert.equal(c.resolveConfig({ ...KEY, endpoint: 'custom', customBaseUrl: 'https://openrouter.ai/api' }).isOpenRouter, true)
  assert.throws(() => c.resolveConfig({}), /no API key/)
  assert.throws(() => c.resolveConfig({ ...KEY, endpoint: 'custom' }), /no custom base URL/)
  assert.throws(() => c.resolveConfig({ ...KEY, endpoint: 'custom', customBaseUrl: 'http://gw.example' }), /https/)
  assert.throws(() => c.resolveConfig({ ...KEY, endpoint: 'custom', customBaseUrl: 'https://u:p@gw.example' }), /credentials/)
})

test('validateQuestions: typed questions only', () => {
  assert.deepEqual(c.validateQuestions({ q: { type: 'noul', instructions: 'Is it?', extra: 1 } }), NOUL)
  const choice = { p: { type: 'choice', instructions: 'Which?', criteria: { a: 'A', b: 'B' } } }
  assert.deepEqual(c.validateQuestions(choice), choice)
  assert.throws(() => c.validateQuestions({ q: { type: 'text', instructions: 'Write a poem' } }), /noul, choice or score/)
  assert.throws(() => c.validateQuestions({ q: { type: 'choice', instructions: 'x', criteria: { a: 'A' } } }), /2\.\./)
  assert.throws(() => c.validateQuestions({}), /empty/)
  assert.throws(() => c.validateQuestions({ q: { type: 'noul', instructions: '  ' } }), /non-empty/)
  const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`q${i}`, NOUL.q]))
  assert.throws(() => c.validateQuestions(many), /at most 32/)
})

test('validateItems: ids, text or state, duplicates', () => {
  assert.deepEqual(c.validateItems([{ id: 1, text: 'a' }, { id: 'x', state: 'b' }]), [{ id: '1', state: 'a' }, { id: 'x', state: 'b' }])
  assert.throws(() => c.validateItems([{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }]), /twice/)
  assert.throws(() => c.validateItems([{ id: 'a' }]), /text or state/)
  assert.throws(() => c.validateItems([]), /non-empty/)
})

test('call: request shape and usage', async () => {
  const cfg = c.resolveConfig(KEY)
  const f = fakeFetch([{ status: 200, body: { model: 'typesafe/jev-1.13', answers: { q: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 120, cost: 0.00001 } } }])
  const r = await c.call(cfg, 'text', NOUL, { fetch: f })
  assert.equal(f.calls[0].url, 'https://openrouter.ai/api/v1/systemone')
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer sk-test')
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { model: 'typesafe/jev-1.14', state: 'text', questions: NOUL })
  assert.equal(r.tokens, 120)
  assert.equal(r.reportedCost, 0.00001)
})

test('call: retries 429 with retry-after, fails a 400 at once', async () => {
  const cfg = c.resolveConfig(KEY)
  const ok = { status: 200, body: { answers: {} } }
  const f = fakeFetch([{ status: 429, body: 'slow down', headers: { 'retry-after': '0' } }, ok])
  await c.call(cfg, 's', NOUL, { fetch: f })
  assert.equal(f.calls.length, 2)
  const bad = fakeFetch([{ status: 400, body: 'bad question' }])
  await assert.rejects(c.call(cfg, 's', NOUL, { fetch: bad }), (e) => e.status === 400 && /HTTP 400: bad question/.test(e.message))
  assert.equal(bad.calls.length, 1)
})

test('call: gives up when backoff would pass the deadline', async () => {
  const cfg = c.resolveConfig(KEY)
  const f = fakeFetch([{ status: 503, body: 'x', headers: { 'retry-after': '20' } }])
  await assert.rejects(c.call(cfg, 's', NOUL, { fetch: f, timeoutMs: 1000 }), /HTTP 503/)
  assert.equal(f.calls.length, 1)
})

test('call: malformed responses', async () => {
  const cfg = c.resolveConfig(KEY)
  await assert.rejects(c.call(cfg, 's', NOUL, { fetch: fakeFetch([{ status: 200, body: '<html>' }]) }), /not JSON/)
  await assert.rejects(c.call(cfg, 's', NOUL, { fetch: fakeFetch([{ status: 200, body: { nope: 1 } }]) }), /no answers/)
})

test('call: aborts on a deadline mid-request', async () => {
  const cfg = c.resolveConfig(KEY)
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
  await assert.rejects(c.call(cfg, 's', NOUL, { fetch: hang, timeoutMs: 50 }), /deadline exceeded/)
})

test('costOf: OpenRouter reported, estimated, elsewhere null', () => {
  const or = c.resolveConfig(KEY)
  const ts = c.resolveConfig({ ...KEY, endpoint: 'typesafe' })
  assert.deepEqual(c.costOf(or, 100, 0.5), { cost: 0.5, costEstimated: false })
  assert.equal(c.costOf(or, 1000000, null).costEstimated, true)
  assert.deepEqual(c.costOf(ts, 100, 0.5), { cost: null, costEstimated: false })
})

test('filterAnswers and summarizeAnswer', () => {
  const answers = { a: { type: 'noul', noul: 0.2 }, b: { type: 'noul', noul: 0.8 }, c: { type: 'choice', choice: 'none', confidence: 0.9 } }
  assert.deepEqual(Object.keys(c.filterAnswers(answers, { min: 0.5, skip: ['none'] })), ['b'])
  assert.equal(c.summarizeAnswer(answers.b), 'yes 0.80')
  assert.equal(c.summarizeAnswer(answers.c), 'none 0.90')
})

test('balance: the smaller of credits and key limit; credits failure tolerated', async () => {
  const cfg = c.resolveConfig(KEY)
  const f = fakeFetch([
    { status: 200, body: { data: { limit: 10, limit_remaining: 7, usage: 3 } } },
    { status: 200, body: { data: { total_credits: 20, total_usage: 15 } } },
  ])
  assert.equal((await c.balance(cfg, { fetch: f })).balance, 5)
  const g = fakeFetch([{ status: 200, body: { data: { limit_remaining: 7 } } }, { status: 403, body: 'no' }])
  const b = await c.balance(cfg, { fetch: g })
  assert.equal(b.balance, 7)
  assert.match(b.creditsError, /HTTP 403/)
  await assert.rejects(c.balance(c.resolveConfig({ ...KEY, endpoint: 'typesafe' })), /OpenRouter-only/)
})
