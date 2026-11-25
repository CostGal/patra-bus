// TEL-407: the Durable Object classes behind the counters and the delay stats, run for real.
// CountersBase gets a real SQLite (node:sqlite) behind the same `storage.sql.exec(...).toArray()` shape as Cloudflare.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CountersBase } from '../worker/src/counters.js';
import { StatsBase } from '../worker/src/stats.js';

function sqlStorage() {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query, ...binds) {
      const stmt = db.prepare(query);
      const rows = /^\s*SELECT/i.test(query) ? stmt.all(...binds).map((r) => ({ ...r })) : (stmt.run(...binds), []);
      return { toArray: () => rows };
    },
  };
}

function kvStorage() {
  const m = new Map();
  return {
    puts: 0,
    get: async (k) => structuredClone(m.get(k)),
    async put(k, v) { this.puts++; m.set(k, structuredClone(v)); },
  };
}

const post = (body) => new Request('https://do/', { method: 'POST', body: JSON.stringify(body) });
const get = () => new Request('https://do/');

test('CountersBase: empty table answers no rows', async () => {
  const c = new CountersBase({ storage: { sql: sqlStorage() } }, {});
  assert.deepEqual(await (await c.fetch(get())).json(), { rows: [] });
});

test('CountersBase: each POST adds 1 to its own (day, metric, city) row', async () => {
  const c = new CountersBase({ storage: { sql: sqlStorage() } }, {});
  for (const e of [
    { day: '2026-11-25', metric: 'open', city: 'patra' },
    { day: '2026-11-25', metric: 'open', city: 'patra' },
    { day: '2026-11-25', metric: 'open', city: 'corfu' },
    { day: '2026-11-24', metric: 'install', city: '' },
  ]) assert.equal((await c.fetch(post(e))).status, 200);
  assert.deepEqual((await (await c.fetch(get())).json()).rows, [
    { day: '2026-11-24', metric: 'install', city: '', n: 1 },
    { day: '2026-11-25', metric: 'open', city: 'corfu', n: 1 },
    { day: '2026-11-25', metric: 'open', city: 'patra', n: 2 },
  ]);
});

test('CountersBase: the table survives a new instance on the same storage', async () => {
  const sql = sqlStorage();
  await new CountersBase({ storage: { sql } }, {}).fetch(post({ day: '2026-11-25', metric: 'feedback', city: 'patra' }));
  const rows = (await (await new CountersBase({ storage: { sql } }, {}).fetch(get())).json()).rows;
  assert.equal(rows.length, 1);
});

for (const [name, body] of [
  ['unknown metric', { day: '2026-11-25', metric: 'clicks', city: 'patra' }],
  ['unknown city', { day: '2026-11-25', metric: 'open', city: 'athens' }],
  ['bad day', { day: '25/11/2026', metric: 'open', city: 'patra' }],
  ['free text as day', { day: "2026-11-25'; DROP TABLE counts; --", metric: 'open', city: 'patra' }],
]) {
  test(`CountersBase: ${name} is refused with 400 and stores nothing`, async () => {
    const c = new CountersBase({ storage: { sql: sqlStorage() } }, {});
    const res = await c.fetch(post(body));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'bad_request' });
    assert.deepEqual((await (await c.fetch(get())).json()).rows, []);
  });
}

test('CountersBase and StatsBase: other methods get 405', async () => {
  const c = new CountersBase({ storage: { sql: sqlStorage() } }, {});
  const s = new StatsBase({ storage: kvStorage() }, {});
  for (const o of [c, s]) {
    const res = await o.fetch(new Request('https://do/', { method: 'DELETE' }));
    assert.equal(res.status, 405);
  }
});

const NOW = Date.now();
const veh = (vehicleCode, live, etaSec) => ({ vehicleCode, live, etaSec });

test('StatsBase: no data yet gives null stats', async () => {
  const s = new StatsBase({ storage: kvStorage() }, {});
  const body = await (await s.fetch(get())).json();
  assert.equal(body.samples, 0);
  assert.equal(body.medianDelaySec, null);
});

test('StatsBase: scheduled then live sighting records one delay and GET shows it', async () => {
  const storage = kvStorage();
  const s = new StatsBase({ storage }, {});
  const r1 = await (await s.fetch(post({ fetchedAt: NOW - 1000000, vehicles: [veh('A', false, 1200)] }))).json();
  assert.deepEqual(r1, { ok: true, recorded: 0 });
  const r2 = await (await s.fetch(post({ fetchedAt: NOW, vehicles: [veh('A', true, 250)] }))).json();
  assert.deepEqual(r2, { ok: true, recorded: 1 });
  const body = await (await s.fetch(get())).json();
  assert.equal(body.samples, 1);
  assert.equal(body.medianDelaySec, 50);
});

test('StatsBase: a POST that changes nothing does not write storage', async () => {
  const storage = kvStorage();
  const s = new StatsBase({ storage }, {});
  await s.fetch(post({ fetchedAt: NOW, vehicles: [] }));
  assert.equal(storage.puts, 0);
});
