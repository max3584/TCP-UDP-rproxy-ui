// ACME（rproxy-api v0.3.21。docs/ACME.md）：rproxy が ACME で取って更新する証明書（tls.certificates[] の {acme, domains}）。
// resolver の一覧（GET /acme）の形、名前の検証（rproxy の src/acme/config.rs と同じ規則）、状態の表示と要確認の判定。
// アカウントの作成・無効化、今すぐの更新（POST /acme/...）と秘密は rproxy の設定ファイルと Unix ソケットだけで扱うので、ここには置かない。
// React と Node に依存しない（画面と API route の両方で使う）
import type { ForwardRules, TlsCertificate } from './lib';
import { formatIsoTime } from './dashboard';
import { joinSentences, translate } from '@/i18n/core';

export type AcmeChallenge = 'http-01' | 'tls-alpn-01' | 'dns-01';
export const ACME_CHALLENGES: AcmeChallenge[] = ['http-01', 'tls-alpn-01', 'dns-01'];

// 証明書の状態（rproxy のルールの acme / GET /acme の certificates）。
// pending：まだ取れていない（自己署名の仮の証明書を返す）、valid、renewing：更新の時期、error：最後の試みが失敗（取れていた証明書はそのまま使う）
export type AcmeState = 'pending' | 'valid' | 'renewing' | 'error';

export interface AcmeCertStatus {
  resolver: string;
  // rproxy が正規化した名前（小文字・並べ替え・重複なし）
  domains: string[];
  state: AcmeState;
  // RFC 3339
  not_after?: string;
  renew_at?: string;
  // 失敗や rate_limit で待っている次の試みの時刻
  next_attempt?: string;
  error?: string;
}

export interface AcmeResolverInfo {
  name: string;
  account: string;
  challenge: AcmeChallenge | string;
  dns_provider: string | null;
}

export interface AcmeAccountInfo {
  name: string;
  allowed_names: string[];
  // CA にアカウントがあるか（最初の注文で作る）
  registered: boolean;
}

export interface AcmeProviderInfo {
  name: string;
  type: string;
  allowed_names: string[];
}

// /api/forward/acme の応答。configured が false なら rproxy に global.acme がない（GET /acme が 404）か、ACME に対応していない
export interface AcmeInfo {
  configured: boolean;
  resolvers: AcmeResolverInfo[];
  accounts: AcmeAccountInfo[];
  dnsProviders: AcmeProviderInfo[];
  certificates: AcmeCertStatus[];
  rateLimit: { orders: number; periodSecs: number; used: number } | null;
}

export const ACME_NOT_CONFIGURED: AcmeInfo = { configured: false, resolvers: [], accounts: [], dnsProviders: [], certificates: [], rateLimit: null };

// rproxy の 1 つの ACME の証明書に入れられる名前の数の上限（MAX_NAMES）
export const MAX_ACME_NAMES = 100;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const ACME_STATES: AcmeState[] = ['pending', 'valid', 'renewing', 'error'];

// 証明書の状態の 1 件（ルールの acme・GET /acme の certificates）。形が違えば null
export function acmeCertStatus(v: unknown): AcmeCertStatus | null {
  if (!isObj(v) || typeof v.resolver !== 'string' || !ACME_STATES.includes(v.state as AcmeState)) return null;
  return {
    resolver: v.resolver,
    domains: strList(v.domains),
    state: v.state as AcmeState,
    ...(str(v.not_after) ? { not_after: str(v.not_after) } : {}),
    ...(str(v.renew_at) ? { renew_at: str(v.renew_at) } : {}),
    ...(str(v.next_attempt) ? { next_attempt: str(v.next_attempt) } : {}),
    ...(str(v.error) ? { error: str(v.error) } : {}),
  };
}

export function acmeCertStatuses(v: unknown): AcmeCertStatus[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map(acmeCertStatus).filter((s): s is AcmeCertStatus => s !== null);
}

// ルールの稼働情報に足す acmeStatus（rproxy の acme がなければ付けない）
export function acmeStatusField(v: unknown): { acmeStatus?: AcmeCertStatus[] } {
  const list = acmeCertStatuses(v);
  return list ? { acmeStatus: list } : {};
}

// rproxy の GET /acme の応答から、画面に要るものだけを取り出す。
// アカウントの directory・contact・eab、DNS のプロバイダの zones は画面に要らないので渡さない（秘密は rproxy も返さない）
export function acmeInfoFromRproxy(raw: unknown): AcmeInfo {
  if (!isObj(raw)) return ACME_NOT_CONFIGURED;
  const named = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => isObj(x) && typeof x.name === 'string') : []);
  const rl = isObj(raw.rate_limit) ? raw.rate_limit : null;
  return {
    configured: true,
    resolvers: named(raw.resolvers).map((r) => ({
      name: r.name as string,
      account: str(r.account) ?? '',
      challenge: str(r.challenge) ?? '',
      dns_provider: str(r.dns_provider) ?? null,
    })),
    accounts: named(raw.accounts).map((a) => ({ name: a.name as string, allowed_names: strList(a.allowed_names), registered: a.registered === true })),
    dnsProviders: named(raw.dns_providers).map((p) => ({ name: p.name as string, type: str(p.type) ?? '', allowed_names: strList(p.allowed_names) })),
    certificates: acmeCertStatuses(raw.certificates) ?? [],
    rateLimit: rl && typeof rl.orders === 'number' && typeof rl.period_secs === 'number' && typeof rl.used === 'number'
      ? { orders: rl.orders, periodSecs: rl.period_secs, used: rl.used } : null,
  };
}

