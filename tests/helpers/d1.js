// A small stand-in for Cloudflare D1 on top of Node's built-in SQLite, enough to run the
// Worker's real SQL in tests: prepare().bind().first/all/run, and batch() as one transaction.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

class Statement {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.db, this.sql, args); }
  _run() { return this.db.prepare(this.sql).run(...this.args); }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async run() { const r = this._run(); return { meta: { changes: r.changes } }; }
}

export function makeD1() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../../worker/migrations/', import.meta.url);
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) db.exec(fs.readFileSync(new URL(f, dir), 'utf8'));
  return {
    raw: db,
    prepare: sql => new Statement(db, sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map(s => s._run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
