'use strict'
// Usage accounting, in two places with two jobs:
//
// - Counters (ctx.appStorage, app-wide): this month's requests, tokens and cost for every project
//   window, per caller too. The cap is checked against these. Each window runs its own host, so
//   the counters only grow through `increment`, which main applies atomically (`ccc guide api`,
//   "Which store"); a get-then-set would lose updates between windows.
// - UsageLog (ctx.dataDir, per project): one JSON line per request, one file per UTC month
//   (`usage-YYYY-MM.jsonl`), for the panel's "last requests" and for reading by hand. It is never
//   summed for the cap.

const fs = require('node:fs')
const path = require('node:path')

const monthOf = (d = new Date()) => d.toISOString().slice(0, 7) // UTC 'YYYY-MM'
const METRICS = ['requests', 'errors', 'tokens', 'cost', 'costRequests', 'estimatedRequests']
const CACHE_MS = 1000 // a grid checks the cap per item; one read of the counters a second is plenty

function parseLines(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (r && typeof r === 'object') out.push(r)
    } catch {
      // A torn last line (a host killed mid-write) is skipped, never fatal.
    }
  }
  return out
}

/** What one record adds to each metric. */
function deltas(r) {
  const cost = Number.isFinite(r.cost) ? r.cost : null
  return {
    requests: 1,
    errors: r.error ? 1 : 0,
    tokens: Number.isFinite(r.tokens) ? r.tokens : 0,
    cost: cost === null ? 0 : cost,
    costRequests: cost === null ? 0 : 1,
    estimatedRequests: cost !== null && r.costEstimated ? 1 : 0,
  }
}

const empty = () => Object.fromEntries(METRICS.map((m) => [m, 0]))

// Key layout in ctx.appStorage. A caller id is a plugin id or 'cli' (no ':' in either).
const totalKey = (month, metric) => `m:${month}:${metric}`
const callerKey = (month, caller, metric) => `c:${month}:${caller}:${metric}`

class Counters {
  /** store: ctx.appStorage (or a fake with get/increment/keys); now: injectable clock. */
  constructor(store, { now = () => new Date() } = {}) {
    this.store = store
    this.now = now
    this.cache = null // { month, at, totals }
  }

  /** Adds one record to this month's totals and its caller's. */
  async add(record, caller) {
    const month = monthOf(this.now())
    const d = deltas(record)
    const ops = []
    for (const m of METRICS) {
      if (!d[m]) continue
      ops.push(this.store.increment(totalKey(month, m), d[m]))
    }
    for (const m of ['requests', 'tokens', 'cost']) {
      if (d[m]) ops.push(this.store.increment(callerKey(month, caller || 'unknown', m), d[m]))
    }
    this.cache = null
    await Promise.all(ops)
  }

  /** This month's app-wide totals, cached for a second. */
  async month() {
    const month = monthOf(this.now())
    const c = this.cache
    if (c && c.month === month && Date.now() - c.at < CACHE_MS) return c.totals
    const totals = empty()
    const values = await Promise.all(METRICS.map((m) => this.store.get(totalKey(month, m))))
    METRICS.forEach((m, i) => {
      totals[m] = Number.isFinite(values[i]) ? values[i] : 0
    })
    this.cache = { month, at: Date.now(), totals }
    return totals
  }

  /** This month's per-caller totals: [{ caller, requests, tokens, cost }], most requests first. */
  async byCaller() {
    const month = monthOf(this.now())
    const prefix = `c:${month}:`
    const rows = new Map()
    const keys = (await this.store.keys()).filter((k) => k.startsWith(prefix))
    const values = await Promise.all(keys.map((k) => this.store.get(k)))
    keys.forEach((k, i) => {
      const rest = k.slice(prefix.length)
      const cut = rest.lastIndexOf(':')
      const caller = rest.slice(0, cut)
      const metric = rest.slice(cut + 1)
      if (!rows.has(caller)) rows.set(caller, { caller, requests: 0, tokens: 0, cost: 0 })
      if (Number.isFinite(values[i])) rows.get(caller)[metric] = values[i]
    })
    return [...rows.values()].sort((a, b) => b.requests - a.requests)
  }
}

class UsageLog {
  /** dataDir: ctx.dataDir (this project's); now: injectable clock for tests. */
  constructor(dataDir, { now = () => new Date() } = {}) {
    this.dataDir = dataDir
    this.now = now
    this.cache = new Map() // file -> { size, mtimeMs, totals }
    this.writing = Promise.resolve()
  }

  file(month = monthOf(this.now())) {
    return path.join(this.dataDir, `usage-${month}.jsonl`)
  }

  /** Appends one record. Writes are chained so lines of one host never interleave. */
  append(record) {
    const line = JSON.stringify(record) + '\n'
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        await fs.promises.mkdir(this.dataDir, { recursive: true })
        await fs.promises.appendFile(this.file(), line, { mode: 0o600 })
      })
    return this.writing
  }

  /** This project's totals for this month, re-read only when the file changed. */
  async projectTotals() {
    await this.writing.catch(() => {})
    const f = this.file()
    let st
    try {
      st = await fs.promises.stat(f)
    } catch {
      return empty()
    }
    const hit = this.cache.get(f)
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.totals
    const totals = empty()
    for (const r of parseLines(await fs.promises.readFile(f, 'utf8'))) {
      const d = deltas(r)
      for (const m of METRICS) totals[m] += d[m]
    }
    this.cache.set(f, { size: st.size, mtimeMs: st.mtimeMs, totals })
    return totals
  }

  /** The last `n` records of this project, newest first (this month, then last month). */
  async recent(n = 10) {
    await this.writing.catch(() => {})
    const d = this.now()
    const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1))
    const out = []
    for (const month of [monthOf(d), monthOf(prev)]) {
      let text
      try {
        text = await fs.promises.readFile(this.file(month), 'utf8')
      } catch {
        continue
      }
      out.push(...parseLines(text).reverse())
      if (out.length >= n) break
    }
    return out.slice(0, n)
  }
}

/**
 * Whether one more request is allowed, as null (yes) or the refusal text. `t` is this month's
 * app-wide totals. Dollars are checked only where cost is known (OpenRouter); the request and token
 * caps apply on any endpoint. `inflight` counts this host's requests started but not yet counted,
 * so a grid's parallel workers cannot all pass at once; each is priced at this month's average.
 * Another window's in-flight requests are not visible, so two windows can overshoot by at most
 * their parallel requests.
 */
function capRefusal(t, caps, { isOpenRouter, inflight = 0, month }) {
  if (isOpenRouter && caps.usd > 0) {
    const avg = t.costRequests > 0 ? t.cost / t.costRequests : 0
    if (t.cost + inflight * avg >= caps.usd) {
      return `monthly spending cap reached: $${t.cost.toFixed(4)} of $${caps.usd} spent in ${month} (all projects); raise it in Settings > Plugins > Jev`
    }
  }
  if (caps.requests > 0 && t.requests + inflight >= caps.requests) {
    return `monthly request cap reached: ${t.requests} of ${caps.requests} in ${month} (all projects)`
  }
  if (caps.tokens > 0 && t.tokens >= caps.tokens) {
    return `monthly token cap reached: ${t.tokens} of ${caps.tokens} in ${month} (all projects)`
  }
  return null
}

module.exports = { Counters, UsageLog, capRefusal, monthOf, parseLines, deltas }