// ---- 名前（rproxy の normalize_name / valid_name / name_allowed と同じ） ----

// CA が見る形：小文字、末尾の . なし
export function normalizeAcmeName(name: string): string {
  return name.trim().replace(/\.+$/, '').toLowerCase();
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// 証明書に入れられるホスト名（英数字と - のラベルが 2 つ以上。先頭に *. を 1 つ付けられる。IP アドレスは不可）
export function validAcmeName(name: string): boolean {
  const host = name.startsWith('*.') ? name.slice(2) : name;
  if (host === '' || host.length > 253 || IPV4.test(host) || host.includes(':')) return false;
  const labels = host.split('.');
  return labels.length >= 2 && labels.every((l) => l.length > 0 && l.length <= 63 && !l.startsWith('-') && !l.endsWith('-') && /^[A-Za-z0-9-]+$/.test(l));
}

// allowed_names の 1 件が名前を許すか（どちらも正規化した形）。`*.` は 1 階層（ワイルドカードそのものも）、`**.` は何階層でも
export function acmeNameAllowed(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (pattern.startsWith('**.')) {
    const suffix = pattern.slice(3);
    return name.length > suffix.length + 1 && name.endsWith(`.${suffix}`);
  }
  if (pattern.startsWith('*.')) {
    const dot = name.indexOf('.');
    return dot > 0 && name.slice(dot + 1) === pattern.slice(2);
  }
  return false;
}

export function acmeAllowedBy(patterns: string[], name: string): boolean {
  return patterns.some((p) => acmeNameAllowed(normalizeAcmeName(p), name));
}

// フォームの名前の欄（カンマか空白で区切る）を名前の配列にする（正規化して重複を除く）
export function splitAcmeDomains(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map(normalizeAcmeName).filter((d) => d !== ''))];
}

export const CHALLENGE_LABELS: Record<AcmeChallenge, string> = {
  'http-01': 'http-01（80 番の HTTP で確かめる）',
  'tls-alpn-01': 'tls-alpn-01（443 番の TLS で確かめる）',
  'dns-01': 'dns-01（DNS の TXT で確かめる。ワイルドカードはこれだけ）',
};

export function challengeLabel(challenge: string): string {
  return CHALLENGE_LABELS[challenge as AcmeChallenge] ?? challenge;
}

// challenge ごとの注意（フォームの resolver の下に出す）
export const CHALLENGE_HELP: Record<AcmeChallenge, string> = {
  'http-01': 'CA が名前の 80 番に HTTP で接続して確かめます。rproxy の 80 番の L7 (HTTP) のルールか、設定ファイルの global.acme.http01_listen が答えます（80 番を passthrough で転送していると答えられません）。',
  'tls-alpn-01': 'CA が名前の 443 番に TLS（ALPN acme-tls/1）で接続して確かめます。443 番で終端（terminate）している tcp のルールが答えます（sni・passthrough では答えられません）。',
  'dns-01': 'rproxy が DNS のプロバイダに _acme-challenge の TXT を書いて確かめます。ワイルドカード（*.example.com）や、外から 80 / 443 番に届かない名前に使います。',
};

export function challengeHelp(challenge: string): string | null {
  return CHALLENGE_HELP[challenge as AcmeChallenge] ?? null;
}

// フォームで確かめる：resolver があるか、名前が正しいか、ワイルドカードは dns-01 か、アカウント（と DNS のプロバイダ）の allowed_names の内か。
// rproxy の check_names と同じ順に確かめ、最初の問題を返す（なければ null）。info が設定されていなければ rproxy に任せる
export function checkAcmeNames(info: AcmeInfo, resolver: string, domains: string[]): string | null {
  if (resolver === '') return 'ACME の resolver を選んでください。';
  if (domains.length === 0) return 'ACME の証明書には名前を 1 つ以上指定してください。';
  if (domains.length > MAX_ACME_NAMES) return `ACME の証明書に入れられる名前は ${MAX_ACME_NAMES} 個までです。`;
  if (!info.configured) return null;
  const r = info.resolvers.find((x) => x.name === resolver);
  if (!r) return `resolver ${resolver} は rproxy の設定ファイル（global.acme.resolvers）にありません。`;
  const account = info.accounts.find((a) => a.name === r.account);
  const provider = r.dns_provider ? info.dnsProviders.find((p) => p.name === r.dns_provider) : undefined;
  for (const raw of domains) {
    const name = normalizeAcmeName(raw);
    if (!validAcmeName(name)) return `${raw} は証明書に入れられるホスト名ではありません（例: www.example.com、*.example.com）。`;
    if (name.startsWith('*.') && r.challenge !== 'dns-01') {
      return `ワイルドカード ${raw} は dns-01 の resolver でだけ取れます（resolver ${r.name} は ${r.challenge}）。`;
    }
    if (account && !acmeAllowedBy(account.allowed_names, name)) {
      return `${raw} は ACME のアカウント ${account.name} で取ってよい名前（allowed_names: ${account.allowed_names.join(', ')}）に含まれていません。`;
    }
    if (provider && !acmeAllowedBy(provider.allowed_names, name)) {
      return `${raw} は DNS のプロバイダ ${provider.name} で証明してよい名前（allowed_names: ${provider.allowed_names.join(', ')}）に含まれていません。`;
    }
  }
  return null;
}

