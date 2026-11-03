'use strict'
// Jev for cc-cockpit: provides the "jev" plugin service (v1), so the other plugins of a project
// can ask Jev (TypeSafe's typed classifier) choice questions:
//
//   const jev = ctx.services.use('jev')
//   await jev.ask({ state, questions, label? })             -> { answers, model, tokens, cost, costEstimated, ms }
//   await jev.grid(items, questions, { min?, skip?, label?, workers? })
//                                                           -> { results: { [id]: { answers } | { error } }, stats }
//
// Plain JavaScript, no build step: this file and lib/ run as they are. The request logic lives
// in lib/client.js and the usage accounting in lib/usage.js, both tested with `npm test`.

const client = require('./lib/client')
const { Counters, UsageLog, capRefusal, monthOf } = require('./lib/usage')

const PANEL = 'main'
const RECENT = 10
const QUESTION_TEXT_MAX = 160 // how much of a question the log keeps: enough to recognise it
const GRID_WORKERS = 8
const GRID_WORKERS_MAX = 16
const CLI_TIMEOUT_MS = 25000 // under the 30 s ccc limit, so a slow call errors instead of exit 124
const BALANCE_EVERY_S = 900
const BALANCE_STALE_MS = 5 * 60 * 1000
const CLI_CALLER = 'cli' // `ccc jev ask` has no calling plugin

const HELP = `jev: Jev usage and requests (the plugin also provides the "jev" service to other plugins)

  ccc jev [usage]                       this month's usage (all projects, per plugin, this project) and the last requests
  ccc jev balance                       OpenRouter balance (the smaller of account credit and the key's limit)
  ccc jev ask [--label L] < req.json    one request; req.json is { "state": "...", "questions": { ... } }
  ccc jev help                          this text
`

let disposers = []

