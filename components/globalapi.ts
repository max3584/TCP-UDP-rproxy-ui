// global の設定の API route（pages/api/forward/global.ts）が rproxy の断りを画面に返す形。サーバ側だけで使う。
// - rproxy の断りのコード（static・restart_only・in_use・protected_file）は、ルールの同じ名前のコード（固定ルールの static など）と区別して global_* にする
// - Unix ソケットだけの項目（rproxy の unix_only。既定で crowdsec など）を TCP から変えようとした 403 は global_unix_only
//   （rproxy の文の「Unix socket」で見分ける。どの項目が Unix ソケットだけかは rproxy の版で変わるので UI は決め打ちしない）
// - 古い rproxy（GET / PATCH /config/global がない 404）は global_unsupported
// 画面の説明は components/messages.ts の EXPLAIN（global_*）。error は rproxy の文（explainError が「詳細」に付ける）
// - 知らないコード・ステータスは rproxy の文のまま返す（rproxy の版で断りが増えても画面に理由が出るように）。
//   rproxy の 401・スコープの不足の 403・429・届かない・5xx（503 を除く）は UI のトークン・設定の問題なので 502
//   （502 crowdsec_unavailable（新しい LAPI が答えない）もコードはそのまま。503 not_loaded・upgrading・shutting_down は 503 のまま）
import { rproxyFailure } from './apiguard';
import { GLOBAL_UNSUPPORTED_MESSAGE } from './messages';
import { UNIX_ONLY_MESSAGE } from './globalsettings';
import { RproxyError } from './rproxy';

export class GlobalRouteError extends Error {
  constructor(public readonly status: number, message: string, public readonly code: string) {
    super(message);
    this.name = 'GlobalRouteError';
  }
}

const RENAMED: Record<string, string> = {
  static: 'global_static',
  restart_only: 'global_restart_only',
  in_use: 'global_in_use',
  // アクセスログの場所の制限も含む（ルールのファイルの protected_file と説明を分ける）
  protected_file: 'global_protected_file',
};

export function globalCode(code: string): string {
  return RENAMED[code] ?? code;
}

export function globalFailure(err: unknown): { status: number; error: string; code: string } {
  if (err instanceof GlobalRouteError) return { status: err.status, error: err.message, code: err.code };
  if (err instanceof RproxyError) {
    if (err.status === 403 && err.code === 'forbidden' && /unix socket/i.test(err.message)) {
      // rproxy の文は TCP でも受け付ける設定（守りを弱める）を勧めるので出さず、UI の説明（unix: の url）だけにする
      return { status: 403, error: UNIX_ONLY_MESSAGE, code: 'global_unix_only' };
    }
    if (err.status === 404) {
      return { status: 409, error: GLOBAL_UNSUPPORTED_MESSAGE, code: 'global_unsupported' };
    }
    if (err.status === 403 && err.code === 'forbidden') {
      return { status: 502, error: err.message, code: 'global_forbidden' };
    }
    const f = rproxyFailure(err);
    const uiSide = err.status === 0 || err.status === 401 || err.status === 429
      || (err.status >= 500 && err.status !== 503) || err.status < 400;
    return { status: uiSide ? 502 : err.status, error: f.error, code: globalCode(f.code) };
  }
  return { status: 500, error: err instanceof Error ? err.message : String(err), code: 'internal' };
}
