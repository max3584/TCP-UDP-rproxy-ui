// ロール（Keycloak のアクセストークンのクレーム）による権限（tests/roles.test.ts）。
// サーバ側（NextAuth のコールバックと API route）で使う。画面は session.user.access を見て表示を変えるだけ

import { parseCidr } from './cidr';

// admin: すべての利用者のルールを一覧・変更・削除できる / user: 自分のルールだけ / none: 使えない（403）
export type Access = 'admin' | 'user' | 'none';

export interface RoleConfig {
  // ロールを読むクレームの位置（ドット区切り。既定 realm_access.roles。クライアントロールなら resource_access.<client>.roles）
  claim: string;
  adminRole: string;
  // 利用者のロール。空（既定）なら利用者はいない（admin のロールのある人だけが使える。#155 で既定を変えた。
  // v0.4.8 までは、空ならサインインできる人がだれでも user だった）
  userRole: string;
  // user（admin 以外）が待ち受けに使えるポートの範囲。null なら制限なし
  userPorts: [number, number] | null;
  // user（admin 以外）が触れるノード（RPROXY_UI_USER_NODES。#98）。null なら制限なし。
  // グループは、そのノードがすべてここにあるときだけ使える。RPROXY_UI_NODES がないとき（1 台）は使わない
  userNodes: string[] | null;
  // user（admin 以外）が転送先に使える宛先（RPROXY_UI_USER_TARGETS。#155）。null なら許可リストなし（断る宛先だけを断る）
  userTargets: UserTargets | null;
  // user（admin 以外）が使える登録済みの証明書の名前の先頭（RPROXY_UI_USER_CERTS。#155）。null なら制限なし
  userCerts: string[] | null;
  // user（admin 以外）がいつも使えない宛先（RPROXY_UI_PROTECTED_TARGETS。CIDR か CIDR:ポート。#155 のレビュー M3）。
  // 許可リストに入っていても断る（別のホストの DB・Kubernetes の Service の CIDR など）
  protectedTargets: ProtectedTarget[];
}

// port が null ならすべてのポート
export interface ProtectedTarget {
  cidr: string;
  port: number | null;
}

// 転送先の許可リスト：CIDR（正規化した形）とホスト名（完全一致か、*.example.com で下の名前すべて）
export interface UserTargets {
  cidrs: string[];
  names: string[];
}

export class RoleConfigError extends Error {}

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

