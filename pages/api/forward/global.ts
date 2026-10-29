import { NextApiRequest, NextApiResponse } from 'next';
import { Logger } from '@/components/lib';
import { apiTarget, getCapabilities, getGlobalSettings, patchGlobalSettings, withNode } from '@/components/rproxy';
import type { RproxyNode } from '@/components/rproxy';
import { NodesConfigError, loadNodes, targetNodes, toRproxyNode } from '@/components/nodes';
import type { NodesConfig } from '@/components/nodes';
import { requireRole, rproxyFailure } from '@/components/apiguard';
import { accessOf, roleConfig } from '@/components/roles';
import { GlobalPatchError, globalPatchBody, globalSettingsView, normalizeGlobalValues, redactRestartItems } from '@/components/globalsettings';
import { GlobalRouteError, applyGlobal, changeSummary, globalFailure } from '@/components/globalapi';
import type { GlobalChange, GlobalNodeResult, GlobalNodeView, GlobalSettings } from '@/components/globalsettings';
import { READONLY_NODE_MESSAGE } from '@/components/messages';
import { localizedApi } from '@/i18n/server';

// rproxy の global の設定（rproxy-api v0.4.19 の GET / PATCH /config/global、#342。UI #169）。管理者だけ。
// GET：ノードごとの項目（今の値・出どころ・変え方・API の値）。features.global_api のないノードは supported: false。
//   ?target= でノード／グループのノードだけ。問い合わせできないノードがあっても 200
// POST {target, values: {項目: 値 | null}, dryRun}：target（ノードかグループ）の全ノードに PATCH /config/global を送る。
//   dryRun はノードごとの結果（changes・applied・断り）を 200 で返す（何も変えない）。
//   適用は applyGlobal（components/globalapi.ts）：1 台でも断る・時間切れで分からなければ、効いたノードを前の API の値に戻し、
//   断ったノードのステータスで返す（nodes にノードごとの outcome・undone・コード）。
// rproxy の断りの返し方は components/globalapi.ts（globalFailure）

interface PlanNode {
  name: string;
  node: RproxyNode | null;
  readonly: boolean;
  transport: 'unix' | 'tcp';
}

function planNodes(cfg: NodesConfig, target: string | undefined): PlanNode[] {
  const make = (n: NodesConfig['nodes'][number]): PlanNode => ({
    name: n.name,
    // ノードを設定していなければ RPROXY_API_URL の 1 台（withNode の外で送る）
    node: cfg.configured ? toRproxyNode(n) : null,
    readonly: n.readonly === true,
    transport: apiTarget(n.url).socketPath !== undefined ? 'unix' : 'tcp',
  });
  if (!cfg.configured) {
    // ノードを設定していなくても、知らない名前は断る（1 台の名前は default）
    if (target !== undefined && target !== cfg.nodes[0]?.name) throw new GlobalRouteError(400, `ノード／グループ ${target} は設定にありません。`, 'unknown_target');
    return cfg.nodes.slice(0, 1).map(make);
  }
  if (target === undefined) return cfg.nodes.map(make);
  const nodes = targetNodes(cfg, target);
  if (nodes === null) throw new GlobalRouteError(400, `ノード／グループ ${target} は設定にありません。`, 'unknown_target');
  return nodes.map(make);
}

function run<T>(p: PlanNode, fn: () => Promise<T>): Promise<T> {
  return p.node ? withNode(p.node, fn) : fn();
}


async function nodeView(p: PlanNode): Promise<GlobalNodeView> {
  const base = { node: p.name, transport: p.transport, readonly: p.readonly };
  let supported = false;
  try {
    const caps = await run(p, () => getCapabilities());
    supported = caps.features?.global_api === true;
  } catch (err) {
    const f = rproxyFailure(err);
    return { ...base, reachable: false, supported: false, settings: null, error: f.error, code: f.code };
  }
  if (!supported) return { ...base, reachable: true, supported: false, settings: null, error: null, code: null };
  try {
    const raw = globalSettingsView(await run(p, () => getGlobalSettings()));
    // 再起動が要る項目（acme の contact・directory・eab など）の中身は画面に出さない
    const settings = raw ? redactRestartItems(raw) : null;
    return { ...base, reachable: true, supported: true, settings: settings, error: settings ? null : 'rproxy の応答を解釈できません。', code: settings ? null : 'bad_response' };
  } catch (err) {
    const f = globalFailure(err);
    return { ...base, reachable: true, supported: true, settings: null, error: f.error, code: f.code };
  }
}

