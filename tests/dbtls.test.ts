// DB への接続の TLS（#164）：DB_SSL・DB_SSL_CA・DB_SSL_VERIFY。UI（components/dbtls.ts）と migration（db/migrate.mjs）で同じ規則
import { describe, expect, it } from 'vitest';
import { DbTlsError, dbSslOptions } from '@/components/dbtls';
import { dbSsl } from '../db/migrate.mjs';

const read = (path: string) => {
  if (path === '/etc/rproxy-ui/db-ca.pem') return 'PEM';
  throw new Error('ENOENT');
};

const CASES: [Record<string, string>, unknown][] = [
  [{}, undefined],
  [{ DB_SSL: 'false' }, undefined],
  [{ DB_SSL: ' ' }, undefined],
  [{ DB_SSL: 'true' }, { rejectUnauthorized: true }],
  [{ DB_SSL: 'ON' }, { rejectUnauthorized: true }],
  [{ DB_SSL: '1', DB_SSL_VERIFY: 'false' }, { rejectUnauthorized: false }],
  [{ DB_SSL_CA: '/etc/rproxy-ui/db-ca.pem' }, { ca: 'PEM', rejectUnauthorized: true }],
  [{ DB_SSL: 'yes', DB_SSL_CA: '/etc/rproxy-ui/db-ca.pem', DB_SSL_VERIFY: 'true' }, { ca: 'PEM', rejectUnauthorized: true }],
];

const BAD: Record<string, string>[] = [
  { DB_SSL: 'maybe' },
  { DB_SSL: 'true', DB_SSL_VERIFY: 'sometimes' },
  { DB_SSL: 'false', DB_SSL_CA: '/etc/rproxy-ui/db-ca.pem' },
  { DB_SSL_CA: '/nonexistent.pem' },
];

describe('DB TLS', () => {
  it.each(CASES)('%j', (env, want) => {
    expect(dbSslOptions(env, read)).toEqual(want);
    expect(dbSsl(env, read)).toEqual(want);
  });

  it('refuses wrong values (the UI stops at startup)', () => {
    for (const env of BAD) {
      expect(() => dbSslOptions(env, read), JSON.stringify(env)).toThrow(DbTlsError);
      expect(() => dbSsl(env, read), JSON.stringify(env)).toThrow();
    }
  });

  it('does not put the CA path into the options', () => {
    expect(JSON.stringify(dbSslOptions({ DB_SSL_CA: '/etc/rproxy-ui/db-ca.pem' }, read))).not.toContain('/etc/');
  });
});
