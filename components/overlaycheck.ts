// 利用者（admin でない人）の制限の確かめ（#155）と、固定ルールに重ねる分の確かめ（#193）。サーバ側だけで使う。
// API route（pages/api/forward/[forward].ts）と、重ねる分の送り直しで持ち主として確かめ直す act / stb の自動の送り直し（hasync.ts、#197）が共有する
import type { ForwardRule, ForwardRules } from './lib';
import { Logger } from './lib';
import type { Overrides } from './overrides';
import { RproxyNode, getInterfaces, withNode } from './rproxy';
import type { NodesConfig } from './nodes';
import { Access, RoleConfig, certPrefixesFor, nodesAllowed, portsAllowed, roleConfig } from './roles';
import { addedRefs, certAllowed, certNames, destKey, fileKey, fileRefs, locatedDests, oidcConfigs, userCacheProblem } from './userlimits';
import type { DestRef } from './userlimits';
import { checkDestinations, protectedAddrs, refusalText, resolveHost } from './usertargets';
import type { InterfacesInfo } from './listen';
import { OverlaySpec, fileNames, fileServicesForbidden, forwardingIdentityProblems, overlayAsRule, overlayConflicts, overlayShape, secretFileItemsUsed } from './overlay';
import { toHttpRules, validateHttp } from './httpspec';
import { TlsError, checkTls, normalizeTls } from './tls';

type AppLogger = ReturnType<typeof Logger>;

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code: string) {
    super(message);
  }
}

// 操作する利用者（[forward].ts の Actor と同じ形）
export interface UserActor {
  id: string;
  access: Access;
  roles: RoleConfig;
  cfg: NodesConfig;
  certPrefixes: string[] | null;
}

function invalid(message: string): HttpError {
  return new HttpError(400, message, 'invalid');
}

// 前の内容（変更・置き換えでは今のルール）。ここにある値は、変えなければそのまま残せる
export interface Before {
  rule: ForwardRule;
  overrides?: Overrides;
}

