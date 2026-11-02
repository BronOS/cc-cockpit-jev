'use strict'
// An in-memory ctx.appStorage, per `ccc guide api`: JSON values, increment(key, by) atomic and
// rejecting on a non-number. Shared between fake hosts to stand for two project windows.
function fakeAppStorage() {
  const m = new Map()
  return {
    map: m,
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined },
    async set(k, v) { m.set(k, structuredClone(v)) },
    async delete(k) { m.delete(k) },
    async keys() { return [...m.keys()] },
    async increment(k, by = 1) {
      if (!Number.isFinite(by)) throw new Error('by must be a finite number')
      const cur = m.has(k) ? m.get(k) : 0
      if (typeof cur !== 'number') throw new Error(`${k} is not a number`)
      m.set(k, cur + by)
      return cur + by
    },
  }
}
module.exports = { fakeAppStorage }
