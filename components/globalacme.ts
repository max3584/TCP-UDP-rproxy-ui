// global の geoip と acme のフォーム（rproxy-api v0.4.22 の PATCH /config/global、#345。UI #189）。
// 欄の値と送る値の行き来と、rproxy が断るものを送る前に断る確かめ：
// - ファイルは rproxy-api の RPROXY_API_GEOIP_DIR・RPROXY_API_ACME_DIR のすぐ下だけ（UI はディレクトリを知らないので、
//   絶対パスのファイルの名前で、すべて同じディレクトリにあることまでを確かめる。ディレクトリの外は rproxy が 403 protected_file）
// - acme は秘密を持たない：アカウントの key_file は書けず、http の DNS のプロバイダの資格情報は secret_file の {secret} からだけ
//   （ヘッダは {secret} か「<方式> {secret}」。{secret} と資格情報らしい名前のクエリと利用者は URL に書けない。
//   rproxy の acme_secrets_in_files と AcmeGlobal::check と同じ。DNS のプロバイダの種類ごとに使える項目も check の set_fields と同じ）
// - rproxy は acme の秘密らしい値（ファイルの場所・ヘッダ・URL のパスなど）を *** で返す。欄にはそのまま入れ、残っていれば送らない
// React と Node に依存しない（tests/globalacme.test.ts）

export class GlobalPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlobalPatchError';
  }
}

// rproxy が伏せた値の印（GET /config/global の MASKED）
export const MASKED = '***';

// rproxy の既定の ACME の保存先（acme::config::DEFAULT_STORAGE）
export const ACME_DEFAULT_STORAGE = '/var/lib/rproxy/acme';
export const DNS_PROVIDER_TYPES = ['powerdns', 'http', 'rfc2136', 'acme_dns'] as const;
export const CHALLENGES = ['http-01', 'tls-alpn-01', 'dns-01'] as const;
export const TSIG_ALGORITHMS = ['hmac-sha256', 'hmac-sha512'];

export interface GeoipForm {
  kind: 'geoip';
  country_db: string;
  asn_db: string;
  check_interval: string;
  log_country: boolean;
}

export interface HttpCallForm {
  method: string;
  url: string;
  // 1 行に「名前: 値」
  headers: string;
  body: string;
}

export interface AcmeAccountForm {
  name: string;
  directory: string;
  // 改行かカンマで区切る
  contact: string;
  allowed_names: string;
  ca_file: string;
  eab_kid: string;
  eab_hmac_key_file: string;
}

export interface AcmeProviderForm {
  name: string;
  type: string;
  allowed_names: string;
  zones: string;
  ttl: string;
  ca_file: string;
  // powerdns・acme_dns
  api_url: string;
  // powerdns
  server_id: string;
  api_key_file: string;
  // http
  add: HttpCallForm;
  remove: HttpCallForm;
  secret_file: string;
  // rfc2136
  server: string;
  tsig_key_name: string;
  tsig_algorithm: string;
  tsig_secret_file: string;
  // acme_dns
  credentials_file: string;
}

export interface AcmeResolverForm {
  name: string;
  account: string;
  challenge: string;
  dns_provider: string;
}