// 守る相手（rproxy の制御 API・UI・DB）。置き場所のノードの GET /interfaces の予約済みのアドレスも使う（取れなければそのノードは飛ばす）
async function protectedFor(actor: UserActor, place: { nodes: RproxyNode[] }, logger: AppLogger) {
  const interfaces: InterfacesInfo[] = [];
  for (const node of place.nodes) {
    try {
      const info = await withNode(node, () => getInterfaces());
      if (info && typeof info === 'object') interfaces.push(info);
    } catch (err) {
      logger.warn(`rproxy（${node.name}）のインターフェースを取得できません（制御 API のアドレスは設定の URL だけで確かめます）: ${err}`);
    }
  }
  const apiUrls = [process.env.RPROXY_API_URL ?? '', ...actor.cfg.nodes.map((n) => n.url)].filter((u) => /^https?:\/\//.test(u));
  return protectedAddrs({ env: process.env, apiUrls: apiUrls, interfaces: interfaces });
}

// 利用者のルールのうち、その場で決まるものを確かめる（admin は何もしない）。確かめる転送先（前の内容にないものと、読めない URL）を返す：
// - サーバのファイルを指す項目は、前の内容にない値を断る（403 file_not_allowed）
// - 登録済みの証明書の名前は、前の内容になく利用者の先頭（RPROXY_UI_USER_CERTS・割り当て。certPrefixesFor）の外なら断る（403 cert_not_allowed）
// - oidc のミドルウェアは、前の内容と同じ設定でなければ断る（403 middleware_not_allowed。discovery の先を確かめられないため）
// - cache のミドルウェアは、前の内容と同じ設定でなければ share_after_auth・share_credentials を断り（403 middleware_not_allowed）、
//   max_memory・max_entries（省けば rproxy の既定）が RPROXY_UI_USER_CACHE_MAX_* を超えれば断る（403 cache_limit。#175）
export function userRuleSync(actor: UserActor, rule: ForwardRule, overrides: Overrides | undefined, before: Before | null): DestRef[] {
  if (actor.access === 'admin') return [];
  const files = addedRefs(fileRefs(rule), fileRefs(before?.rule), fileKey);
  if (files.length > 0) {
    const where = [...new Set(files.map((f) => f.where))].join(', ');
    throw new HttpError(403, `ファイルのパス（${where}）は管理者だけが指定できます。証明書は登録済みの証明書の名前（tls.certificates[].cert）から選んでください。`, 'file_not_allowed');
  }
  const oldCerts = new Set(certNames(before?.rule));
  const certs = certNames(rule).filter((n) => !oldCerts.has(n) && !certAllowed(n, actor.certPrefixes));
  if (certs.length > 0) {
    throw new HttpError(403, `登録済みの証明書 ${certs.join(', ')} はこの利用者には使えません（RPROXY_UI_USER_CERTS・RPROXY_UI_USER_CERTS_BY_SUB・RPROXY_UI_USER_CERTS_BY_ROLE）。`, 'cert_not_allowed');
  }
  const oldOidc = new Set(oidcConfigs(before?.rule));
  if (oidcConfigs(rule).some((c) => !oldOidc.has(c))) {
    throw new HttpError(403, 'OIDC のミドルウェアは管理者だけが足したり変えたりできます（rproxy がつなぐ先を UI が確かめられないため）。', 'middleware_not_allowed');
  }
  const cache = userCacheProblem(rule, before?.rule, { maxMemory: actor.roles.userCacheMaxMemory, maxEntries: actor.roles.userCacheMaxEntries });
  if (cache) throw new HttpError(403, cache.message, cache.code);
  const next = locatedDests(rule, overrides);
  const old = before ? locatedDests(before.rule, before.overrides) : [];
  // 読めない URL は前からあっても確かめる（断る）
  return [...addedRefs(next.filter((d) => !d.invalid), old, destKey), ...next.filter((d) => d.invalid)];
}

// 転送先を確かめる（403 target_not_allowed）
export async function checkUserDests(actor: UserActor, place: { nodes: RproxyNode[] }, dests: DestRef[], logger: AppLogger): Promise<void> {
  if (actor.access === 'admin' || dests.length === 0) return;
  const refused = await checkDestinations(dests, actor.roles.userTargets, { resolve: resolveHost, protectedAddrs: await protectedFor(actor, place, logger), protectedCidrs: actor.roles.protectedTargets });
  if (refused.length > 0) {
    throw new HttpError(403, `利用者はこの転送先を使えません: ${refusalText(refused)}`, 'target_not_allowed');
  }
}

// 重ねる分を確かめる（rproxy の前に、画面の言葉で断る。細かい検証は rproxy）
export async function checkOverlaySpec(actor: UserActor, t: OverlayTarget, spec: OverlaySpec, before: OverlaySpec | null, logger: AppLogger): Promise<OverlaySpec> {
  const shape = overlayShape(t.file);
  if (spec.http && !shape.http) throw invalid('このルールには http がないので、http のルート・サービス・ミドルウェアは重ねられません。');
  if (spec.tls && !shape.tlsRoutes) {
    throw invalid('サーバ名ごとの転送先（tls.routes）を重ねられるのは、TLS のモードが sni のルールか、http もクライアント認証もない terminate のルールだけです。');
  }
  const conflicts = overlayConflicts(fileNames(t.file), spec);
  if (conflicts.length > 0) {
    throw new HttpError(409, `設定ファイルにある名前は使えません: ${conflicts.map((c) => `${c.kind} ${c.name}（${c.reason}）`).join(', ')}`, 'overlay_conflict');
  }
  // 利用者がファイルのサービスへたどり着くか（形の検証より先に、理由をはっきり返す）
  if (actor.access !== 'admin') {
    // 重ねる分のルートはファイルのサービスにファイルのルートのミドルウェアを通らずに届き、その転送先は利用者の許可リストの外なので、
    // 管理者でない人はファイルのサービスを使えない（自分のサービスを定義する。ファイルの秘密のないミドルウェアは使える）
    // ファイルのミドルウェア（mirror・errors）やサービスの servers[].middlewares を通ってたどり着くものも。ファイルの forward_auth の先だけは除く
    const services = fileServicesForbidden(spec, t.file.http);
    if (services.length > 0) {
      throw new HttpError(403, `設定ファイルのサービス（${services.join(', ')}）は管理者だけが重ねる分から使えます（重ねる分のルートはファイルのルートのミドルウェアを通らずにその転送先へ届き、転送先は利用者の許可リストの外のため）。重ねる分に自分のサービスを定義してください。`, 'file_service_not_allowed');
    }
  }
  const errors: string[] = [];
  if (spec.http) {
    const file = toHttpRules(t.file.http);
    const merged = {
      ...file,
      routes: [...file.routes, ...(spec.http.routes ?? [])],
      services: { ...(file.services ?? {}), ...(spec.http.services ?? {}) },
      middlewares: { ...(file.middlewares ?? {}), ...(spec.http.middlewares ?? {}) },
    };
    // 設定ファイルの分だけで出る誤りは重ねる分のせいではないので除く
    const own = new Set(validateHttp(file));
    errors.push(...validateHttp(merged).filter((e) => !own.has(e)));
    errors.push(...forwardingIdentityProblems(spec.http.middlewares));
  }
  let tlsRoutes = spec.tls?.routes;
  if (tlsRoutes !== undefined) {
    if (tlsRoutes.some((r) => r && typeof r === 'object' && 'upstream' in r)) errors.push('重ねる分のサーバ名ごとの転送先には、転送先への TLS（upstream）を書けません（ルールのものを使います）。');
    try {
      const tls = normalizeTls({ ...t.file.tls, routes: tlsRoutes });
      checkTls(t.file.protocol, tls, null, (t.file.srcPortEnd ?? t.file.srcPort) - t.file.srcPort + 1, false);
      tlsRoutes = tls.routes;
    } catch (err) {
      if (err instanceof TlsError) errors.push(err.message);
      else throw err;
    }
  }
  if (errors.length > 0) throw invalid(errors.join('\n'));
  const out: OverlaySpec = { ...spec, ...(tlsRoutes !== undefined ? { tls: { routes: tlsRoutes } } : {}) };
  if (actor.access !== 'admin') {
    const used = secretFileItemsUsed(out, t.file.http);
    const names = [...used.services.map((n) => `サービス ${n}`), ...used.middlewares.map((n) => `ミドルウェア ${n}`)];
    if (names.length > 0) {
      throw new HttpError(409, `設定ファイルの ${names.join('・')} は秘密のファイル（鍵・OIDC の秘密・users_file）を持つ（か、それを使う）ので、管理者だけが重ねる分から使えます。`, 'file_in_use');
    }
    const dests = userRuleSync(actor, overlayAsRule(t.file, out), undefined, before ? { rule: overlayAsRule(t.file, before) } : null);
    await checkUserDests(actor, t.place, dests, logger);
  }
  return out;
}

// 確かめる重ねる分の置き場所（置き場所のノードと、その固定ルール）
export interface OverlayTarget {
  place: { target: string | null; nodes: RproxyNode[] };
  file: ForwardRules;
}

// 重ねる分を送り直す前に、持ち主（作った人）としてもう一度確かめる（#197）。保存した後で、許可リスト（名前は解決し直す）・
// 守る相手・使えるノードとポート・ファイルのサービス・秘密のファイル・送り元のヘッダの決まりが変わっていれば断る（HttpError）。
// 前の内容（before）なしで確かめるので、前からあって残せただけの値も断る。owner.admin は中身を最後に書いた人が管理者だったか
// （created_by_admin）で、そうなら確かめない。RPROXY_UI_USER_ROLE が空（利用者がいない）なら確かめない。持ち主が分からなければ断る
export async function checkOverlayAsOwner(owner: { id: string | null; admin: boolean }, cfg: NodesConfig, t: OverlayTarget, spec: OverlaySpec, before: OverlaySpec | null, logger: AppLogger): Promise<void> {
  if (owner.admin) return;
  const roles = roleConfig();
  // RPROXY_UI_USER_ROLE が空なら利用者はいない（管理者だけ）ので、だれが書いたものも管理者のものとして確かめない
  if (roles.userRole === '') return;
  if (owner.id === null) {
    throw new HttpError(403, 'この重ねる分を作った利用者が分からないので、送り直せません（管理者が直すか外してください）。', 'overlay_owner_unknown');
  }
  const actor: UserActor = { id: owner.id, access: 'user', roles: roles, cfg: cfg, certPrefixes: certPrefixesFor('user', roles, owner.id, []) };
  if (t.place.target !== null && !nodesAllowed('user', roles, t.place.nodes.map((n) => n.name))) {
    throw new HttpError(403, `ノード ${t.place.nodes.map((n) => n.name).join(', ')} は管理者だけが触れます。`, 'node_not_allowed');
  }
  if (!portsAllowed('user', roles, t.file.srcPort, t.file.srcPortEnd ?? t.file.srcPort)) {
    throw new HttpError(403, `待ち受けポート ${t.file.srcPort} は管理者だけが使えます。`, 'port_not_allowed');
  }
  await checkOverlaySpec(actor, t, spec, before, logger);
}
