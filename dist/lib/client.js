'use strict'
// The Jev client: request validation, the POST <base>/v1/systemone call with retries, and the
// OpenRouter balance. A port of the reference Python client (`jev ask` / `jev grid`) to fetch, kept free of
// `ctx` so it is unit-tested under plain node (test/client.test.js).
//
// Choices only, on purpose: a question must be one of Jev's typed kinds (noul = yes/no probability,
// choice = pick one of named criteria, score). There is no free-form prompt, no chat, no other
// model route: this plugin is not a general OpenRouter client, and the validation below is what
// keeps it that way for every plugin that calls the service.

const ENDPOINTS = {
  openrouter: 'https://openrouter.ai/api',
  typesafe: 'https://api.typesafe.ai',
}
// Same retry policy as the reference client: rate limits and gateway errors are worth another try,
// a 4xx is the caller's mistake and fails at once.
const RETRY_STATUS = new Set([429, 500, 502, 503, 529])
const ATTEMPTS = 4
const DETAIL_MAX = 500 // error-body cap, so an HTML error page never floods a log or a caller
// The reference client's fallback price, used only on OpenRouter when a response carries no
// usage.cost; such a record is flagged `costEstimated`.
const PRICE_PER_TOKEN = 0.042e-6

// Caps on what one request may carry. Jev bills per input token, and every enabled plugin of a
// project can call the service, so a runaway caller must hit a wall before it hits the budget.
const LIMITS = {
  questions: 32,
  idChars: 128,
  stateChars: 200000,
  instructionsChars: 4000,
  criteria: 64,
  criterionChars: 2000,
  scoreExtraJson: 2000,
  items: 2000,
  labelChars: 64,
}
const TYPES = new Set(['noul', 'choice', 'score'])

class JevError extends Error {
  /** status: the HTTP status for an HTTP failure, else null (deadline, network, validation). */
  constructor(message, status = null) {
    super(message)
    this.name = 'JevError'
    this.status = status
  }
}

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype

/**
 * The endpoint the app settings name, as { endpoint, baseUrl, model, key, isOpenRouter }.
 * Throws JevError for a missing key or a bad custom URL, so a misconfiguration surfaces in the
 * caller's error, not as a fetch failure.
 */
function resolveConfig(app) {
  app = app || {}
  const endpoint = app.endpoint || 'openrouter'
  let raw
  if (endpoint === 'custom') {
    raw = (app.customBaseUrl || '').trim()
    if (!raw) throw new JevError('endpoint is "custom" but no custom base URL is set (Settings > Plugins > Jev)')
  } else if (ENDPOINTS[endpoint]) {
    raw = ENDPOINTS[endpoint]
  } else {
    throw new JevError(`unknown endpoint "${endpoint}"`)
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new JevError(`custom base URL is not a URL: ${raw}`)
  }
  // The key travels as a bearer token: never over plain http, except to this machine (a local
  // proxy such as LiteLLM). No credentials, query or fragment: the path is appended to the base.
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new JevError('custom base URL must be https (http only for localhost)')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new JevError('custom base URL may not hold credentials, a query or a fragment')
  }
  const key = typeof app.apiKey === 'string' ? app.apiKey.trim() : ''
  if (!key) throw new JevError('no API key: set it in Settings > Plugins > Jev')
  const model = (typeof app.model === 'string' && app.model.trim()) || 'typesafe/jev-1.13'
  return {
    endpoint,
    baseUrl: url.href.replace(/\/+$/, ''),
    model,
    key,
    // Cost and balance come from OpenRouter only (usage.cost, /v1/key, /v1/credits). A custom URL
    // pointing at openrouter.ai counts too.
    isOpenRouter: endpoint === 'openrouter' || url.hostname === 'openrouter.ai',
  }
}

function checkId(id, what) {
  if (typeof id !== 'string' || id.length < 1 || id.length > LIMITS.idChars) {
    throw new JevError(`${what} must be a string of 1..${LIMITS.idChars} characters`)
  }
}

function checkText(v, max, what) {
  if (typeof v !== 'string' || !v.trim()) throw new JevError(`${what} must be a non-empty string`)
  if (v.length > max) throw new JevError(`${what} is longer than ${max} characters`)
}

/**
 * A clean copy of a questions map ({ id: { type, instructions, criteria? } }), or a JevError.
 * Only the known keys of noul and choice are kept. The reference client never builds a score
 * question, so its extra keys are passed through as long as they are small and plain.
 */