export interface AcmeForm {
  kind: 'acme';
  storage: string;
  http01_listen: string;
  dns_servers: string;
  renew_before: string;
  dns_propagation_timeout: string;
  rate_orders: string;
  rate_period: string;
  helper_socket: string;
  accounts: AcmeAccountForm[];
  providers: AcmeProviderForm[];
  resolvers: AcmeResolverForm[];
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const list = (v: unknown): string => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').join('\n') : '');

export function splitList(text: string): string[] {
  return text.split(/[\n,]/).map((s) => s.trim()).filter((s) => s !== '');
}

// --- GeoIP ---

export function toGeoipForm(apiValue: unknown): GeoipForm {
  const o = obj(apiValue);
  return { kind: 'geoip', country_db: str(o.country_db), asn_db: str(o.asn_db), check_interval: str(o.check_interval), log_country: o.log_country === true };
}

// rproxy の l7::parse_duration と同じ（数と単位 1 つ）。0s も
const L7_DURATION = /^[0-9]+(ms|s|m|h)$/;
// ACME の時間（renew_before は 30d・720h も）
const ACME_DURATION = /^[0-9]+(ms|s|m|h|d)$/;

// 絶対パスを字面で整える（// と . を除き、.. を 1 つ上に）。ディレクトリを比べるときだけに使う
// （rproxy は本当のパスで比べる。リンクの違いなどは rproxy が断る）
export function lexicalPath(p: string): string {
  const out: string[] = [];
  for (const d of p.split('/')) {
    if (d === '' || d === '.') continue;
    if (d === '..') out.pop();
    else out.push(d);
  }
  return `/${out.join('/')}`;
}

// API のディレクトリのすぐ下に置くファイルの絶対パス（字面で整えたディレクトリを返す）。
// rproxy が断るもの（相対パス・. で始まる名前・ディレクトリ・制御文字）を先に断る。空白は使える
export function apiDirFile(what: string, p: string): string {
  if (!p.startsWith('/')) throw new GlobalPatchError(`${what}: 絶対パスにしてください: ${p}`);
  if (/[\x00-\x1f\x7f]/.test(p)) throw new GlobalPatchError(`${what}: パスに制御文字は使えません: ${p}`);
  const parts = p.split('/');
  const name = parts[parts.length - 1];
  if (name === '' || name === '..' || name.startsWith('.')) {
    throw new GlobalPatchError(`${what}: ファイルの名前で終わるパスにしてください（. で始まる名前は不可）: ${p}`);
  }
  return lexicalPath(parts.slice(0, -1).join('/'));
}

function noMasked(what: string, v: string): string {
  if (v.includes(MASKED)) throw new GlobalPatchError(`${what}: 伏せた値（***）が残っています。入れ直してください（rproxy は秘密に関わる値を画面に返しません）。`);
  return v;
}

export function buildGeoip(form: GeoipForm): Record<string, unknown> {
  const country = noMasked('geoip.country_db', form.country_db.trim());
  const asn = noMasked('geoip.asn_db', form.asn_db.trim());
  const interval = form.check_interval.trim();
  if (country === '' && asn === '') throw new GlobalPatchError('geoip: country_db と asn_db の少なくとも一方が要ります。');
  const dirs = new Set<string>();
  if (country !== '') dirs.add(apiDirFile('geoip.country_db', country));
  if (asn !== '') dirs.add(apiDirFile('geoip.asn_db', asn));
  if (dirs.size > 1) throw new GlobalPatchError('geoip: country_db と asn_db は同じディレクトリ（RPROXY_API_GEOIP_DIR）のすぐ下に置いてください。');
  if (interval !== '' && !L7_DURATION.test(interval)) throw new GlobalPatchError(`geoip.check_interval: 1m・30s のように数と単位（ms・s・m・h）で指定してください（0s で確かめない）: ${interval}`);
  return {
    ...(country !== '' ? { country_db: country } : {}),
    ...(asn !== '' ? { asn_db: asn } : {}),
    ...(interval !== '' ? { check_interval: interval } : {}),
    ...(form.log_country ? { log_country: true } : {}),
  };
}

// --- ACME ---

const emptyCall = (): HttpCallForm => ({ method: '', url: '', headers: '', body: '' });

export function emptyAccount(): AcmeAccountForm {
  return { name: '', directory: '', contact: '', allowed_names: '', ca_file: '', eab_kid: '', eab_hmac_key_file: '' };
}

export function emptyProvider(): AcmeProviderForm {
  return {
    name: '', type: 'powerdns', allowed_names: '', zones: '', ttl: '', ca_file: '', api_url: '', server_id: '', api_key_file: '',
    add: emptyCall(), remove: emptyCall(), secret_file: '', server: '', tsig_key_name: '', tsig_algorithm: '', tsig_secret_file: '', credentials_file: '',
  };
}

export function emptyResolver(): AcmeResolverForm {
  return { name: '', account: '', challenge: 'http-01', dns_provider: '' };
}

function toCall(v: unknown): HttpCallForm {
  const o = obj(v);
  const headers = Object.entries(obj(o.headers)).map(([k, x]) => `${k}: ${str(x)}`).join('\n');
  return { method: str(o.method), url: str(o.url), headers: headers, body: str(o.body) };
}

// 欄の初めの値：API の値（rproxy が伏せた *** はそのまま入る）
export function toAcmeForm(apiValue: unknown): AcmeForm {
  const o = obj(apiValue);
  const rate = obj(o.rate_limit);
  return {
    kind: 'acme',
    storage: str(o.storage),
    http01_listen: list(o.http01_listen),
    dns_servers: list(o.dns_servers),
    renew_before: str(o.renew_before),
    dns_propagation_timeout: str(o.dns_propagation_timeout),
    rate_orders: str(rate.orders),
    rate_period: str(rate.period),
    helper_socket: str(obj(o.helper).socket),
    accounts: Object.entries(obj(o.accounts)).map(([name, v]) => {
      const a = obj(v);
      const eab = obj(a.eab);
      return {
        name: name, directory: str(a.directory), contact: list(a.contact), allowed_names: list(a.allowed_names), ca_file: str(a.ca_file),
        eab_kid: str(eab.kid), eab_hmac_key_file: str(eab.hmac_key_file),
      };
    }),
    providers: Object.entries(obj(o.dns_providers)).map(([name, v]) => {
      const p = obj(v);
      return {
        name: name, type: str(p.type), allowed_names: list(p.allowed_names), zones: list(p.zones), ttl: str(p.ttl), ca_file: str(p.ca_file),
        api_url: str(p.api_url), server_id: str(p.server_id), api_key_file: str(p.api_key_file),
        add: toCall(p.add), remove: toCall(p.remove), secret_file: str(p.secret_file),
        server: str(p.server), tsig_key_name: str(p.tsig_key_name), tsig_algorithm: str(p.tsig_algorithm), tsig_secret_file: str(p.tsig_secret_file),
        credentials_file: str(p.credentials_file),
      };
    }),
    resolvers: Object.entries(obj(o.resolvers)).map(([name, v]) => {
      const r = obj(v);
      return { name: name, account: str(r.account), challenge: str(r.challenge), dns_provider: str(r.dns_provider) };
    }),
  };
}

// rproxy の names_a_secret と同じ：資格情報らしい名前
const SECRET_NAME_PARTS = ['auth', 'key', 'token', 'secret', 'password', 'passwd', 'credential', 'cookie', 'session', 'signature'];
export function namesASecret(name: string): boolean {
  const n = name.toLowerCase();
  return SECRET_NAME_PARTS.some((w) => n.includes(w));
}

// {secret} か「<方式> {secret}」（Bearer {secret}）：秘密の横に直接書いた文字がない
export function secretHeaderValue(v: string): boolean {
  if (!v.endsWith('{secret}')) return false;
  const scheme = v.slice(0, -'{secret}'.length);
  if (scheme === '') return true;
  if (!scheme.endsWith(' ')) return false;
  const s = scheme.slice(0, -1);
  return /^[A-Za-z][A-Za-z0-9\-._~+/]*$/.test(s);
}

const SECRET_RULE = '（API の acme の資格情報は secret_file に置き、ヘッダか本文で {secret} として使います）';

// HTTP のメソッド（トークン）
const METHOD = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// http(s) の URL の形（rproxy の net::url::parse の主なもの）：スキーム・ホスト・ポート（1〜65535）・利用者なし
function checkHttpUrl(what: string, url: string): void {
  const m = /^https?:\/\/([^/?#]*)/i.exec(url);
  if (!m) throw new GlobalPatchError(`${what}: http:// か https:// で始めてください: ${url}`);
  const authority = m[1];
  if (authority.includes('@')) throw new GlobalPatchError(`${what}: URL に利用者（…@）は書けません${SECRET_RULE}。`);
  const hp = /^(\[[^\]]+\]|[^:]*)(?::(.*))?$/.exec(authority)!;
  if (hp[1] === '') throw new GlobalPatchError(`${what}: ホストがありません: ${url}`);
  if (hp[2] !== undefined && (!/^[0-9]{1,5}$/.test(hp[2]) || Number(hp[2]) < 1 || Number(hp[2]) > 65535)) {
    throw new GlobalPatchError(`${what}: ポートは 1〜65535 にしてください: ${url}`);
  }
}

function buildCall(where: string, c: HttpCallForm): Record<string, unknown> | undefined {
  const url = noMasked(`${where}.url`, c.url.trim());
  const method = c.method.trim();
  const body = noMasked(`${where}.body`, c.body);
  const headerLines = c.headers.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  if (url === '' && method === '' && body.trim() === '' && headerLines.length === 0) return undefined;
  if (url === '') throw new GlobalPatchError(`${where}: url が要ります。`);
  if (method !== '' && !METHOD.test(method)) throw new GlobalPatchError(`${where}.method: HTTP のメソッドではありません: ${method}`);
  // URL はログに残るので {secret} はどこにも置けない（rproxy の AcmeGlobal::check）
  if (url.includes('{secret}')) throw new GlobalPatchError(`${where}.url: {secret} は URL に置けません（ヘッダか本文に。URL はログに残ります）。`);
  // 差し込む値は 1 つのラベルとして読む（rproxy と同じ）
  checkHttpUrl(`${where}.url`, ['{fqdn}', '{value}', '{zone}'].reduce((u, x) => u.split(x).join('x'), url));
  const q = url.indexOf('?');
  const query = q >= 0 ? url.slice(q + 1).split('#')[0] : '';
  for (const pair of query.split('&').filter((p) => p !== '')) {
    const eq = pair.indexOf('=');
    const k = eq >= 0 ? pair.slice(0, eq) : pair;
    if (namesASecret(k)) {
      throw new GlobalPatchError(`${where}.url: クエリの ${k} は資格情報らしい名前です。資格情報はヘッダか本文に {secret} で入れてください${SECRET_RULE}。`);
    }
  }
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const at = line.indexOf(':');
    if (at <= 0) throw new GlobalPatchError(`${where}.headers: 1 行に「名前: 値」で書いてください: ${line}`);
    const name = line.slice(0, at).trim();
    const value = noMasked(`${where}.headers.${name}`, line.slice(at + 1).trim());
    if ((namesASecret(name) || value.includes('{secret}')) && !secretHeaderValue(value)) {
      throw new GlobalPatchError(`${where}.headers: ${name} は {secret} か「Bearer {secret}」の形にしてください${SECRET_RULE}。`);
    }
    headers[name] = value;
  }
  if (body.trim() !== '' && namesASecret(body) && !body.includes('{secret}')) {
    throw new GlobalPatchError(`${where}.body: 資格情報らしい名前を含む本文は {secret} を使ってください${SECRET_RULE}。`);
  }
  return {
    ...(method !== '' ? { method: method } : {}),
    url: url,
    ...(Object.keys(headers).length > 0 ? { headers: headers } : {}),
    ...(body.trim() !== '' ? { body: body } : {}),
  };
}

const usesSecret = (c: Record<string, unknown> | undefined) => c !== undefined && JSON.stringify(c).includes('{secret}');

// rproxy の safe_name（アカウントの名前。鍵のファイルの名前になる）
export const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

// 名前が空でなく重ならないこと。アカウントだけ safe_name（rproxy はプロバイダ・resolver の名前の形を問わない）
function uniqueNames(what: string, names: string[], safe = false) {
  const seen = new Set<string>();
  for (const n of names) {
    if (n === '') throw new GlobalPatchError(`acme.${what}: 名前が空のものがあります。`);
    if (safe && !SAFE_NAME.test(n)) throw new GlobalPatchError(`acme.${what}: 名前は英数字と - _ の 64 文字までにしてください: ${n}`);
    if (seen.has(n)) throw new GlobalPatchError(`acme.${what}: 同じ名前が 2 つあります: ${n}`);
    seen.add(n);
  }
}

// DNS のプロバイダの種類ごとに書ける項目（rproxy の AcmeGlobal::check。ca_file・allowed_names はどれも）
export const PROVIDER_FIELDS: Record<string, string[]> = {
  powerdns: ['api_url', 'server_id', 'api_key_file', 'zones', 'ttl'],
  http: ['add', 'remove', 'secret_file', 'zones'],
  rfc2136: ['server', 'tsig_key_name', 'tsig_algorithm', 'tsig_secret_file', 'zones', 'ttl'],
  acme_dns: ['api_url', 'credentials_file'],
};
export const providerTakes = (type: string, field: string): boolean => (PROVIDER_FIELDS[type] ?? []).includes(field);

// 欄から送る acme の値。形の誤り・秘密の書き方の誤り・ディレクトリの誤りは GlobalPatchError
export function buildAcme(form: AcmeForm): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // 指すファイル（すべて RPROXY_API_ACME_DIR のすぐ下）
  const files: [string, string][] = [];
  const file = (where: string, v: string): string | undefined => {
    const s = noMasked(where, v.trim());
    if (s === '') return undefined;
    files.push([where, s]);
    return s;
  };
  const text = (where: string, v: string): string | undefined => {
    const s = noMasked(where, v.trim());
    return s === '' ? undefined : s;
  };
  const names = (where: string, v: string): string[] => splitList(v).map((x) => noMasked(where, x));

