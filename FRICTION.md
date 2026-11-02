# Friction log

Each entry is one place where the guide was unclear or wrong, an API was missing, or I had to guess,
found while building `bronos.jev` (and the since-removed `bronos.jev-demo`) using only `ccc guide` and
the `ccc` plugin commands.

Status after the app's friction round 1 (v0.3.0, re-checked 2026-11-02 against the new guide and
the running app):

- **Fixed**: the guide or the app now answers it, and the plugin uses the answer.
- **Fixed, not verified**: the guide says so, but I couldn't check it from here.
- **Open**: still a gap.

## Open

- `dev-loop`: still no way to test a plugin's host code headless. The guide says "test pure logic
  outside the app; the host API is plain objects". I keep my own fake `ctx` (`test/host.test.js`,
  `test/fake-app-storage.js`), written from the `api` topic. A published fake or test kit, or
  `ccc plugin test`, would keep such fakes honest as the API grows (`appStorage`, `caller()`,
  `overlay.start` all arrived in this round).
- `cli` (new, small): `ccc help` still describes `plugin new` as "scaffold ... in an empty folder", but
  `ccc guide dev-loop` says it now accepts a folder that already holds files and refuses only on
  files it would overwrite. That's how it behaves.
- `api` (new, small): the `ctx.appStorage` counters start with this version, so this month's 4 requests
  from before it are in the per-project log but not in the app-wide cap. Nothing to fix in the app;
  noted so the gap between "all projects" (lower) and "this project" in `ccc jev usage` is explained.

## Fixed

- `api` / settings: what `onSettingsChange` receives. The listener gets the whole frozen
  `{ project, app }` snapshot, and `ctx.settings` is replaced on save. The plugin now reads
  `ctx.settings.app` fresh on every use.
- `api`: `ctx.panels.onMessage` returns a disposer, and its listeners survive panel reloads.
- `api` / `panels`: `ctx.panels.post` to a closed panel is dropped silently and never throws. The
  page asks first on load, which the plugin already did.
- `api`: the caller of a service. `ctx.services.caller()` gives the calling plugin's id, set by
  the app. The plugin records it per request and counts per caller (`ccc jev`, the panel's "By
  plugin"); `label` stays as a free note.
- `api` / services: limits. The guide now states there are none (no rate, size or timeout limit),
  and a provider caps its own callers. That is what `bronos.jev` does.
- `api` / data: an app-wide store. `ctx.appStorage` with atomic `increment`, plus `ctx.appDataDir`.
  The cap now uses app-wide counters. The derived `<data>/plugin-data/*/<pluginId>/` path is gone,
  as the guide asks ("don't derive others from the layout").
- `api` / data: concurrency across windows. `appStorage` calls are atomic in main, and get-then-set
  is not. The counters only use `increment`.
- `panels`: theme variables. The full list is documented. The panel now uses `--cc-fg-muted`,
  `--cc-fg-subtle`, `--cc-accent`, `--cc-status-ended`, `--cc-bg-error` and `--cc-surface-1`, with
  no hard-coded colours.
- `panels`: inline `<style>` is allowed, and the CSP is spelled out.
- `plugins`: known top-level manifest keys are listed. `description` is tolerated and ignored.
- `plugins`: help for several subcommands. Put the synopsis in `usage` and handle `help` and
  `<sub> --help` yourself. The plugin now does (`ccc jev help`, `ccc jev ask --help`).
- `settings-secrets`: what the form renders is documented. `enum` shows raw values; `oneOf` with
  `const` and `title` gives labels. The Endpoint field now shows "OpenRouter (https://openrouter.ai/api)"
  and the other two choices as readable labels.
- `settings-secrets`: conditional fields are not supported. Declare the field always and check
  it in the host, which is what the plugin does.
- `settings-secrets`: an unset secret is absent from the settings, never `''` or `null`.
- `api`: the host is Node 24 with `fetch` and the usual globals, and network access is plain Node.
- `api`: `require('./lib/x')` from `main` works, and is documented.
- `dev-loop`: nested plugin folders. The parent's watcher ignores a child with its own
  `plugin.json`; linking any plugin restarts the project's host (documented, matching the double
  `activated` I saw).
- `plugins`: offline types are available through `ccc guide types` (482 lines).
- `cli` / `dev-loop`: configuring from a session. `ccc plugin config <id> key=value` works (checked:
  it prints the settings with the key shown only as `set`). Secrets stay in Settings, by design.
- `cli`: `ccc panel show <plugin>/<panel>` works (checked: "showing bronos.jev/main").
- `dev-loop`: the `[...]` log prefix is the project id, now documented.
- `cli` / `dev-loop` (was an app bug): a command sent during a plugin reload hung for over 120 s.
  Now a command run right after an edit waits for the reloaded copy. Checked: three reloads while
  editing, and every following `ccc jev` call answered at once.
- Scaffold: `dist/host.js` indentation is consistent now (checked with a fresh `ccc plugin new`).
- Scaffold: nested order. `ccc plugin new` works child-first too (checked).

## Fixed, not verified

- `settings-secrets` (was the first blocker): the keyring under Hyprland. The guide says the app now
  uses the Secret Service on its own when it is on the session bus. Not verified: this app still
  starts through `~/.local/share/applications/cc-cockpit.desktop`, which adds
  `--password-store=gnome-libsecret`. To check, delete that file, restart the app from the launcher,
  and see that the key in Settings > Plugins > Jev still shows "Set".
- `plugins` / `panels`: the plugin icon renders black. Icons are now a single-colour mask in the
  strip's text colour (theme, hover, open state), and that is documented. `icons/jev.svg` is a
  single-colour outline in a 24×24 viewBox, as recommended. Needs a look at the icon strip.

## Outside the app (Jev / TypeSafe)

- The reference client never builds a `score` question, so its extra fields (range? scale?) are
  unknown. `validateQuestions` passes extra keys through, capped at 2 KB.
- The TypeSafe direct model id is unknown: OpenRouter uses `typesafe/jev-1.13`, and the web suggests
  `jev-latest` for direct use. The model setting is free text and its description says so.