function changesOf(raw: unknown): { changes: GlobalChange[]; applied: string[]; settings: GlobalSettings | null } {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    changes: Array.isArray(r.changes) ? (r.changes as GlobalChange[]).filter((c) => typeof c?.item === 'string') : [],
    applied: Array.isArray(r.applied) ? (r.applied as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    settings: r.dry_run === true ? null : globalSettingsView(raw),
  };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await requireRole(req, res);
  if (!session) return;
  if (accessOf(session.user.roles ?? [], roleConfig()) !== 'admin') {
    return res.status(403).json({ error: 'global の設定は管理者だけが見られます。', code: 'forbidden_admin' });
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed', code: 'method_not_allowed' });
  }
  const logger = Logger('info', { action: 'global' });
  let cfg: NodesConfig;
  try {
    cfg = loadNodes();
  } catch (err) {
    logger.error(`${err}`);
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'nodes_config' });
  }

  const body = (req.method === 'POST' && typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
  const rawTarget = req.method === 'GET' ? req.query.target : body.target;
  const target = typeof rawTarget === 'string' && rawTarget !== '' ? rawTarget : undefined;

  let nodes: PlanNode[];
  try {
    nodes = planNodes(cfg, target);
  } catch (err) {
    const f = globalFailure(err instanceof NodesConfigError ? new GlobalRouteError(400, err.message, 'unknown_target') : err);
    return res.status(f.status).json({ error: f.error, code: f.code });
  }

  if (req.method === 'GET') {
    const views = await Promise.all(nodes.map(nodeView));
    const groups = cfg.groups.filter((g) => !g.readonly).map((g) => ({ name: g.name, nodes: [...g.nodes] }));
    return res.status(200).json({ nodes: views, groups: groups });
  }

  // POST：変える
  if (cfg.configured && target === undefined && nodes.length > 1) {
    return res.status(400).json({ error: 'どのノード／グループに送るか（target）を指定してください。', code: 'target_required' });
  }
  if (nodes.some((n) => n.readonly)) {
    return res.status(409).json({ error: READONLY_NODE_MESSAGE, code: 'readonly_node' });
  }
  let values: Record<string, unknown>;
  try {
    values = normalizeGlobalValues(body.values);
  } catch (err) {
    if (err instanceof GlobalPatchError) return res.status(400).json({ error: err.message, code: 'invalid' });
    throw err;
  }
  const patch = globalPatchBody(values);
  const dryRun = body.dryRun === true;

  if (dryRun) {
    const results: GlobalNodeResult[] = await Promise.all(nodes.map(async (p): Promise<GlobalNodeResult> => {
      try {
        const r = changesOf(await run(p, () => patchGlobalSettings(patch, true)));
        return { node: p.name, ok: true, changes: r.changes, applied: r.applied };
      } catch (err) {
        const f = globalFailure(err);
        return { node: p.name, ok: false, error: f.error, code: f.code };
      }
    }));
    return res.status(200).json({ dryRun: true, nodes: results });
  }

  const who = session.user.name || session.user.email || session.user.id;
  const result = await applyGlobal(nodes.map((p) => ({ name: p.name, run: <T,>(fn: () => Promise<T>) => run(p, fn) })), values, logger);
  for (const n of result.nodes) {
    if (n.ok) logger.info(`global の設定を変えました（${who}、ノード ${n.node}）: ${changeSummary(n.changes ?? [])}`);
  }
  if (result.ok) return res.status(200).json({ nodes: result.nodes });
  logger.warn(`global の設定を変えられませんでした（${who}、ノード ${result.node}）: ${result.failure.code} ${result.failure.error}`);
  const error = nodes.length > 1 ? `ノード ${result.node}: ${result.failure.error}` : result.failure.error;
  return res.status(result.failure.status).json({ error: error, code: result.failure.code, nodes: result.nodes });
}

export default localizedApi(handler);