  uniqueNames('accounts', form.accounts.map((a) => a.name.trim()), true);
  uniqueNames('dns_providers', form.providers.map((p) => p.name.trim()));
  uniqueNames('resolvers', form.resolvers.map((r) => r.name.trim()));

  const accounts: Record<string, unknown> = {};
  for (const a of form.accounts) {
    const w = `acme.accounts.${a.name.trim()}`;
    const allowed = names(`${w}.allowed_names`, a.allowed_names);
    if (allowed.length === 0) throw new GlobalPatchError(`${w}: allowed_names（このアカウントで取ってよい名前）が要ります。`);
    const directory = text(`${w}.directory`, a.directory);
    if (directory !== undefined) checkHttpUrl(`${w}.directory`, directory);
    const contact = names(`${w}.contact`, a.contact);
    const bad = contact.find((c) => !c.startsWith('mailto:'));
    if (bad !== undefined) throw new GlobalPatchError(`${w}.contact: mailto: で始めてください: ${bad}`);
    const kid = text(`${w}.eab.kid`, a.eab_kid);
    const hmac = file(`${w}.eab.hmac_key_file`, a.eab_hmac_key_file);
    if ((kid === undefined) !== (hmac === undefined)) throw new GlobalPatchError(`${w}.eab: kid と hmac_key_file は両方書くか、両方空にしてください。`);
    const ca = file(`${w}.ca_file`, a.ca_file);
    accounts[a.name.trim()] = {
      ...(directory !== undefined ? { directory: directory } : {}),
      ...(contact.length > 0 ? { contact: contact } : {}),
      allowed_names: allowed,
      ...(kid !== undefined ? { eab: { kid: kid, hmac_key_file: hmac } } : {}),
      ...(ca !== undefined ? { ca_file: ca } : {}),
    };
  }

