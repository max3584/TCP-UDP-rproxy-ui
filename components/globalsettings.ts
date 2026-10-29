// rproxy の global の設定（rproxy-api v0.4.19 の GET / PATCH /config/global、#342。UI #169）。
// 応答の形と画面の名前、PATCH の本文の組み立てと確かめ、取り消し（undo）の本文、フォームの欄の値と送る値の行き来。
// 項目の一覧・変え方（live / restart）・Unix ソケットだけか（unix_only）・今変えられるか（settable）は rproxy が返すものに従い、
// UI は知らない項目も JSON のまま出して編集できるようにする（rproxy の版で項目や制限が変わっても画面を直さずに済むように）。
// React と Node に依存しない（tests/globalsettings.test.ts）
import { parseCidr } from './cidr';

export type GlobalSource = 'file' | 'env' | 'api' | 'default';
export type GlobalApply = 'live' | 'restart';

// GET /config/global の items の 1 つ
export interface GlobalItem {
  value: unknown;
  source: GlobalSource | string;
  apply: GlobalApply | string;
  unix_only: boolean;
  settable: boolean;
  api_value?: unknown;
  shadowed?: boolean;
  // crowdsec：設定ファイルから消えたが、使うルールがあるので残している（source は file）
  kept?: boolean;
  // 再起動が要る項目の値は UI が出さない（acme の contact・directory・eab・DNS のプロバイダなど。/api/forward/acme と同じ考え方）。
  // redacted のときは value が null で、keys に一番上の項目の名前だけ
  redacted?: boolean;
  keys?: string[];
  // 値を効かせられなかった理由。API の値なら api_value は保存したまま（読めない値のこともある）。
  // 設定ファイルの crowdsec（新しい LAPI が答えない）なら value は今効いている前の値
  error?: string;
}

export interface GlobalWarning {
  code?: string;
  item?: string;
  message?: string;
}

export interface GlobalSettings {
  items: Record<string, GlobalItem>;
  storage: string;
  persisted: boolean | null;
  // 起動のときに保存した値（rproxy_global）を読めたか。false の間は PATCH が 503 not_loaded
  loaded: boolean;
  updated_by?: string | null;
  updated_at?: number | null;
  warnings: GlobalWarning[];
}

// PATCH の答えの changes の 1 つ
export interface GlobalChange {
  item: string;
  before: unknown;
  after: unknown;
  api_before: unknown;
  api_after: unknown;
}

// 画面の 1 ノード（GET /api/forward/global の nodes の 1 つ）
export interface GlobalNodeView {
  node: string;
  // UI からの制御 API の道（unix_only の項目は unix でなければ rproxy が断る）
  transport: 'unix' | 'tcp';
  // Kubernetes の rproxy（見るだけ）
  readonly: boolean;
  reachable: boolean;
  // features.global_api（false なら古い rproxy で、画面に項目を出さない）
  supported: boolean;
  settings: GlobalSettings | null;
  error: string | null;
  code: string | null;
}

// 1 ノードへの dry run・適用の結果（POST /api/forward/global の nodes の 1 つ）
export interface GlobalNodeResult {
  node: string;
  ok: boolean;
  // 適用のとき：applied（効いた）・refused（rproxy が断った）・unknown（時間切れで効いたか分からない）
  outcome?: 'applied' | 'refused' | 'unknown';
  changes?: GlobalChange[];
  applied?: string[];
  persisted?: boolean | null;
  storage?: string;
  error?: string;
  code?: string;
  undone?: boolean;
}

// 項目の画面の名前と説明（知らない項目は名前をそのまま出す）
export const GLOBAL_ITEM_LABELS: Record<string, { label: string; help: string }> = {
  trusted_proxies: { label: '信頼する前段のプロキシ', help: 'この範囲から来た接続の X-Forwarded-For などを信じます（1 行に 1 つの CIDR か IP）。新しいリクエストから効きます。' },
  access_log: { label: 'アクセスログのファイル', help: 'http のルールのアクセスログ（JSON Lines）を書くファイルの絶対パス。rproxy-api の RPROXY_API_ACCESS_LOG_DIR（rproxy のアクセスログだけのディレクトリ）のすぐ下だけです。空にするとメインのログに出します。次の行から効きます。' },
  crowdsec: { label: 'CrowdSec', help: 'LAPI の URL と API キーのファイル（絶対パス）。新しい接続・リクエストから効きます。' },
  'http.timeouts': { label: 'HTTP の接続の時間の上限', help: 'http のルールのクライアントの接続の時間の上限（10s・5m などの時間、0s は上限なし。空の欄は既定）。新しい接続から効きます。' },
  udp_max_sessions: { label: 'UDP のセッションの上限', help: 'UDP のルールごとのセッションの数の上限（既定の値）。新しいセッションから効き、今のセッションは切りません。' },
  acme: { label: 'ACME', help: '証明書の自動取得。設定ファイルで決め、再起動まで効きません。' },
  geoip: { label: 'GeoIP のデータベース', help: '設定ファイルで決め、再起動まで効きません。' },
  performance: { label: 'performance', help: 'ワーカーの数・UDP のソケットの数・CPU の固定・busy poll・splice・XDP。設定ファイルか環境変数で決め、再起動まで効きません。' },
  files: { label: 'ファイルの所有者の確かめ', help: '設定ファイルか環境変数で決め、再起動まで効きません。' },
  control_api: { label: '制御 API の待ち受け', help: 'RPROXY_API_ADDR・RPROXY_API_PORT・RPROXY_API_SOCKET。再起動まで効きません。' },
};

