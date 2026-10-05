// グループのルールの変更を、グループの全ノードに送る（#98）。サーバ側だけで使う。
// 全員が成功したときだけ成功。1 台でも失敗したら、成功したノードの変更を取り消して FanoutError を投げる
// （呼び出し側の withTransaction が DB を ROLLBACK する）。COMMIT が失敗したときは、返した undo で全員を戻す。
import { RproxyNode, withNode } from './rproxy';

export type Undo = () => Promise<unknown>;

// ノードごとの結果（応答の nodes）
export interface NodeResult {
  node: string;
  ok: boolean;
  error?: string;
  code?: string;
  // 失敗したノードがあったため、このノードの変更を取り消したか（false なら取り消しにも失敗した）
  undone?: boolean;
}

interface FanoutLogger {
  error: (msg: string) => void;
}

export class FanoutError extends Error {
  constructor(
    // 最初に失敗したノードの例外（応答のステータスとコードはこれで決める）
    public readonly reason: unknown,
    public readonly node: string,
    public readonly results: NodeResult[],
  ) {
    super(`ノード ${node}: ${reason instanceof Error ? reason.message : String(reason)}`);
    this.name = 'FanoutError';
  }
}

function codeOf(err: unknown): string | undefined {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// step をノードごとに（並べて）実行する。step はそのノードの変更を戻す undo を返す。
// ノードが 1 つなら、失敗はそのまま投げる（1 台のときの応答を今と変えない）
export async function applyToNodes(
  nodes: RproxyNode[],
  step: (node: RproxyNode) => Promise<Undo>,
  logger: FanoutLogger,
): Promise<{ undo: Undo; results: NodeResult[] }> {
  if (nodes.length === 1) {
    const node = nodes[0];
    const undo = await withNode(node, () => step(node));
    return { undo: () => withNode(node, undo), results: [{ node: node.name, ok: true }] };
  }

  const settled = await Promise.allSettled(nodes.map((node) => withNode(node, () => step(node))));
  const failedAt = settled.findIndex((s) => s.status === 'rejected');
  if (failedAt < 0) {
    const undos = settled.map((s) => (s as PromiseFulfilledResult<Undo>).value);
    const results = nodes.map((n) => ({ node: n.name, ok: true }));
    const undo: Undo = async () => {
      const done = await Promise.allSettled(nodes.map((node, i) => withNode(node, undos[i])));
      const bad = done.map((d, i) => (d.status === 'rejected' ? `${nodes[i].name}: ${messageOf(d.reason)}` : null)).filter((x) => x !== null);
      if (bad.length > 0) throw new Error(bad.join('; '));
    };
    return { undo: undo, results: results };
  }

  // 成功したノードを戻す
  const results: NodeResult[] = await Promise.all(settled.map(async (s, i): Promise<NodeResult> => {
    const node = nodes[i];
    if (s.status === 'rejected') {
      const code = codeOf(s.reason);
      return { node: node.name, ok: false, error: messageOf(s.reason), ...(code ? { code: code } : {}) };
    }
    try {
      await withNode(node, s.value);
      return { node: node.name, ok: true, undone: true };
    } catch (err) {
      logger.error(`ノード ${node.name} の変更を取り消せませんでした（DB とこのノードが食い違っています）: ${err}`);
      return { node: node.name, ok: true, undone: false };
    }
  }));
  const reason = (settled[failedAt] as PromiseRejectedResult).reason;
  throw new FanoutError(reason, nodes[failedAt].name, results);
}
