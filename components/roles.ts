// ロール（Keycloak のアクセストークンのクレーム）による権限（tests/roles.test.ts）。
// サーバ側（NextAuth のコールバックと API route）で使う。画面は session.user.access を見て表示を変えるだけ

// admin: すべての利用者のルールを一覧・変更・削除できる / user: 自分のルールだけ / none: 使えない（403）
export type Access = 'admin' | 'user' | 'none';

export interface RoleConfig {
  // ロールを読むクレームの位置（ドット区切り。既定 realm_access.roles。クライアントロールなら resource_access.<client>.roles）
  claim: string;
  adminRole: string;
  // 空なら、サインインできる人はだれでも user（ロールを使わない運用。既定。v0.3.1 までと同じ）
  userRole: string;
  // user（admin 以外）が待ち受けに使えるポートの範囲。null なら制限なし
  userPorts: [number, number] | null;
}

export class RoleConfigError extends Error {}

function parsePorts(value: string): [number, number] {
  const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(value);
  const lo = m ? Number(m[1]) : NaN;
  const hi = m ? Number(m[2] ?? m[1]) : NaN;
  if (!(lo >= 1 && hi <= 65535 && lo <= hi)) {
    throw new RoleConfigError(`RPROXY_UI_USER_PORTS は 1024-65535 のように書いてください: ${value}`);
  }
  return [lo, hi];
}

// 環境変数から読む。未設定なら既定（realm_access.roles、rproxy-admin、user のロールは問わない、ポートの制限なし）
export function roleConfig(env: Record<string, string | undefined> = process.env): RoleConfig {
  const ports = env.RPROXY_UI_USER_PORTS?.trim();
  return {
    claim: env.RPROXY_UI_ROLES_CLAIM?.trim() || 'realm_access.roles',
    adminRole: env.RPROXY_UI_ADMIN_ROLE?.trim() || 'rproxy-admin',
    userRole: env.RPROXY_UI_USER_ROLE?.trim() ?? '',
    userPorts: ports ? parsePorts(ports) : null,
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
  if (cfg.userRole === '' || roles.includes(cfg.userRole)) return 'user';
  return 'none';
}

// user が listen ポート first..last を使えるか（admin は常に使える）
export function portsAllowed(access: Access, cfg: RoleConfig, first: number, last: number): boolean {
  if (access === 'admin' || cfg.userPorts === null) return true;
  return cfg.userPorts[0] <= first && last <= cfg.userPorts[1];
}