exports.activate = (ctx) => {
  const counters = new Counters(ctx.appStorage)
  const usage = new UsageLog(ctx.dataDir)
  let inflight = 0
  let balanceState = { value: null, ts: 0, error: null }

  // ctx.settings is a frozen snapshot replaced on every save, so it is read fresh each time, never
  // kept. It holds the API key in plaintext when set; the key is absent until the person sets it.
  const app = () => ctx.settings.app || {}
  disposers.push(
    ctx.onSettingsChange(() => {
      balanceState = { value: null, ts: 0, error: null }
      refreshBalance()
      pushPanel()
    }),
  )

  const caps = () => ({
    usd: Number(app().monthlyCapUsd) || 0,
    requests: Number(app().monthlyRequestCap) || 0,
    tokens: Number(app().monthlyTokenCap) || 0,
  })
  const timeoutMs = () => Math.round((Number(app().timeoutSeconds) || 30) * 1000)

  // Errors cross the service boundary as a fresh Error with the message only (`ccc guide api`),
  // so every message names the plugin.
  const fail = (e) => {
    throw new Error(`jev: ${(e && e.message) || e}`)
  }

  /**
   * One Jev request through the cap, the counters and the log. Validation and cap refusals are not
   * counted (they cost nothing); a failed HTTP call is, with its error. `caller` is the plugin id
   * from ctx.services.caller() (set by the app, not by the caller), or 'cli'.
   */
  async function run(state, questions, { caller, label, signal, timeout } = {}) {
    const cfg = client.resolveConfig(app())
    const refusal = capRefusal(await counters.month(), caps(), {
      isOpenRouter: cfg.isOpenRouter,
      inflight,
      month: monthOf(),
    })
    if (refusal) throw new client.JevError(refusal)
    inflight += 1
    const record = {
      ts: new Date().toISOString(),
      caller,
      label,
      endpoint: cfg.endpoint,
      model: cfg.model,
      questions: Object.entries(questions).map(([id, q]) => ({
        id,
        type: q.type,
        text: q.instructions.slice(0, QUESTION_TEXT_MAX),
      })),
    }
    try {
      const r = await client.call(cfg, state, questions, { timeoutMs: timeout || timeoutMs(), signal })
      const { cost, costEstimated } = client.costOf(cfg, r.tokens, r.reportedCost)
      Object.assign(record, {
        model: r.resp.model || cfg.model,
        tokens: r.tokens,
        cost,
        costEstimated,
        ms: r.ms,
        answers: Object.fromEntries(Object.entries(r.resp.answers).map(([id, a]) => [id, client.summarizeAnswer(a)])),
      })
      return { answers: r.resp.answers, model: record.model, tokens: r.tokens, cost, costEstimated, ms: r.ms }
    } catch (e) {
      Object.assign(record, { tokens: 0, cost: null, error: String((e && e.message) || e).slice(0, 300) })
      throw e
    } finally {
      // Counted before `inflight` drops, so the next cap check sees this request one way or the other.
      await counters.add(record, caller).catch((e) => ctx.log.error(`usage counters: ${e.message}`))
      await usage.append(record).catch((e) => ctx.log.error(`usage log write failed: ${e.message}`))
      inflight -= 1
      pushPanel()
    }
  }

  // caller() is read first thing in each method: it holds for the whole call, but reading it up
  // front keeps it obvious which call it belongs to.
  const callerOrUnknown = () => ctx.services.caller() || 'unknown'

  const service = {
    async ask(request) {
      const caller = callerOrUnknown()
      try {
        if (!request || typeof request !== 'object') throw new client.JevError('ask(request): request must be { state, questions }')
        const questions = client.validateQuestions(request.questions)
        const state = client.validateState(request.state)
        return await run(state, questions, { caller, label: client.validateLabel(request.label) })
      } catch (e) {
        fail(e)
      }
    },

    async grid(items, questions, options) {
      const caller = callerOrUnknown()
      try {
        const opts = options && typeof options === 'object' ? options : {}
        const qs = client.validateQuestions(questions)
        const list = client.validateItems(items)
        const label = client.validateLabel(opts.label)
        const min = opts.min === undefined ? 0 : Number(opts.min)
        if (!(min >= 0 && min <= 1)) throw new client.JevError('grid: min must be a number in 0..1')
        const skip = opts.skip === undefined ? [] : opts.skip
        if (!Array.isArray(skip) || !skip.every((s) => typeof s === 'string')) {
          throw new client.JevError('grid: skip must be an array of choice names')
        }
        const workers = Math.min(GRID_WORKERS_MAX, Math.max(1, Math.floor(Number(opts.workers) || GRID_WORKERS)))

        // One request per item, never several items in one state: the reference measured that
        // positional indexing and unrelated items as distractors both cost accuracy.
        const results = {}
        const stats = { items: list.length, errors: 0, tokens: 0, cost: 0, ms: 0 }
        let costed = false
        const t0 = Date.now()
        let next = 0
        const worker = async () => {
          while (next < list.length) {
            const item = list[next++]
            try {
              const r = await run(item.state, qs, { caller, label })
              results[item.id] = { answers: client.filterAnswers(r.answers, { min, skip }) }
              stats.tokens += r.tokens
              if (r.cost !== null) {
                stats.cost += r.cost
                costed = true
              }
            } catch (e) {
              stats.errors += 1
              results[item.id] = { error: String((e && e.message) || e) }
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(workers, list.length) }, worker))
        stats.ms = Date.now() - t0
        if (!costed) stats.cost = null // off OpenRouter, or nothing succeeded: no dollar figure
        return { results, stats }
      } catch (e) {
        fail(e)
      }
    },
  }
  ctx.services.provide('jev', service)

  // ---- balance (OpenRouter only) ----

  async function refreshBalance() {
    if (refreshing) return refreshing
    refreshing = (async () => {
      setHeader(true)
      try {
        await refreshBalanceOnce()
      } finally {
        refreshing = null
        setHeader(false)
      }
    })()
    return refreshing
  }
  let refreshing = null

  async function refreshBalanceOnce() {
    let cfg
    try {
      cfg = client.resolveConfig(app())
    } catch {
      return
    }
    if (!cfg.isOpenRouter) return
    try {
      const b = await client.balance(cfg)
      balanceState = { value: b, ts: Date.now(), error: null }
    } catch (e) {
      balanceState = { value: balanceState.value, ts: Date.now(), error: e.message }
      ctx.log.warn(`balance: ${e.message}`)
    }
    pushPanel()
  }
  disposers.push(ctx.schedule(BALANCE_EVERY_S, refreshBalance))

  // ---- panel ----

  // The panel's title bar (cc-cockpit 0.9.0+, ctx.panels.header): Refresh as a ↻ icon that spins
  // while the balance is read. Feature-detected: on an older app the page keeps its own button.
  const coreHeader = typeof ctx.panels.header === 'function'
  function setHeader(busy) {
    if (!coreHeader) return
    try {
      ctx.panels.header(PANEL, { actions: [{ id: 'refresh', icon: 'refresh', title: 'Refresh the usage and the balance', busy: Boolean(busy) }] })
    } catch (e) {
      ctx.log.warn(`panel header: ${(e && e.message) || e}`)
    }
  }
  if (coreHeader) {
    setHeader(false)
    disposers.push(
      ctx.panels.onAction(PANEL, (id) => {
        if (id !== 'refresh') return
        // A click always reads the balance again (the page's own refresh only when it is stale).
        void refreshBalance()
        pushPanel()
      }),
    )
  }

  async function snapshot() {
    let config
    try {
      const cfg = client.resolveConfig(app())
      config = { ok: true, endpoint: cfg.endpoint, baseUrl: cfg.baseUrl, model: cfg.model, isOpenRouter: cfg.isOpenRouter }
    } catch (e) {
      const endpoint = app().endpoint || 'openrouter'
      config = { ok: false, error: e.message, endpoint, isOpenRouter: endpoint === 'openrouter' }
    }
    const month = monthOf()
    const all = await counters.month()
    return {
      type: 'state',
      config,
      caps: caps(),
      month,
      all,
      project: await usage.projectTotals(),
      byCaller: await counters.byCaller(),
      recent: await usage.recent(RECENT),
      balance: config.isOpenRouter ? balanceState : null,
      refusal: capRefusal(all, caps(), { isOpenRouter: !!config.isOpenRouter, month }),
      // The title bar has the title and ↻: the page leaves out its own row.
      coreHeader,
    }
  }

  // post() drops a message when no page is connected, so the page asks first ({ type: 'refresh' }
  // on load) and pushes after that only refresh an open panel. Debounced: a grid of 500 items
  // would otherwise post 500 snapshots.
  let pushTimer = null
  function pushPanel() {
    if (pushTimer) return
    pushTimer = setTimeout(async () => {
      pushTimer = null
      try {
        const s = await snapshot()
        ctx.panels.post(PANEL, s)
        ctx.badge(PANEL, s.refusal ? 'dot' : null)
      } catch (e) {
        ctx.log.warn(`panel update failed: ${(e && e.message) || e}`)
      }
    }, 300)
  }
  disposers.push(() => pushTimer && clearTimeout(pushTimer))

  disposers.push(
    ctx.panels.onMessage(PANEL, (message) => {
      if (!message || message.type !== 'refresh') return
      if (Date.now() - balanceState.ts > BALANCE_STALE_MS) refreshBalance()
      pushPanel()
    }),
  )

  // ---- ccc jev ----

  ctx.cli.register('jev', async (argv, { stdin, signal }) => {
    const [sub = 'usage', ...rest] = argv
    if (sub === 'help' || sub === '-h' || rest.includes('--help')) return { stdout: HELP }
    if (sub === 'usage') {
      return { stdout: formatUsage(await snapshot()) }
    }
    if (sub === 'balance') {
      let cfg
      try {
        cfg = client.resolveConfig(app())
      } catch (e) {
        return { stderr: `jev: ${e.message}\n`, code: 1 }
      }
      if (!cfg.isOpenRouter) return { stderr: 'jev: balance is OpenRouter-only\n', code: 1 }
      await refreshBalance()
      if (balanceState.error) return { stderr: `jev: ${balanceState.error}\n`, code: 1 }
      return { stdout: JSON.stringify(balanceState.value, null, 1) + '\n' }
    }
    if (sub === 'ask') {
      let req
      try {
        req = JSON.parse(stdin)
      } catch {
        return { stderr: 'jev ask: stdin must be a JSON request { state, questions }\n', code: 2 }
      }
      try {
        const questions = client.validateQuestions(req && req.questions)
        const state = client.validateState(req && req.state)
        const label = client.validateLabel((rest[0] === '--label' && rest[1]) || (req && req.label) || null)
        const r = await run(state, questions, {
          caller: CLI_CALLER,
          label,
          signal,
          timeout: Math.min(timeoutMs(), CLI_TIMEOUT_MS),
        })
        const cost = r.cost === null ? 'cost n/a' : `$${r.cost.toFixed(6)}${r.costEstimated ? ' (est)' : ''}`
        return {
          stdout: JSON.stringify(r.answers, null, 1) + '\n',
          stderr: `jev: ${r.model} ${r.tokens} tok ${cost} ${r.ms}ms\n`,
        }
      } catch (e) {
        return { stderr: `jev: ${e.message}\n`, code: 1 }
      }
    }
    return { stderr: `jev: unknown subcommand "${sub}"\n\n${HELP}`, code: 2 }
  })

  refreshBalance()
  ctx.log.info('activated: providing service "jev" v1')
}

