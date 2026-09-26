// 送信元 IP の扱い（source_ip）の欄に出す説明（tests/sourceip.test.ts）
// transparent は rproxy の権限（CAP_NET_ADMIN）とホストのルーティングに左右されるので、選べない理由と前提を画面に出す

import type { SourceIp } from './lib';

export type TransparentHintKind = 'unavailable' | 'ipv6' | 'selected';

export interface TransparentHint {
  kind: TransparentHintKind;
  message: string;
}

export const TRANSPARENT_HINTS: Record<TransparentHintKind, string> = {
  unavailable:
    'transparent（透過プロキシ）は選べません。rproxy に CAP_NET_ADMIN の権限がありません。'
    + 'apt と install.sh で入れた rproxy では既定で有効です（手で起動している場合は rproxy-api の docs/PERMISSIONS.md を参照してください）。',
  ipv6: 'transparent（透過プロキシ）は IPv4 の待ち受けアドレスでだけ使えます。',
  selected:
    'transparent では、転送先からの戻りのパケットが rproxy のホストを通る必要があります。'
    + 'rproxy のホストでは install.sh --transparent-clients <クライアントのアドレス範囲> --transparent-iface <転送先側のインターフェース> でポリシールーティングを設定し、'
    + '転送先ではデフォルトゲートウェイを rproxy のホストに向けてください。',
};

/**
 * source_ip の欄の下に出す説明。
 * transparentAvailable は rproxy の GET /capabilities の transparent（取得できなかったときは null で、何も出さない）。
 */
export function transparentHint(opts: {
  sourceIp: SourceIp;
  transparentAvailable: boolean | null;
  listenIsIPv6: boolean;
}): TransparentHint | null {
  const { sourceIp, transparentAvailable, listenIsIPv6 } = opts;
  if (sourceIp === 'transparent') return { kind: 'selected', message: TRANSPARENT_HINTS.selected };
  if (transparentAvailable === false) return { kind: 'unavailable', message: TRANSPARENT_HINTS.unavailable };
  if (transparentAvailable === true && listenIsIPv6) return { kind: 'ipv6', message: TRANSPARENT_HINTS.ipv6 };
  return null;
}
