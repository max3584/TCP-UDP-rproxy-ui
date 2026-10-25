// DB（MariaDB）への接続の TLS（#164）。環境変数（db/migrate.mjs の dbSsl と同じ規則。tests/dbtls.test.ts）：
// - DB_SSL：true（1・yes・on）で TLS を使い、サーバの証明書を確かめる（OS の CA か DB_SSL_CA）。false（既定）なら使わない
// - DB_SSL_CA：サーバの証明書を確かめる CA の PEM のファイル（書けば DB_SSL を書かなくても TLS を使う）
// - DB_SSL_VERIFY：false にすると証明書を確かめない（試験用。勧めない）
// 誤った値は DbTlsError（起動時の確かめ・プールを作るときに止める）
import { readFileSync } from 'node:fs';

export class DbTlsError extends Error {}

export interface DbSslOptions {
  ca?: string;
  rejectUnauthorized: boolean;
}

function flag(name: string, value: string | undefined, fallback: boolean): boolean {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new DbTlsError(`${name} は true か false を書いてください: ${value}`);
}

// mariadb のドライバの ssl に渡す値。TLS を使わなければ undefined
export function dbSslOptions(env: Record<string, string | undefined> = process.env, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): DbSslOptions | undefined {
  const caPath = (env.DB_SSL_CA ?? '').trim();
  const on = flag('DB_SSL', env.DB_SSL, caPath !== '');
  if (!on) {
    if (caPath !== '') throw new DbTlsError('DB_SSL=false と DB_SSL_CA は一緒に書けません。');
    return undefined;
  }
  const verify = flag('DB_SSL_VERIFY', env.DB_SSL_VERIFY, true);
  let ca: string | undefined;
  if (caPath !== '') {
    try {
      ca = read(caPath);
    } catch (err) {
      throw new DbTlsError(`DB_SSL_CA（${caPath}）を読めません: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ...(ca !== undefined ? { ca: ca } : {}), rejectUnauthorized: verify };
}