  const providers: Record<string, unknown> = {};
  for (const p of form.providers) {
    const w = `acme.dns_providers.${p.name.trim()}`;
    const type = p.type.trim();
    if (!(DNS_PROVIDER_TYPES as readonly string[]).includes(type)) throw new GlobalPatchError(`${w}.type: ${DNS_PROVIDER_TYPES.join('・')} のどれかにしてください。`);
    const allowed = names(`${w}.allowed_names`, p.allowed_names);
    if (allowed.length === 0) throw new GlobalPatchError(`${w}: allowed_names（このプロバイダで証明してよい名前）が要ります。`);
    // 種類が使わない項目は送らない（欄も出さない。種類を変えたときに残った値で断られないように）
    const zones = providerTakes(type, 'zones') ? names(`${w}.zones`, p.zones) : [];
    const ttl = providerTakes(type, 'ttl') ? p.ttl.trim() : '';
    if (ttl !== '' && (!/^[0-9]{1,10}$/.test(ttl) || Number(ttl) > 4294967295)) throw new GlobalPatchError(`${w}.ttl: 0〜4294967295 の整数にしてください。`);
    const out: Record<string, unknown> = { type: type };
    const need = (k: string, v: string | undefined) => {
      if (v === undefined) throw new GlobalPatchError(`${w}: ${type} には ${k} が要ります。`);
      out[k] = v;
    };
    if (type === 'powerdns') {
      need('api_url', text(`${w}.api_url`, p.api_url));
      const sid = text(`${w}.server_id`, p.server_id);
      if (sid !== undefined) out.server_id = sid;
      need('api_key_file', file(`${w}.api_key_file`, p.api_key_file));
    } else if (type === 'http') {
      const add = buildCall(`${w}.add`, p.add);
      const remove = buildCall(`${w}.remove`, p.remove);
      if (add === undefined || remove === undefined) throw new GlobalPatchError(`${w}: http には add と remove（TXT を書く・消す呼び出し）の両方が要ります。`);
      out.add = add;
      out.remove = remove;
      const secret = file(`${w}.secret_file`, p.secret_file);
      if (secret !== undefined) out.secret_file = secret;
      else if (usesSecret(add) || usesSecret(remove)) throw new GlobalPatchError(`${w}: {secret} を使うときは secret_file が要ります。`);
    } else if (type === 'rfc2136') {
      need('server', text(`${w}.server`, p.server));
      need('tsig_key_name', text(`${w}.tsig_key_name`, p.tsig_key_name));
      const alg = p.tsig_algorithm.trim();
      if (alg !== '') {
        if (!TSIG_ALGORITHMS.includes(alg)) throw new GlobalPatchError(`${w}.tsig_algorithm: ${TSIG_ALGORITHMS.join('・')} のどちらかにしてください。`);
        out.tsig_algorithm = alg;
      }
      need('tsig_secret_file', file(`${w}.tsig_secret_file`, p.tsig_secret_file));
    } else {
      need('api_url', text(`${w}.api_url`, p.api_url));
      need('credentials_file', file(`${w}.credentials_file`, p.credentials_file));
    }
    if (type === 'powerdns' || type === 'acme_dns') checkHttpUrl(`${w}.api_url`, out.api_url as string);
    const ca = file(`${w}.ca_file`, p.ca_file);
    if (ca !== undefined) out.ca_file = ca;
    if (zones.length > 0) out.zones = zones;
    out.allowed_names = allowed;
    if (ttl !== '') out.ttl = Number(ttl);
    providers[p.name.trim()] = out;
  }

