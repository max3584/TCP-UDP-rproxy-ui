// keepalived のスクリプトから呼ぶ口（/api/forward/ha/ready・/api/forward/ha/notify。#109）の認証。
// Keycloak のセッションの代わりに、RPROXY_UI_HA_TOKEN_FILE のトークン（1 行に 1 つ。空行と # の行は読み飛ばす）を
// Authorization: Bearer で受け取る。ファイルはリクエストごとに読む（入れ替えても再起動は要らない）。
// この口でできるのは、揃っているかを読むことと、DB の定義をそのノードに送り直すことだけ（ルールは変えられない）
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { Logger } from './lib';

export type HaAuth = { ok: true } | { ok: false; status: number; code: string; error: string };

export function readHaTokens(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const UNAUTHORIZED: HaAuth = { ok: false, status: 401, code: 'unauthorized', error: 'トークンが違います。' };

export function checkHaToken(header: string | string[] | undefined, env: Record<string, string | undefined> = process.env): HaAuth {
  const path = (env.RPROXY_UI_HA_TOKEN_FILE ?? '').trim();
  if (path === '') return { ok: false, status: 404, code: 'ha_disabled', error: 'RPROXY_UI_HA_TOKEN_FILE を設定していないため、使えません。' };
  // Bearer のない要求は、ファイルを読む前に 401（認証の前に、ファイルのパスや読めない理由を返さない。#164）
  const value = Array.isArray(header) ? header[0] : header;
  const m = /^Bearer\s+(\S+)$/i.exec(value ?? '');
  if (!m) return UNAUTHORIZED;
  let tokens: string[];
  try {
    tokens = readHaTokens(path);
  } catch (err) {
    // 詳細（パスと理由）はログだけに出す
    Logger('error', { action: 'ha-token' }).error(`RPROXY_UI_HA_TOKEN_FILE（${path}）を読めません: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, status: 500, code: 'ha_token_file', error: 'HA の口のトークンを読めません（詳細は UI のログ）。' };
  }
  if (!tokens.some((t) => same(t, m[1]))) return UNAUTHORIZED;
  return { ok: true };
}
