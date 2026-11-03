'use strict'
// The Jev panel: usage this month and the last requests. The host owns all data and posts a
// `{ type: 'state' }` snapshot; this page only renders it. Everything from the host is written
// with textContent (question text comes from other plugins), never as HTML.

const $ = (id) => document.getElementById(id)

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

const money = (v, digits = 4) => (typeof v === 'number' ? `$${v.toFixed(digits)}` : 'n/a')
const int = (v) => (typeof v === 'number' ? v.toLocaleString() : '0')

function when(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function capLine(label, used, cap, fmt) {
  const box = el('div')
  const row = el('div', 'row')
  row.append(el('span', null, label), el('span', null, `${fmt(used)} of ${fmt(cap)}`))
  const ratio = cap > 0 ? used / cap : 0
  const bar = el('div', ratio >= 1 ? 'bar full' : 'bar')
  const fill = el('div')
  fill.style.width = `${Math.min(100, ratio * 100)}%`
  bar.append(fill)
  box.append(row, bar)
  return box
}

const kv = (k, v) => {
  const r = el('div', 'row')
  r.append(el('span', 'muted', k), el('span', null, v))
  return r
}

function render(s) {
  // On cc-cockpit 0.9.0+ the title bar carries the title and ↻ (the host sets it); this row goes.
  $('own-header').style.display = s.coreHeader ? 'none' : ''
  const c = s.config
  $('config').textContent = c.ok ? `${c.endpoint} · ${c.model}` : `Not configured: ${c.error}`

  const notice = $('notice')
  notice.replaceChildren()
  if (s.refusal) notice.append(el('div', 'warn', s.refusal))

  $('month-title').textContent = `This month (${s.month}, UTC)`
  const box = $('totals')
  box.replaceChildren()
  const all = s.all
  box.append(kv('Requests (all projects)', `${int(all.requests)}${all.errors ? ` · ${int(all.errors)} failed` : ''}`))
  box.append(kv('Requests (this project)', int(s.project.requests)))
  box.append(kv('Input tokens', int(all.tokens)))
  if (c.isOpenRouter) {
    box.append(kv('Cost', money(all.cost) + (all.estimatedRequests ? ` (${all.estimatedRequests} estimated)` : '')))
    const b = s.balance
    if (b && b.value && typeof b.value.balance === 'number') box.append(kv('OpenRouter balance', money(b.value.balance, 2)))
    else if (b && b.error) box.append(kv('OpenRouter balance', 'unavailable'))
  } else if (c.ok) {
    box.append(el('div', 'muted', 'Cost and balance are OpenRouter-only; counting requests and tokens.'))
  }
  if (s.caps.usd > 0 && c.isOpenRouter) box.append(capLine('Spending cap', all.cost, s.caps.usd, (v) => money(v, 2)))
  if (s.caps.requests > 0) box.append(capLine('Request cap', all.requests, s.caps.requests, int))
  if (s.caps.tokens > 0) box.append(capLine('Token cap', all.tokens, s.caps.tokens, int))

  // Per calling plugin, as the app reports it (ctx.services.caller()); 'cli' is `ccc jev ask`.
  const callers = $('callers')
  callers.replaceChildren()
  if (!s.byCaller.length) callers.append(el('div', 'muted', 'No requests this month.'))
  for (const r of s.byCaller) {
    callers.append(kv(r.caller, `${int(r.requests)} req${c.isOpenRouter ? ` · ${money(r.cost)}` : ` · ${int(r.tokens)} tok`}`))
  }

  const list = $('recent')
  list.replaceChildren()
  if (!s.recent.length) list.append(el('li', 'muted', 'No requests yet.'))
  for (const r of s.recent) {
    const li = el('li', r.error ? 'err' : '')
    const head = el('div', 'row muted')
    head.append(el('span', null, `${when(r.ts)} · ${[r.caller, r.label].filter(Boolean).join(' / ') || 'unknown'}`), el('span', null, r.cost == null ? `${int(r.tokens)} tok` : money(r.cost, 6)))
    li.append(head)
    for (const q of r.questions || []) {
      const line = el('div')
      line.append(el('div', 'q', `${q.id}: ${q.text}`))
      const ans = r.error ? `error: ${r.error}` : (r.answers && r.answers[q.id]) || '—'
      line.append(el('div', 'a', `→ ${ans}`))
      li.append(line)
      if (r.error) break // one error line per request is enough
    }
    list.append(li)
  }
}

ccPanel.onMessage((m) => {
  if (m && m.type === 'state') render(m)
})
$('refresh').addEventListener('click', () => ccPanel.post({ type: 'refresh' }))
ccPanel.post({ type: 'refresh' })
