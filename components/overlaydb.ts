// UI が固定ルールに重ねた分の正しい形（forward_rule_overlays。migration 015、#197）と、1 つのノードへの送り直し。サーバ側だけで使う。
// rproxy は UI のトークン（persist: false）の重ねる分を保存しないので、再起動で消える。UI はこの表を正として、rproxy にない・違う
// 重ねる分を「ずれ」に出し、送り直す（API route の overlay-resend・overlay-resend-all と、act / stb の自動の送り直し（hasync.ts））
import type { PoolConnection } from 'mariadb';
import type { ForwardRule, OverlayDrift, Protocol } from './lib';
import type { OverlaySpec, OverlayView } from './overlay';
import { overlaySpecOf } from './overlay';
import { overlayDrift } from './drift';
import { RproxyRuleKey, RproxyRuleStatus, getOverlay, putOverlay } from './rproxy';
import { isNotFound } from './ruledb';
import { ruleFromStatus } from './dashboard';

type Db = Pick<PoolConnection, 'query'>;

// RPROXY_UI_NODES を使わない 1 台のノードの名前（nodes.ts の implicitConfig、migration 006 の target の既定と同じ）
export const DEFAULT_OVERLAY_NODE = 'default';

export interface DesiredOverlay {
  node: string;
  key: RproxyRuleKey;
  spec: OverlaySpec;
  // 作った UI の利用者（auth_id）。管理者でない人が直せるのはこれが自分のものだけ
  createdBy: string | null;
}

const COLUMNS = 'node, protocol, listen_addr, listen_port, spec, created_by';

function fromRow(row: any): DesiredOverlay | null {
  let spec: unknown = row?.spec;
  if (typeof spec === 'string') {
    try {
      spec = JSON.parse(spec);
    } catch {
      return null;
    }
  }
  const port = Number(row?.listen_port);
  if (typeof row?.node !== 'string' || typeof row?.listen_addr !== 'string' || !Number.isInteger(port)) return null;
  return {
    node: row.node,
    key: { protocol: String(row.protocol).toLowerCase() as Protocol, listen_addr: row.listen_addr, listen_port: port },
    spec: overlaySpecOf(spec),
    createdBy: row.created_by === null || row.created_by === undefined ? null : String(row.created_by),
  };
}

export const overlayKeyString = (key: RproxyRuleKey) => `${key.protocol}|${key.listen_addr.toLowerCase()}|${key.listen_port}`;

// テーブルがない（1146：015 を当てていない）
export function isMissingTable(err: unknown): boolean {
  return (err as { errno?: number })?.errno === 1146;
}

// 1 件（テーブルがない（isMissingTable）などの誤りはそのまま投げる。呼ぶ側が rproxy を変える前に断る）
export async function desiredOverlay(db: Db, node: string, key: RproxyRuleKey): Promise<DesiredOverlay | null> {
  const rows = await db.query(`SELECT ${COLUMNS} FROM forward_rule_overlays WHERE node = ? AND protocol = ? AND listen_addr = ? AND listen_port = ?`,
    [node, key.protocol, key.listen_addr, key.listen_port]);
  return Array.isArray(rows) && rows.length > 0 ? fromRow(rows[0]) : null;
}