  const resolvers: Record<string, unknown> = {};
  for (const r of form.resolvers) {
    const w = `acme.resolvers.${r.name.trim()}`;
    const account = r.account.trim();
    if (!(account in accounts)) throw new GlobalPatchError(`${w}.account: アカウント ${account || '（空）'} がありません。`);
    const challenge = r.challenge.trim();
    if (!(CHALLENGES as readonly string[]).includes(challenge)) throw new GlobalPatchError(`${w}.challenge: ${CHALLENGES.join('・')} のどれかにしてください。`);
    const dns = r.dns_provider.trim();
    if (challenge === 'dns-01' && !(dns in providers)) throw new GlobalPatchError(`${w}.dns_provider: dns-01 には DNS のプロバイダ ${dns || '（空）'} が要ります。`);
    if (challenge !== 'dns-01' && dns !== '') throw new GlobalPatchError(`${w}.dns_provider: DNS のプロバイダは dns-01 だけで使います。`);
    resolvers[r.name.trim()] = { account: account, challenge: challenge, ...(dns !== '' ? { dns_provider: dns } : {}) };
  }

  const helper = file('acme.helper.socket', form.helper_socket);
  const storage = text('acme.storage', form.storage);

  // ファイルはすべて同じディレクトリ（RPROXY_API_ACME_DIR）のすぐ下
  const dirs = new Set(files.map(([w, p]) => apiDirFile(w, p)));
  if (dirs.size > 1) {
    throw new GlobalPatchError('acme: 指すファイルはすべて同じディレクトリ（rproxy-api の RPROXY_API_ACME_DIR）のすぐ下に置いてください。');
  }
  if (storage !== undefined && lexicalPath(storage) !== ACME_DEFAULT_STORAGE) {
    if (!storage.startsWith('/')) throw new GlobalPatchError(`acme.storage: 絶対パスにしてください: ${storage}`);
    const [dir] = [...dirs];
    const s = lexicalPath(storage);
    if (dir !== undefined && !s.startsWith(dir === '/' ? '/' : `${dir}/`)) {
      throw new GlobalPatchError(`acme.storage: 既定（${ACME_DEFAULT_STORAGE}）にするか、ファイルと同じ RPROXY_API_ACME_DIR の下のディレクトリにしてください。`);
    }
  }