function parseTargets(value: string | undefined): UserTargets | null {
  const list = (value ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (list.length === 0) return null;
  const out: UserTargets = { cidrs: [], names: [] };
  for (const item of list) {
    const c = parseCidr(item);
    if (c.ok) {
      out.cidrs.push(c.value);
      continue;
    }
    const name = item.toLowerCase().replace(/\.$/, '');
    const bare = name.startsWith('*.') ? name.slice(2) : name;
    if (!HOST_NAME.test(bare) || /^[0-9.]+$/.test(bare)) {
      throw new RoleConfigError(`RPROXY_UI_USER_TARGETS は CIDR・IP アドレス・ホスト名（*.example.com も可）をカンマで区切って書いてください: ${item}`);
    }
    out.names.push(name);
  }
  return out;
}

function parseProtected(value: string | undefined): ProtectedTarget[] {
  const list = (value ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  return list.map((item) => {
    let addr = item;
    let port: number | null = null;
    const bracket = /^\[([^\]]+)\](?::([0-9]+))?$/.exec(item);
    if (bracket) {
      addr = bracket[1];
      port = bracket[2] !== undefined ? Number(bracket[2]) : null;
    } else if ((item.match(/:/g) ?? []).length === 1) {
      const i = item.indexOf(':');
      addr = item.slice(0, i);
      port = /^[0-9]+$/.test(item.slice(i + 1)) ? Number(item.slice(i + 1)) : NaN;
    }
    const c = parseCidr(addr);
    if (!c.ok || (port !== null && !(Number.isInteger(port) && port >= 1 && port <= 65535))) {
      throw new RoleConfigError(`RPROXY_UI_PROTECTED_TARGETS は CIDR か CIDR:ポート（IPv6 は [2001:db8::/64]:5432）をカンマで区切って書いてください: ${item}`);
    }
    return { cidr: c.value, port: port };
  });
}

function parseCertPrefixes(value: string | undefined): string[] | null {
  const list = (value ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (list.length === 0) return null;
  const bad = list.find((n) => !/^[a-z0-9][a-z0-9._-]*$/.test(n));
  if (bad !== undefined) throw new RoleConfigError(`RPROXY_UI_USER_CERTS は証明書の名前の先頭をカンマで区切って書いてください: ${bad}`);
  return list;
}

function parsePorts(value: string): [number, number] {
  const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(value);
  const lo = m ? Number(m[1]) : NaN;
  const hi = m ? Number(m[2] ?? m[1]) : NaN;
  if (!(lo >= 1 && hi <= 65535 && lo <= hi)) {
    throw new RoleConfigError(`RPROXY_UI_USER_PORTS は 1024-65535 のように書いてください: ${value}`);
  }
  return [lo, hi];
}

function parseNodes(value: string | undefined): string[] | null {
  const list = (value ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (list.length === 0) return null;
  const bad = list.find((n) => !/^[a-z0-9][a-z0-9_]{0,31}$/.test(n));
  if (bad !== undefined) throw new RoleConfigError(`RPROXY_UI_USER_NODES はノードの名前をカンマで区切って書いてください: ${bad}`);
  return list;
}

// 環境変数から読む。未設定なら既定（realm_access.roles、rproxy-admin、利用者なし、ポート・宛先の許可リストなし）
export function roleConfig(env: Record<string, string | undefined> = process.env): RoleConfig {
  const ports = env.RPROXY_UI_USER_PORTS?.trim();
  return {
    claim: env.RPROXY_UI_ROLES_CLAIM?.trim() || 'realm_access.roles',
    adminRole: env.RPROXY_UI_ADMIN_ROLE?.trim() || 'rproxy-admin',
    userRole: env.RPROXY_UI_USER_ROLE?.trim() ?? '',
    userPorts: ports ? parsePorts(ports) : null,
    userNodes: parseNodes(env.RPROXY_UI_USER_NODES),
    userTargets: parseTargets(env.RPROXY_UI_USER_TARGETS),
    userCerts: parseCertPrefixes(env.RPROXY_UI_USER_CERTS),
    protectedTargets: parseProtected(env.RPROXY_UI_PROTECTED_TARGETS),
  };
}

// アクセストークンは発行元からバックチャネルで受け取ったものなので、署名は検証せずに中身だけを読む
export function rolesFromToken(accessToken: string, claim: string): string[] {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
    let value: unknown = payload;
    for (const part of claim.split('.')) {
      value = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[part] : undefined;
    }
    return Array.isArray(value) ? value.filter((r: unknown): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

export function accessOf(roles: readonly string[], cfg: RoleConfig): Access {
  if (roles.includes(cfg.adminRole)) return 'admin';
  // 利用者のロールを決めていなければ、admin でない人は使えない（#155。サインインできる人をだれでも利用者にしない）
  if (cfg.userRole !== '' && roles.includes(cfg.userRole)) return 'user';
  return 'none';
}

// user が listen ポート first..last を使えるか（admin は常に使える）
export function portsAllowed(access: Access, cfg: RoleConfig, first: number, last: number): boolean {
  if (access === 'admin' || cfg.userPorts === null) return true;
  return cfg.userPorts[0] <= first && last <= cfg.userPorts[1];
}

// user がこのノードの集まり（ノード、またはグループのノード）を触れるか（admin は常に触れる）
export function nodesAllowed(access: Access, cfg: RoleConfig, nodes: readonly string[]): boolean {
  if (access === 'admin' || cfg.userNodes === null) return true;
  return nodes.length > 0 && nodes.every((n) => cfg.userNodes!.includes(n));
}