export const SOURCE_LABELS: Record<string, string> = {
  file: '設定ファイル',
  env: '環境変数',
  api: 'API',
  default: '既定',
};

// 設定ファイル・環境変数の項目は API で変えられない（固定のルールと同じ考え方）
export function fixedNote(source: string): string | null {
  if (source === 'file') return '設定ファイルで固定';
  if (source === 'env') return '環境変数で固定';
  return null;
}

export const HTTP_TIMEOUT_KEYS = ['tls_handshake', 'first_byte', 'request_headers', 'idle', 'request_body_idle', 'http2_ping_interval', 'http2_ping_timeout'];
export const CROWDSEC_KEYS = ['lapi_url', 'api_key_file', 'appsec_url', 'update_interval'];

export const UNIX_ONLY_MESSAGE =
  'この項目は rproxy の Unix ソケットからだけ変えられます。UI のこのノードの url を、rproxy-api の RPROXY_API_SOCKET のソケット（unix:/…）にしてください。';

// 項目の名前（http.timeouts など）を PATCH の本文の形（{"http": {"timeouts": …}}）にする
export function globalPatchBody(values: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [item, value] of Object.entries(values)) {
    const path = item.split('.');
    let at = body;
    for (const p of path.slice(0, -1)) {
      if (typeof at[p] !== 'object' || at[p] === null) at[p] = {};
      at = at[p] as Record<string, unknown>;
    }
    at[path[path.length - 1]] = value === undefined ? null : value;
  }
  return body;
}

export class GlobalPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlobalPatchError';
  }
}

const ITEM_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/;

// 画面からの値（項目の名前 → 値。null は API の値を消す）の形を確かめる。値の中身は rproxy が確かめる（400 invalid）
export function normalizeGlobalValues(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new GlobalPatchError('values は項目の名前と値の組にしてください。');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) throw new GlobalPatchError('変える項目を 1 つ以上選んでください。');
  if (entries.length > 32) throw new GlobalPatchError('項目が多すぎます。');
  const out: Record<string, unknown> = {};
  for (const [item, value] of entries) {
    if (!ITEM_NAME.test(item)) throw new GlobalPatchError(`項目の名前が正しくありません: ${item}`);
    out[item] = value === undefined ? null : value;
  }
  // http と http.timeouts のように重なる名前は、どちらが勝つかが本文の形で決まってしまうので断る
  const names = Object.keys(out);
  for (const a of names) {
    const b = names.find((n) => n !== a && n.startsWith(`${a}.`));
    if (b) throw new GlobalPatchError(`項目の名前が重なっています: ${a} と ${b}`);
  }
  return out;
}

// rproxy の答えを画面に渡す形にそろえる（知らない欄は落とす）
export function globalSettingsView(raw: unknown): GlobalSettings | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.items !== 'object' || r.items === null) return null;
  const items: Record<string, GlobalItem> = {};
  for (const [name, v] of Object.entries(r.items as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue;
    const i = v as Record<string, unknown>;
    items[name] = {
      value: i.value ?? null,
      source: typeof i.source === 'string' ? i.source : 'default',
      apply: typeof i.apply === 'string' ? i.apply : 'restart',
      unix_only: i.unix_only === true,
      settable: i.settable === true,
      ...('api_value' in i ? { api_value: i.api_value } : {}),
      ...(i.shadowed === true ? { shadowed: true } : {}),
      ...(i.kept === true ? { kept: true } : {}),
      ...(typeof i.error === 'string' ? { error: i.error } : {}),
    };
  }
  return {
    items: items,
    storage: typeof r.storage === 'string' ? r.storage : 'memory',
    persisted: typeof r.persisted === 'boolean' ? r.persisted : null,
    loaded: r.loaded !== false,
    updated_by: typeof r.updated_by === 'string' ? r.updated_by : null,
    updated_at: typeof r.updated_at === 'number' ? r.updated_at : null,
    warnings: Array.isArray(r.warnings) ? (r.warnings as unknown[]).filter((w): w is GlobalWarning => typeof w === 'object' && w !== null) : [],
  };
}