// ノード（null ならすべて）の分。テーブルがなければ空（ずれの表示・送り直しは止めるだけ）
export async function loadDesiredOverlays(db: Db, nodes: string[] | null): Promise<DesiredOverlay[]> {
  if (nodes !== null && nodes.length === 0) return [];
  try {
    const rows = nodes === null
      ? await db.query(`SELECT ${COLUMNS} FROM forward_rule_overlays ORDER BY node, protocol, listen_addr, listen_port`)
      : await db.query(`SELECT ${COLUMNS} FROM forward_rule_overlays WHERE node IN (${nodes.map(() => '?').join(', ')}) ORDER BY node, protocol, listen_addr, listen_port`, nodes);
    return (Array.isArray(rows) ? rows : []).map(fromRow).filter((d): d is DesiredOverlay => d !== null);
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

// 足す・置き換える（作った人は最初の行のまま）
export async function saveDesiredOverlay(db: Db, node: string, key: RproxyRuleKey, spec: OverlaySpec, createdBy: string | null, by: string): Promise<void> {
  await db.query(
    'INSERT INTO forward_rule_overlays (node, protocol, listen_addr, listen_port, spec, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE spec = VALUES(spec), updated_by = VALUES(updated_by)',
    [node, key.protocol, key.listen_addr, key.listen_port, JSON.stringify(spec), createdBy, by]
  );
}

export async function removeDesiredOverlay(db: Db, node: string, key: RproxyRuleKey): Promise<void> {
  await db.query('DELETE FROM forward_rule_overlays WHERE node = ? AND protocol = ? AND listen_addr = ? AND listen_port = ?',
    [node, key.protocol, key.listen_addr, key.listen_port]);
}

// そのノード（withNode の中）の今の重ねる分。なければ null
export async function liveOverlay(key: RproxyRuleKey): Promise<{ view: OverlayView; etag: string | null } | null> {
  try {
    return await getOverlay(key);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

// そのノード（withNode の中）での違い。status はそのキーの GET /rules の 1 件（固定ルールでなければ見ない＝null）。
// GET /rules の overlay がなければ聞かずに missing、あれば GET …/overlay で中身を比べる
export async function overlayDriftOnNode(desired: DesiredOverlay, status: RproxyRuleStatus | undefined): Promise<OverlayDrift | null> {
  if (!status || status.origin !== 'static') return null;
  if (!status.overlay) return 'missing';
  const live = await liveOverlay(desired.key);
  return overlayDrift(desired.spec, live ? overlaySpecOf(live.view) : null);
}

export type OverlayResendResult = 'added' | 'modified' | 'unchanged';

// そのノード（withNode の中）の重ねる分を UI の DB の形に揃える。違いがなければ何もしない。
// ETag を付けて送る（読んでから送るまでにほかの人が変えれば rproxy の 412）
export async function resendOverlayOne(desired: DesiredOverlay): Promise<{ result: OverlayResendResult; view?: OverlayView }> {
  const live = await liveOverlay(desired.key);
  if (live === null) return { result: 'added', view: (await putOverlay(desired.key, desired.spec, null)).view };
  if (overlayDrift(desired.spec, overlaySpecOf(live.view)) === null) return { result: 'unchanged' };
  return { result: 'modified', view: (await putOverlay(desired.key, desired.spec, live.etag ?? live.view.etag)).view };
}

// 送り直しの履歴（OVERLAY。options の resend: true で、変更とは別に出す。created_at は rproxy の新しい時刻）
export async function insertOverlayResendLog(db: Db, actor: string, node: string | null, file: ForwardRule, spec: OverlaySpec, createdAt?: number): Promise<void> {
  const opts = JSON.stringify({ overlay: spec, resend: true, ...(typeof createdAt === 'number' ? { created_at: createdAt } : {}) });
  if (node !== null) {
    await db.query(
      'INSERT INTO forward_rules_log (auth_id, target, node, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options, update_action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [actor, node, node, file.protocol, file.srcAddr, file.srcPort, file.srcPortEnd, '', 0, file.sourceIp, file.udpIdleSecs, opts, 'OVERLAY']
    );
  } else {
    await db.query(
      'INSERT INTO forward_rules_log (auth_id, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options, update_action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [actor, file.protocol, file.srcAddr, file.srcPort, file.srcPortEnd, '', 0, file.sourceIp, file.udpIdleSecs, opts, 'OVERLAY']
    );
  }
}

export interface OverlayCheck {
  desired: DesiredOverlay;
  // その待ち受けの固定ルール（履歴の行に使う）
  file: ForwardRule;
  drift: OverlayDrift | null;
}

// そのノード（withNode の中）で、UI の DB の重ねる分を rproxy の今の重ねる分と比べる（statuses はそのノードの GET /rules）。
// 固定ルールがない（設定ファイルから消えた）ものは比べない（重ねる先がない）
export async function checkOverlaysOnNode(desired: DesiredOverlay[], statuses: RproxyRuleStatus[]): Promise<OverlayCheck[]> {
  const byKey = new Map(statuses.filter((s) => s.origin === 'static').map((s) => [overlayKeyString({ protocol: String(s.protocol).toLowerCase() as Protocol, listen_addr: s.listen_addr, listen_port: s.listen_port }), s]));
  const out: OverlayCheck[] = [];
  for (const d of desired) {
    const status = byKey.get(overlayKeyString(d.key));
    if (!status) continue;
    out.push({ desired: d, file: ruleFromStatus(status, -1), drift: await overlayDriftOnNode(d, status) });
  }
  return out;
}

// そのノード（withNode の中）に送り直し、変えたら履歴を残す（logNode はノードを設定していなければ null）。
// 履歴を書けなくても送り直しは戻さない（rproxy を UI の DB の形に揃えただけ）
export async function resendOverlayWithLog(db: Db, actor: string, logNode: string | null, check: Pick<OverlayCheck, 'desired' | 'file'>, onLogError: (err: unknown) => void): Promise<OverlayResendResult> {
  const { result, view } = await resendOverlayOne(check.desired);
  if (result !== 'unchanged') {
    await insertOverlayResendLog(db, actor, logNode, check.file, check.desired.spec, view?.created_at).catch(onLogError);
  }
  return result;
}
