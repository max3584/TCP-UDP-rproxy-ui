import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_GRANTS, parseArgs, planMigrations, readMigrations, sha256 } from '../db/migrate.mjs';

const files = readMigrations();

describe('db/migrate.mjs', () => {
  it('reads migrations/ in number order with checksums', () => {
    expect(files.map((f: { number: number }) => f.number)).toEqual([...files.map((f: { number: number }) => f.number)].sort((a, b) => a - b));
    expect(files[0].version).toBe('001_initial');
    expect(files.some((f: { version: string }) => f.version === '012_rproxy_rule_sets')).toBe(true);
    const first = files[0];
    expect(first.checksum).toBe(sha256(readFileSync('db/migrations/001_initial.sql', 'utf8')));
  });

  it('a new database gets schema.sql and every migration recorded as schema', () => {
    const plan = planMigrations({ files, applied: [], hasForwardRules: false });
    expect(plan.error).toBeUndefined();
    expect(plan.schema).toBe(true);
    expect(plan.steps.map((s: { version: string }) => s.version)).toEqual(files.map((f: { version: string }) => f.version));
    expect(plan.steps.every((s: { method: string }) => s.method === 'schema')).toBe(true);
  });

  it('an existing database without schema_migrations needs --baseline', () => {
    const plan = planMigrations({ files, applied: [], hasForwardRules: true });
    expect(plan.error).toContain('--baseline');
    expect(plan.steps).toEqual([]);
  });

  it('--baseline records up to the number and applies the rest', () => {
    const plan = planMigrations({ files, applied: [], hasForwardRules: true, baseline: 9 });
    const by = Object.fromEntries(plan.steps.map((s: { version: string; method: string }) => [s.version, s.method]));
    expect(by['001_initial']).toBe('baseline');
    expect(by['009_rproxy_rules']).toBe('baseline');
    expect(by['010_usage']).toBe('applied');
    expect(by['012_rproxy_rule_sets']).toBe('applied');
    expect(plan.schema).toBe(false);
  });

  it('003 (a one-time manual template) is recorded but never run', () => {
    const plan = planMigrations({ files, applied: [], hasForwardRules: true, baseline: 2 });
    expect(plan.steps.find((s: { version: string }) => s.version.startsWith('003_'))?.method).toBe('skipped');
    expect(plan.steps.find((s: { version: string }) => s.version.startsWith('004_'))?.method).toBe('applied');
  });

  it('a second run has nothing to do; a new file is pending', () => {
    const applied = files.map((f: { version: string; checksum: string }) => ({ version: f.version, checksum: f.checksum }));
    expect(planMigrations({ files, applied, hasForwardRules: true }).steps).toEqual([]);
    const fewer = applied.slice(0, -1);
    const plan = planMigrations({ files, applied: fewer, hasForwardRules: true });
    expect(plan.steps.map((s: { version: string }) => s.version)).toEqual([files[files.length - 1].version]);
  });

  it('a changed applied migration is a warning, not an error', () => {
    const applied = files.map((f: { version: string; checksum: string }, i: number) => ({ version: f.version, checksum: i === 1 ? 'x'.repeat(64) : f.checksum }));
    const plan = planMigrations({ files, applied, hasForwardRules: true });
    expect(plan.error).toBeUndefined();
    expect(plan.warnings.join('\n')).toContain(files[1].version);
  });

  it('parses its arguments', () => {
    expect(parseArgs(['--baseline', '012', '--wait', '60', '--create-database'])).toMatchObject({ baseline: 12, wait: 60, createDatabase: true });
    expect(() => parseArgs(['--baseline'])).toThrow();
    expect(() => parseArgs(['--nope'])).toThrow();
  });

  it('grants the UI user what db/README.md lists', () => {
    const readme = readFileSync('db/README.md', 'utf8');
    for (const [table, privs] of APP_GRANTS) {
      expect(readme).toMatch(new RegExp(`GRANT ${privs}\\s+ON rproxy\\.${table}\\s+TO 'rproxy_ui'`));
    }
  });

  it('schema.sql has every table the migrations create', () => {
    const schema = readFileSync('db/schema.sql', 'utf8');
    const created = new Set<string>();
    for (const f of files) for (const m of f.sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)) created.add(m[1]);
    for (const t of created) expect(schema).toContain(`CREATE TABLE IF NOT EXISTS ${t} (`);
    // 011 の attr と 006 の target も schema.sql にある
    expect(schema).toMatch(/attr\s+CHAR\(64\)/);
    expect(schema).toMatch(/target\s+VARCHAR\(32\)/);
  });
});