// 再起動が要る項目の値を伏せる（UI の応答に入れない）。値がオブジェクトなら一番上の名前だけを残す。
// 数・文字列・真偽（performance の workers など）は伏せるものがないのでそのまま
export function redactRestartItems(settings: GlobalSettings): GlobalSettings {
  const items: Record<string, GlobalItem> = {};
  for (const [name, item] of Object.entries(settings.items)) {
    if (item.apply === 'live' || item.value === null || typeof item.value !== 'object') {
      items[name] = item;
      continue;
    }
    const { api_value: _api, ...rest } = item;
    void _api;
    items[name] = { ...rest, value: null, redacted: true, keys: Array.isArray(item.value) ? [] : Object.keys(item.value as Record<string, unknown>) };
  }
  return { ...settings, items: items };
}

// 2 つの値が同じか（キーの順を問わない。undefined と null は同じ）
export function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

// 値の短い表示
export function formatGlobalValue(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string') return value === '' ? '""' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.length === 0 ? '[]' : value.join(', ');
  return JSON.stringify(value);
}

// 項目を API で変えられるか（ノードの全員で）。理由（変えられないとき）を返す
export function editBlock(item: GlobalItem, transport: 'unix' | 'tcp'): string | null {
  const fixed = fixedNote(item.source);
  if (fixed) return fixed;
  if (item.apply !== 'live') return '再起動が要る項目（設定ファイルで変える）';
  if (!item.settable) return 'API では変えられません';
  if (item.unix_only && transport !== 'unix') return 'Unix ソケットからだけ変えられます';
  return null;
}

// --- フォーム（項目ごとの欄の文字列と送る値の行き来） ---

export type GlobalForm =
  | { kind: 'lines'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'number'; text: string }
  | { kind: 'fields'; keys: string[]; fields: Record<string, string> }
  | { kind: 'json'; text: string };

// 欄の初めの値：API の値だけ（今効いている既定の値を入れると、触らずに送ったときに既定が API の値として固まるため）。
// グループでノードの API の値が違うときは呼ぶ側が undefined を渡して空にする
export function toGlobalForm(name: string, item: GlobalItem | undefined): GlobalForm {
  const v = item?.api_value;
  const fields = (keys: string[]): GlobalForm => {
    const o = typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
    return { kind: 'fields', keys: keys, fields: Object.fromEntries(keys.map((k) => [k, o[k] === undefined || o[k] === null ? '' : String(o[k])])) };
  };
  switch (name) {
    case 'trusted_proxies':
      return { kind: 'lines', text: Array.isArray(v) ? v.map(String).join('\n') : '' };
    case 'access_log':
      return { kind: 'text', text: typeof v === 'string' ? v : '' };
    case 'udp_max_sessions':
      return { kind: 'number', text: typeof v === 'number' ? String(v) : '' };
    case 'http.timeouts':
      return fields(HTTP_TIMEOUT_KEYS);
    case 'crowdsec':
      return fields(CROWDSEC_KEYS);
    default:
      return { kind: 'json', text: v === undefined || v === null ? '' : JSON.stringify(v, null, 2) };
  }
}

// 欄から送る値（null は API の値を消して既定に戻す）。形の誤りは GlobalPatchError
export function buildGlobalValue(name: string, form: GlobalForm): unknown {
  switch (form.kind) {
    case 'lines': {
      const lines = form.text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
      return lines.map((l) => {
        const c = parseCidr(l);
        if (!c.ok) throw new GlobalPatchError(`${name}: CIDR か IP アドレスではありません: ${l}`);
        return c.value;
      });
    }
    case 'text': {
      const s = form.text.trim();
      if (s === '') return null;
      if (name === 'access_log' && !s.startsWith('/')) throw new GlobalPatchError(`${name}: 絶対パスにしてください: ${s}`);
      return s;
    }
    case 'number': {
      const s = form.text.trim();
      if (s === '') return null;
      if (!/^\d+$/.test(s) || !Number.isSafeInteger(Number(s))) throw new GlobalPatchError(`${name}: 0 以上の整数にしてください: ${s}`);
      return Number(s);
    }
    case 'fields': {
      const o = Object.fromEntries(form.keys.map((k) => [k, form.fields[k]?.trim() ?? '']).filter(([, v]) => v !== ''));
      if (Object.keys(o).length === 0) return null;
      if (name === 'crowdsec') {
        if (!o.lapi_url || !o.api_key_file) throw new GlobalPatchError(`${name}: lapi_url と api_key_file は両方要ります。`);
        if (!o.api_key_file.startsWith('/')) throw new GlobalPatchError(`${name}: api_key_file は絶対パスにしてください。`);
      }
      return o;
    }
    case 'json': {
      const s = form.text.trim();
      if (s === '') return null;
      try {
        return JSON.parse(s);
      } catch {
        throw new GlobalPatchError(`${name}: JSON として読めません。`);
      }
    }
  }
}
