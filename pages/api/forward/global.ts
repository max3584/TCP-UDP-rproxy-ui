import { NextApiRequest, NextApiResponse } from 'next';
import { Logger } from '@/components/lib';
import { apiTarget, getCapabilities, getGlobalSettings, patchGlobalSettings, withNode } from '@/components/rproxy';
import type { RproxyNode } from '@/components/rproxy';
import { NodesConfigError, loadNodes, targetNodes, toRproxyNode } from '@/components/nodes';
import type { NodesConfig } from '@/components/nodes';
import { requireRole, rproxyFailure } from '@/components/apiguard';
import { accessOf, roleConfig } from '@/components/roles';
import { FanoutError, applyToNodes } from '@/components/fanout';
import type { NodeResult } from '@/components/fanout';
import { GlobalPatchError, globalPatchBody, globalSettingsView, normalizeGlobalValues, undoValues } from '@/components/globalsettings';
import { GlobalRouteError, globalCode, globalFailure } from '@/components/globalapi';
import type { GlobalChange, GlobalNodeResult, GlobalNodeView, GlobalSettings } from '@/components/globalsettings';
import { READONLY_NODE_MESSAGE } from '@/components/messages';
import { localizedApi } from '@/i18n/server';

// rproxy の global の設定（rproxy-api v0.4.19 の GET / PATCH /config/global、#342。UI #169）。管理者だけ。
// GET：ノードごとの項目（今の値・出どころ・変え方・API の値）。features.global_api のないノードは supported: false。
//   ?target= でノード／グループのノードだけ。問い合わせできないノードがあっても 200
// POST {target, values: {項目: 値 | null}, dryRun}：target（ノードかグループ）の全ノードに PATCH /config/global を送る。
//   dryRun はノードごとの結果（changes・applied・断り）を 200 で返す（何も変えない）。
//   適用は applyToNodes：1 台でも断れば、適用したノードを前の API の値に戻し（undo）、断ったノードのステータスで返す。
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
  if (!cfg.configured) return cfg.nodes.slice(0, 1).map(make);
  if (target === undefined) return cfg.nodes.map(make);
  const nodes = targetNodes(cfg, target);
  if (nodes === null) throw new GlobalRouteError(400, `ノード／グループ ${target} は設定にありません。`, 'unknown_target');
  return nodes.map(make);
}

const run = <T,>(p: PlanNode, fn: () => Promise<T>): Promise<T> => (p.node ? withNode(p.node, fn) : fn());

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
    const settings = globalSettingsView(await run(p, () => getGlobalSettings()));
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

  const done = new Map<string, { changes: GlobalChange[]; applied: string[]; settings: GlobalSettings | null }>();
  const step = async (name: string) => {
    const r = changesOf(await patchGlobalSettings(patch, false));
    done.set(name, r);
    const back = undoValues(r.changes);
    return async () => {
      if (back) await patchGlobalSettings(globalPatchBody(back), false);
    };
  };
  const who = session.user.name || session.user.email || session.user.id;
  try {
    let results: NodeResult[];
    if (nodes.length === 1 && nodes[0].node === null) {
      await step(nodes[0].name);
      results = [{ node: nodes[0].name, ok: true }];
    } else {
      const byName = new Map(nodes.map((p) => [p.name, p]));
      ({ results } = await applyToNodes(nodes.map((p) => p.node!), (n) => step(byName.get(n.name)!.name), logger));
    }
    logger.info(`global の設定を変えました（${who}、${nodes.map((n) => n.name).join(', ')}）: ${Object.keys(values).join(', ')}`);
    const out: GlobalNodeResult[] = results.map((r) => {
      const d = done.get(r.node);
      return {
        node: r.node, ok: true, changes: d?.changes ?? [], applied: d?.applied ?? [],
        persisted: d?.settings?.persisted ?? null, ...(d?.settings ? { storage: d.settings.storage } : {}),
      };
    });
    return res.status(200).json({ nodes: out });
  } catch (err) {
    if (err instanceof FanoutError) {
      const f = globalFailure(err.reason);
      logger.warn(`global の設定を変えられませんでした（${who}、ノード ${err.node}）: ${f.code} ${f.error}`);
      const nodesOut = err.results.map((r) => (r.ok ? r : { ...r, ...(r.code ? { code: globalCode(r.code) } : {}) }));
      return res.status(f.status).json({ error: `ノード ${err.node}: ${f.error}`, code: f.code, nodes: nodesOut });
    }
    const f = globalFailure(err);
    logger.warn(`global の設定を変えられませんでした（${who}）: ${f.code} ${f.error}`);
    return res.status(f.status).json({ error: f.error, code: f.code });
  }
}

export default localizedApi(handler);
