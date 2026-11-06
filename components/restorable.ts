// rproxy が UI の DB（forward_rules.options）の connect_timeout を戻せるか（features.db_connect_timeout、rproxy-api v0.4.21、#379）。
// それより前の rproxy は options に知らないキーのある行を丸ごと戻さない（再起動でルールが消える）ので、
// 書く前（[forward].ts の ensureConnectTimeoutRestorable）・フォームの編集の可否（/api/forward/capabilities）・
// /system の注意で使う。サーバだけで使う（UI #184）
import { getCapabilities, withNode } from './rproxy';
import type { Capabilities, RproxyNode } from './rproxy';

export interface RestoreCheck {
  // features.db_connect_timeout を返さないノード
  lacking: string[];
  // 問い合わせできないノード
  unreachable: string[];
}

// /api/forward/capabilities がグループのときに足す形（フォームの connect_timeout の可否）
export interface PlacementRestore {
  nodes: string[];
  // 置き場所のすべてのノードが features.db_connect_timeout を返す
  db_connect_timeout: boolean;
  lacking: string[];
  unreachable: string[];
}

// ノードを並べて聞く（止まったノードがあっても待つのは 1 回の時間切れ。ノードの数 × 10 秒にならない）。
// node が null のときは RPROXY_API_URL の 1 台（ノードを設定していない）
export async function connectTimeoutRestore(nodes: (RproxyNode | null)[], names?: string[]): Promise<RestoreCheck> {
  const answers = await Promise.all(nodes.map(async (node): Promise<Capabilities | null> => {
    try {
      return node ? await withNode(node, () => getCapabilities()) : await getCapabilities();
    } catch {
      return null;
    }
  }));
  const out: RestoreCheck = { lacking: [], unreachable: [] };
  answers.forEach((caps, i) => {
    const name = names?.[i] ?? nodes[i]?.name ?? 'default';
    if (caps === null) out.unreachable.push(name);
    else if (caps.features?.db_connect_timeout !== true) out.lacking.push(name);
  });
  return out;
}

// /system の注意：このノードが UI の DB から connect_timeout を戻せないのに、このノードに置いたルール（グループを含む）に connect_timeout がある
export function hasConnectTimeout(options: unknown): boolean {
  let o: unknown = options;
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o);
    } catch {
      return false;
    }
  }
  return typeof o === 'object' && o !== null && typeof (o as Record<string, unknown>).connect_timeout === 'string';
}