function validateQuestions(questions) {
  if (!isPlainObject(questions)) throw new JevError('questions must be an object: { id: { type, instructions } }')
  const ids = Object.keys(questions)
  if (ids.length === 0) throw new JevError('questions is empty')
  if (ids.length > LIMITS.questions) throw new JevError(`at most ${LIMITS.questions} questions per request`)
  const out = {}
  for (const id of ids) {
    checkId(id, 'a question id')
    const q = questions[id]
    if (!isPlainObject(q)) throw new JevError(`question "${id}" must be an object`)
    if (!TYPES.has(q.type)) {
      throw new JevError(`question "${id}": type must be noul, choice or score (Jev answers typed questions only)`)
    }
    checkText(q.instructions, LIMITS.instructionsChars, `question "${id}" instructions`)
    if (q.type === 'noul') {
      out[id] = { type: 'noul', instructions: q.instructions }
    } else if (q.type === 'choice') {
      if (!isPlainObject(q.criteria)) {
        throw new JevError(`choice question "${id}" needs criteria: { name: description }`)
      }
      const names = Object.keys(q.criteria)
      if (names.length < 2 || names.length > LIMITS.criteria) {
        throw new JevError(`choice question "${id}" needs 2..${LIMITS.criteria} criteria`)
      }
      const criteria = {}
      for (const name of names) {
        checkId(name, `a criterion name of "${id}"`)
        const d = q.criteria[name]
        if (typeof d !== 'string' || d.length > LIMITS.criterionChars) {
          throw new JevError(`criterion "${name}" of "${id}" must be a string of at most ${LIMITS.criterionChars} characters`)
        }
        criteria[name] = d
      }
      out[id] = { type: 'choice', instructions: q.instructions, criteria }
    } else {
      const extra = {}
      for (const [k, v] of Object.entries(q)) {
        if (k === 'type' || k === 'instructions') continue
        if (v !== null && typeof v === 'object' && !isPlainObject(v) && !Array.isArray(v)) {
          throw new JevError(`score question "${id}": ${k} must be plain JSON`)
        }
        extra[k] = v
      }
      if (JSON.stringify(extra).length > LIMITS.scoreExtraJson) {
        throw new JevError(`score question "${id}" carries too much beside its instructions`)
      }
      out[id] = { ...extra, type: 'score', instructions: q.instructions }
    }
  }
  return out
}

function validateState(state) {
  if (typeof state !== 'string') throw new JevError('state must be a string (the text Jev judges)')
  if (state.length > LIMITS.stateChars) throw new JevError(`state is longer than ${LIMITS.stateChars} characters`)
  return state
}

function validateLabel(label) {
  if (label === undefined || label === null) return null
  if (typeof label !== 'string' || label.length > LIMITS.labelChars) {
    throw new JevError(`label must be a string of at most ${LIMITS.labelChars} characters`)
  }
  return label
}

/** Grid items: [{ id, text } | { id, state }], ids unique; numbers become strings. */
function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new JevError('items must be a non-empty array')
  if (items.length > LIMITS.items) throw new JevError(`at most ${LIMITS.items} items per grid`)
  const seen = new Set()
  return items.map((item, i) => {
    if (!isPlainObject(item)) throw new JevError(`item ${i} must be an object { id, text }`)
    const id = typeof item.id === 'number' && Number.isFinite(item.id) ? String(item.id) : item.id
    checkId(id, `item ${i} id`)
    if (seen.has(id)) throw new JevError(`item id "${id}" appears twice`)
    seen.add(id)
    const state = item.state !== undefined ? item.state : item.text
    if (state === undefined) throw new JevError(`item "${id}" needs text or state`)
    return { id, state: validateState(state) }
  })
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new JevError('aborted'))
    const t = setTimeout(resolve, ms)
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new JevError('aborted')) }, { once: true })
  })

function retryDelayMs(res, attempt) {
  const s = Number(res && res.headers && res.headers.get('retry-after'))
  return Number.isFinite(s) && s >= 0 ? Math.min(s, 30) * 1000 : 2 ** attempt * 1000
}

/**
 * One POST <base>/v1/systemone. timeoutMs is the budget for all attempts and backoff; unlike
 * urllib in the reference client, each attempt is aborted at the deadline, so a server that keeps
 * dripping bytes cannot hold a call past it. A retry whose backoff would pass the deadline is
 * skipped and the last error thrown. `signal` (a CLI Ctrl+C) aborts at once, with no retry.
 * Resolves { resp, tokens, reportedCost, ms } with `ms` the last attempt's time.
 */
