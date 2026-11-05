# Jev for cc-cockpit

`bronos.jev` wraps Jev, TypeSafe's cheap typed classifier, as the `jev` plugin service (v1). Other
plugins in a project can ask it choice questions (yes/no probability, pick one of named options,
score). It only answers typed questions: there is no free-form text generation and no other model
route.

Plain JavaScript, no build step. `npm test` runs the unit tests (node:test, no dependencies).

## Use it from another plugin

```json
"services": { "uses": { "jev": 1 } }
```

```js
const jev = ctx.services.use('jev')
// one request (TypeSafe's POST <base>/v1/systemone body minus the model)
const r = await jev.ask({
  state: 'the text to judge',
  questions: { fail: { type: 'noul', instructions: 'Does this report a failure?' } },
  label: 'my-plugin', // optional, shows in the usage log
})
r.answers.fail.noul // 0..1;  r.tokens, r.cost (null off OpenRouter), r.costEstimated, r.ms, r.model

// the same questions over many items, one request per item
const g = await jev.grid([{ id: 'a', text: '...' }, { id: 'b', text: '...' }], questions, { min: 0.5, skip: ['none'], workers: 8 })
g.results.a.answers // or g.results.a.error;  g.stats = { items, errors, tokens, cost, ms }
```

Question types: `noul` `{ type, instructions }`; `choice` `{ type, instructions, criteria: { name: description } }`
(2..64 criteria); `score` `{ type, instructions, ... }`. Limits: 32 questions, a 200,000-character state,
2,000 grid items. `min` drops nouls below it, and `skip` drops choices with those names. Errors reject with
`jev: <reason>`, for example a cap reached, no API key, or `HTTP 4xx: ...`. 429 and 5xx are retried within
the timeout.

Call it from a command or after `activate` has returned, not during `activate` (`ccc guide api`, cycles).

## Settings (app-wide)

- Endpoint: `openrouter` (https://openrouter.ai/api), `typesafe` (TypeSafe direct,
  https://api.typesafe.ai), or `custom` (with Custom base URL; https, or http to localhost).
- API key (a secret field), Model (default `typesafe/jev-1.14`), Request timeout.
- Monthly spending cap in dollars (default $5). It counts the cost OpenRouter reports, so it works on OpenRouter only.
  The monthly request cap and token cap work on any endpoint; 0 turns a cap off.

Caps count the current UTC month across every project window. They are app-wide counters in
`ctx.appStorage`, raised with its atomic `increment`. Requests are refused once a cap is reached.
A host's in-flight requests count toward it, so a parallel grid cannot overshoot.

## Usage log

- **App-wide counters** (`ctx.appStorage`): this month's requests, failures, tokens and cost, in
  total and per calling plugin. The caller is `ctx.services.caller()`, set by the app, or `cli` for
  `ccc jev ask`. The cap is checked against these counters.
- **Per-project log**: one JSON line per request in `<plugin data dir>/usage-YYYY-MM.jsonl`. Each line
  holds the time, caller, optional label, model, question ids with the first 160 characters of each
  question, a one-line answer summary, tokens, cost and duration. The judged text (`state`) is never
  logged.

Cost and balance are OpenRouter-only. Elsewhere, cost is `null` and only requests and tokens are
counted.

## Panel and CLI

- The Jev panel (right zone) shows this month's usage, the caps, the OpenRouter balance and the last 10
  requests of this project, plus a "By plugin" breakdown. Its icon shows a dot while a cap is reached.
- `ccc jev [usage]`, `ccc jev balance`, `ccc jev ask [--label L] < request.json`, `ccc jev help`.
- `ccc plugin config bronos.jev monthlyCapUsd=20` changes a setting from a tab. The API key can only be set in Settings > Plugins.

See FRICTION.md for where the cc-cockpit guide fell short while building this.