// ---- 状態 ----

export const ACME_STATE_LABELS: Record<AcmeState, string> = {
  pending: '取得待ち',
  valid: '有効',
  renewing: '更新中',
  error: '失敗',
};

const sameSet = (a: string[], b: string[]) => {
  const x = [...new Set(a.map(normalizeAcmeName))].sort();
  const y = [...new Set(b.map(normalizeAcmeName))].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

// ルールの証明書（tls.certificates の ACME の 1 件）の状態を探す（resolver と名前の組で。rproxy は名前を並べ替えて返す）
export function acmeStatusFor(statuses: AcmeCertStatus[] | undefined, cert: TlsCertificate): AcmeCertStatus | undefined {
  if (cert.acme === undefined) return undefined;
  return (statuses ?? []).find((s) => s.resolver === cert.acme && sameSet(s.domains, cert.domains ?? []));
}

// 自己署名の仮の証明書（rproxy ACME placeholder）を返している：まだ取れていない、または保存した証明書の期限が切れている
export function servesStandIn(s: AcmeCertStatus, nowMs: number = Date.now()): boolean {
  if (s.not_after === undefined) return true;
  const end = Date.parse(s.not_after);
  return !Number.isNaN(end) && end <= nowMs;
}

// 期限までの日数（切り捨て。期限がなければ null）
export function acmeDaysLeft(s: AcmeCertStatus, nowMs: number = Date.now()): number | null {
  if (s.not_after === undefined) return null;
  const end = Date.parse(s.not_after);
  return Number.isNaN(end) ? null : Math.floor((end - nowMs) / 86_400_000);
}

// 失敗が続いて期限が近いとみなす日数（rproxy は既定で期限の 30 日前から更新を試みる）
export const ACME_URGENT_DAYS = 14;

// 要確認に出す ACME の問題（なければ null）：
// - 失敗（error）：取れていなければ仮の証明書のまま、取れていれば期限までの日数（ACME_URGENT_DAYS 以下なら強く）
// - 取得待ち（pending）のまま次の試みを待っている（rate_limit で後に回した）
export function acmeProblem(rule: Pick<ForwardRules, 'acmeStatus'>, nowMs: number = Date.now()): string | null {
  const problems = (rule.acmeStatus ?? []).flatMap((s): string[] => {
    const names = s.domains.join(', ');
    const next = s.next_attempt ? translate(`次の試み: ${formatIsoTime(s.next_attempt)}`) : '';
    if (s.state === 'error') {
      const days = acmeDaysLeft(s, nowMs);
      const what = servesStandIn(s, nowMs)
        ? translate('まだ取れていないため、自己署名の仮の証明書を返しています')
        : days !== null && days <= ACME_URGENT_DAYS
          ? translate(`更新できないまま、あと ${days} 日で期限が切れます`)
          : translate('更新に失敗しました（それまでの証明書を使い続けます）');
      return [joinSentences([
        translate(`ACME の証明書（${names}）: ${what}。`),
        ...(s.error ? [translate(`理由: ${s.error}`)] : []),
        ...(next ? [next] : []),
      ])];
    }
    if (s.state === 'pending' && s.next_attempt) {
      return [translate(`ACME の証明書（${names}）はまだ取れていません（自己署名の仮の証明書を返しています。${formatIsoTime(s.next_attempt)} に試します）。`)];
    }
    return [];
  });
  return problems.length === 0 ? null : joinSentences(problems);
}

// いちばん悪い状態（一覧のバッジ）。ACME の証明書がなければ null
export function worstAcmeState(rule: Pick<ForwardRules, 'acmeStatus'>): AcmeState | null {
  const list = rule.acmeStatus ?? [];
  if (list.length === 0) return null;
  for (const s of ['error', 'pending', 'renewing'] as AcmeState[]) {
    if (list.some((c) => c.state === s)) return s;
  }
  return 'valid';
}

// ルールに ACME の証明書があるか
export function hasAcmeCertificates(tls: { certificates?: TlsCertificate[] }): boolean {
  return (tls.certificates ?? []).some((c) => c.acme !== undefined);
}