async function call(cfg, state, questions, opts = {}) {
  const timeoutMs = opts.timeoutMs || 30000
  const attempts = Math.max(1, opts.attempts || ATTEMPTS)
  const doFetch = opts.fetch || fetch
  const signal = opts.signal
  const deadline = Date.now() + timeoutMs
  const body = JSON.stringify({ model: cfg.model, state, questions })
  let lastErr
  for (let attempt = 0; attempt < attempts; attempt++) {
    const last = attempt === attempts - 1
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw lastErr || new JevError('deadline exceeded')
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), remaining)
    const onAbort = () => ac.abort()
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); throw new JevError('aborted') }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    const t0 = Date.now()
    let res
    let text
    try {
      res = await doFetch(cfg.baseUrl + '/v1/systemone', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json' },
        body,
        signal: ac.signal,
      })
      text = await res.text()
    } catch (e) {
      if (signal && signal.aborted) throw new JevError('aborted')
      lastErr = new JevError(ac.signal.aborted ? 'deadline exceeded' : `network: ${(e && e.message) || e}`)
      if (last || ac.signal.aborted) throw lastErr
      const delay = 2 ** attempt * 1000
      if (delay > deadline - Date.now()) throw lastErr
      await sleep(delay, signal)
      continue
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    if (!res.ok) {
      lastErr = new JevError(`HTTP ${res.status}: ${String(text).slice(0, DETAIL_MAX)}`, res.status)
      if (RETRY_STATUS.has(res.status) && !last) {
        const delay = retryDelayMs(res, attempt)
        if (delay > deadline - Date.now()) throw lastErr
        await sleep(delay, signal)
        continue
      }
      throw lastErr
    }
    let resp
    try {
      resp = JSON.parse(text)
    } catch {
      throw new JevError(`malformed response (not JSON): ${String(text).slice(0, 200)}`)
    }
    if (!isPlainObject(resp) || !isPlainObject(resp.answers)) throw new JevError('malformed response (no answers)')
    const usage = isPlainObject(resp.usage) ? resp.usage : {}
    const tokens = Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0
    const reportedCost = Number.isFinite(usage.cost) ? usage.cost : null
    return { resp, tokens, reportedCost, ms: Date.now() - t0 }
  }
  throw lastErr || new JevError('no attempt made')
}

/** What a request cost: OpenRouter's usage.cost, its token estimate, or null off OpenRouter. */
function costOf(cfg, tokens, reportedCost) {
  if (!cfg.isOpenRouter) return { cost: null, costEstimated: false }
  if (reportedCost !== null) return { cost: reportedCost, costEstimated: false }
  return { cost: tokens * PRICE_PER_TOKEN, costEstimated: true }
}

/** Drop nouls below `min` and choices named in `skip` (the reference's grid filters). */
function filterAnswers(answers, { min = 0, skip = [] } = {}) {
  const out = {}
  for (const [id, a] of Object.entries(answers || {})) {
    if (a && a.type === 'noul' && typeof a.noul === 'number' && a.noul < min) continue
    if (a && a.type === 'choice' && skip.includes(a.choice)) continue
    out[id] = a
  }
  return out
}

/** One short line per answer, for the usage log and the panel ("yes 0.93", "urgent 0.81"). */
function summarizeAnswer(a) {
  if (!a || typeof a !== 'object') return '?'
  const n = (v) => (typeof v === 'number' ? v.toFixed(2) : '?')
  if (a.type === 'noul') return `${a.noul >= 0.5 ? 'yes' : 'no'} ${n(a.noul)}`
  if (a.type === 'choice') return `${String(a.choice).slice(0, 64)} ${n(a.confidence)}`
  if (a.type === 'score') return `${n(a.score)} (conf ${n(a.confidence)})`
  return JSON.stringify(a).slice(0, 80)
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

async function getData(cfg, path, doFetch, timeoutMs) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await doFetch(cfg.baseUrl + path, { headers: { Authorization: 'Bearer ' + cfg.key }, signal: ac.signal })
    const text = await res.text()
    if (!res.ok) throw new JevError(`HTTP ${res.status}: ${text.slice(0, DETAIL_MAX)}`, res.status)
    let body
    try { body = JSON.parse(text) } catch { throw new JevError('malformed response (not JSON)') }
    if (!isPlainObject(body) || !isPlainObject(body.data)) throw new JevError("malformed response (no 'data')")
    return body.data
  } catch (e) {
    if (e instanceof JevError) throw e
    throw new JevError(ac.signal.aborted ? 'deadline exceeded' : `network: ${(e && e.message) || e}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * What this key can still spend, OpenRouter only: the smaller of the account's available credit
 * (GET /v1/credits, every key on the account) and the key's own remaining limit (GET /v1/key). A
 * key's limit alone overstates it. /v1/credits failing is not fatal (a key without the
 * permission): the balance is then the key's limit_remaining, and `creditsError` says why.
 */
async function balance(cfg, opts = {}) {
  if (!cfg.isOpenRouter) throw new JevError('balance is OpenRouter-only')
  const doFetch = opts.fetch || fetch
  const timeoutMs = opts.timeoutMs || 15000
  const key = await getData(cfg, '/v1/key', doFetch, timeoutMs)
  let credits = {}
  let creditsError = null
  try {
    credits = await getData(cfg, '/v1/credits', doFetch, timeoutMs)
  } catch (e) {
    creditsError = e.message
  }
  const total = num(credits.total_credits)
  const used = num(credits.total_usage)
  const available = total !== null && used !== null ? Math.round((total - used) * 1e6) / 1e6 : null
  const candidates = [available, num(key.limit_remaining)].filter((v) => v !== null)
  return {
    ts: Date.now(),
    balance: candidates.length ? Math.min(...candidates) : null,
    available,
    limit: num(key.limit),
    limitRemaining: num(key.limit_remaining),
    keyUsage: num(key.usage),
    creditsError,
  }
}

module.exports = {
  ENDPOINTS,
  LIMITS,
  JevError,
  resolveConfig,
  validateQuestions,
  validateState,
  validateLabel,
  validateItems,
  call,
  costOf,
  filterAnswers,
  summarizeAnswer,
  balance,
}