function money(v, digits = 4) {
  return typeof v === 'number' ? `$${v.toFixed(digits)}` : 'n/a'
}

function formatUsage(s) {
  const lines = []
  const c = s.config
  lines.push(c.ok ? `endpoint: ${c.endpoint} ${c.baseUrl}  model: ${c.model}` : `endpoint: ${c.endpoint} (not usable: ${c.error})`)
  const costOf = (x) => (c.isOpenRouter ? money(x.cost) : 'cost n/a')
  for (const [name, x] of [['all projects', s.all], ['this project', s.project]]) {
    lines.push(`${s.month} ${name}: ${x.requests} requests (${x.errors} failed), ${x.tokens} tokens, ${costOf(x)}`)
  }
  for (const r of s.byCaller) {
    lines.push(`  ${r.caller}: ${r.requests} requests, ${r.tokens} tokens${c.isOpenRouter ? `, ${money(r.cost)}` : ''}`)
  }
  const caps = []
  if (s.caps.usd > 0) caps.push(`$${s.caps.usd}${c.isOpenRouter ? '' : ' (OpenRouter only, not applied)'}`)
  if (s.caps.requests > 0) caps.push(`${s.caps.requests} requests`)
  if (s.caps.tokens > 0) caps.push(`${s.caps.tokens} tokens`)
  lines.push(`caps: ${caps.length ? caps.join(', ') : 'none'}${s.refusal ? '  REACHED' : ''}`)
  if (s.balance && s.balance.value) lines.push(`balance: ${money(s.balance.value.balance)}`)
  lines.push('recent (this project):')
  for (const r of s.recent) {
    const q = (r.questions || []).map((x) => x.id).join(',')
    const a = r.error ? `error: ${r.error}` : Object.values(r.answers || {}).join(', ')
    const who = [r.caller, r.label].filter(Boolean).join('/') || '-'
    lines.push(`  ${r.ts}  ${who}  ${q} -> ${a}  ${r.cost == null ? `${r.tokens || 0} tok` : money(r.cost, 6)}`)
  }
  return lines.join('\n') + '\n'
}

exports.deactivate = () => {
  for (const d of disposers) {
    try {
      if (typeof d === 'function') d()
    } catch {
      // a disposer of a reloading host has nothing left to clean up
    }
  }
  disposers = []
}