  const listen = splitList(form.http01_listen).map((x) => noMasked('acme.http01_listen', x));
  for (const l of listen) {
    const port = /:([0-9]{1,5})$/.exec(l);
    if (!/^(\[[0-9A-Fa-f:.]+\]|[0-9.]+):[0-9]{1,5}$/.test(l) || !port || Number(port[1]) < 1 || Number(port[1]) > 65535) throw new GlobalPatchError(`acme.http01_listen: ip:port（IPv6 は [::]:80）にしてください: ${l}`);
  }
  const dnsServers = splitList(form.dns_servers).map((x) => noMasked('acme.dns_servers', x));
  for (const [k, v] of [['renew_before', form.renew_before], ['dns_propagation_timeout', form.dns_propagation_timeout], ['rate_limit.period', form.rate_period]]) {
    const s = v.trim();
    if (s !== '' && !ACME_DURATION.test(s)) throw new GlobalPatchError(`acme.${k}: 30d・2m のように数と単位（s・m・h・d）で指定してください: ${s}`);
  }
  const orders = form.rate_orders.trim();
  if (orders !== '' && (!/^[0-9]+$/.test(orders) || Number(orders) < 1)) throw new GlobalPatchError(`acme.rate_limit.orders: 1 以上の整数にしてください: ${orders}`);
  if (orders === '' && form.rate_period.trim() !== '') throw new GlobalPatchError('acme.rate_limit: period だけでなく orders も書いてください。');

  if (storage !== undefined) out.storage = storage;
  if (Object.keys(accounts).length > 0) out.accounts = accounts;
  if (Object.keys(providers).length > 0) out.dns_providers = providers;
  if (Object.keys(resolvers).length > 0) out.resolvers = resolvers;
  if (orders !== '') out.rate_limit = { orders: Number(orders), ...(form.rate_period.trim() !== '' ? { period: form.rate_period.trim() } : {}) };
  if (form.renew_before.trim() !== '') out.renew_before = form.renew_before.trim();
  if (dnsServers.length > 0) out.dns_servers = dnsServers;
  if (form.dns_propagation_timeout.trim() !== '') out.dns_propagation_timeout = form.dns_propagation_timeout.trim();
  if (listen.length > 0) out.http01_listen = listen;
  if (helper !== undefined) out.helper = { socket: helper };
  if (Object.keys(accounts).length === 0) throw new GlobalPatchError('acme: アカウントが 1 つ以上要ります。');
  return out;
}
