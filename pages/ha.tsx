// act / stb（/ha。#109）：active_standby のグループの act（VIP の持ち主）と、ノードごとに DB の定義に揃っているか。
// 元の act に戻す（failback）前の確認と手順の案内。VIP を動かすのは keepalived で、UI は確かめて揃えるだけ。管理者だけ
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { HaStatus, HaSyncStatus, NodeReadiness, NodeRole } from '@/components/lib';
import { DRIFT_LABELS } from '@/components/drift';
import type { DriftField } from '@/components/lib';
import { ErrorBanner, HaWarning, RoleBadge, errorDetail } from '@/components/ui';
import { joinList, localeTag, t } from '@/i18n/core';

interface GroupView extends Partial<HaStatus> {
  name: string;
  nodes: string[];
  vips: string[];
  autoResend: boolean;
  roles: Record<string, NodeRole>;
  readiness: NodeReadiness[];
}

const STATE_TEXT: Record<string, string> = { missing: '未登録', drift: 'ずれ', unknown: '問い合わせできない' };

function formatAt(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(localeTag());
}

const ReadyCell: React.FC<{ r: NodeReadiness }> = ({ r }) => (
  r.ready
    ? <span className="badge bg-green-100 text-green-900 border border-green-300">揃っています</span>
    : (
      <details>
        <summary className="cursor-pointer">
          <span className="badge bg-amber-100 text-amber-900 border border-amber-300">{t('{n} 件が揃っていません', { n: r.issues.length })}</span>
        </summary>
        <ul className="mt-1 space-y-0.5 text-xs text-gray-800">
          {r.issues.map((i) => (
            <li key={`${i.target}|${i.key}`} className="break-all">
              <span className="font-mono">{i.key}</span>（<span className="font-mono">{i.target}</span>）: {STATE_TEXT[i.state] ?? i.state}
              {i.fields && i.fields.length > 0 && <span>（{joinList(i.fields.map((f) => DRIFT_LABELS[f as DriftField] ?? f))}）</span>}
              {i.error && <span className="text-red-800"> {i.error}</span>}
            </li>
          ))}
        </ul>
      </details>
    )
);

const HaPage: React.FC = () => {
  const [groups, setGroups] = useState<GroupView[] | null>(null);
  const [sync, setSync] = useState<HaSyncStatus | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/forward/ha');
      if (!res.ok) {
        setError(await errorDetail(res));
        return;
      }
      const data = await res.json() as { groups: GroupView[]; haSync: HaSyncStatus };
      setGroups(data.groups);
      setSync(data.haSync);
      setError('');
    } catch (err) {
      setError(`読み込めませんでした: ${err instanceof Error ? err.message : err}`);
    }
  }, []);

  useEffect(() => {
    // load は await の後でだけ state を変える（同期の setState ではない）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const syncNode = async (node: string) => {
    setBusy(node);
    setNotice('');
    try {
      const res = await fetch('/api/forward/ha-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node: node }),
      });
      if (!res.ok) throw new Error(await errorDetail(res));
      const out = await res.json() as { results: { result: string; key: string; error?: string }[] };
      const failed = out.results.filter((r) => r.result === 'error');
      const sent = out.results.filter((r) => r.result !== 'error' && r.result !== 'unchanged').length;
      setNotice(t('{node}: {sent} 件を送り直しました（失敗 {failed} 件）。', { node: node, sent: sent, failed: failed.length }));
      if (failed.length > 0) setError(failed.map((f) => `${f.key}: ${f.error ?? ''}`).join(' / '));
      await load();
    } catch (err) {
      setError(`揃えられませんでした: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <nav aria-label="パンくず" className="text-sm text-gray-700">
        <Link href="/" className="link">ダッシュボード</Link>
        <span aria-hidden="true" className="mx-2">/</span>
        <span>act / stb</span>
      </nav>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-gray-900 mr-auto">act / stb（昇格と failback）</h1>
        <button type="button" className="btn-secondary" onClick={() => void load()}>今すぐ更新</button>
      </div>
      {error && <ErrorBanner message={error} onClose={() => setError('')} />}
      {notice && <p role="status" className="rounded-sm border border-green-300 bg-green-50 px-4 py-2 text-sm text-green-900">{notice}</p>}
      {groups === null && !error && <p className="text-gray-700">読み込み中…</p>}
      {groups !== null && groups.length === 0 && (
        <div className="card p-4 text-sm text-gray-900">active_standby のグループはありません（RPROXY_UI_NODES の groups に mode: active_standby を書きます）。</div>
      )}

      {groups?.map((g) => (
        <section key={g.name} className="card" aria-labelledby={`ha-${g.name}`} data-testid="ha-group">
          <div className="p-4 space-y-1 text-sm text-gray-900">
            <h2 id={`ha-${g.name}`} className="card-title"><span className="font-mono">{g.name}</span></h2>
            <p>
              VIP: {g.vips.length > 0 ? <span className="font-mono">{g.vips.join(', ')}</span> : <span className="text-gray-700">（vip を書いていないため、act はルールの詳細でルールごとに出します）</span>}
            </p>
            {g.vips.length > 0 && (
              <p className="flex flex-wrap items-center gap-2">
                act: <span className="font-mono">{(g.active ?? []).join(', ') || '-'}</span>
                <HaWarning ha={g.addrs ? { addrs: g.addrs, active: g.active ?? [], warning: g.warning ?? null } : undefined} />
              </p>
            )}
            <p>自動の送り直し: {g.autoResend ? 'する' : 'しない（auto_resend: false。ずれの表示だけ）'}</p>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <caption className="sr-only">ノードごとの役割と、DB の定義に揃っているか</caption>
              <thead>
                <tr>
                  <th scope="col">ノード</th>
                  <th scope="col">役割</th>
                  <th scope="col">DB の定義に揃っているか</th>
                  <th scope="col"><span className="sr-only">操作</span></th>
                </tr>
              </thead>
              <tbody>
                {g.readiness.map((r) => (
                  <tr key={r.node}>
                    <td className="font-mono text-gray-900">{r.node}</td>
                    <td>{g.roles[r.node] ? <RoleBadge role={g.roles[r.node]} /> : '-'}</td>
                    <td><ReadyCell r={r} /><div className="text-xs text-gray-600">{t('ルール {n} 件を確かめました', { n: r.checked })}</div></td>
                    <td className="whitespace-nowrap">
                      <button type="button" className="btn-secondary text-xs px-2 py-1 max-lg:min-h-11" disabled={busy !== null || r.ready}
                        onClick={() => void syncNode(r.node)}>{busy === r.node ? '揃えています…' : 'このノードを揃える'}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {sync && (
        <section className="card p-4 text-sm text-gray-900" aria-labelledby="ha-sync">
          <h2 id="ha-sync" className="card-title mb-2">自動の送り直し</h2>
          <p>{sync.intervalSecs > 0 ? t('{secs} 秒ごとに調べます（RPROXY_UI_HA_SYNC_SECS）。', { secs: sync.intervalSecs }) : '止めています（RPROXY_UI_HA_SYNC_SECS=0）。'} 最後に調べた時刻: {formatAt(sync.lastRun)}</p>
          {sync.failures.length > 0 && (
            <ul className="mt-2 space-y-1 text-red-800" data-testid="ha-failures">
              {sync.failures.map((f) => (
                <li key={`${f.node}|${f.target}|${f.key}`} className="break-all">
                  <span className="font-mono">{f.node}</span> / <span className="font-mono">{f.key}</span>（{f.target}）: {t('{n} 回続けて失敗', { n: f.count })} — {f.error}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-gray-600">状態はこの UI のプロセスのものです（UI を複数動かしているときは、見回りをしたプロセスにだけ残ります）。</p>
        </section>
      )}

      <section className="card p-4 text-sm text-gray-900 space-y-2" aria-labelledby="ha-guide">
        <h2 id="ha-guide" className="card-title">元の act に戻す（failback）手順</h2>
        <ol className="list-decimal pl-5 space-y-1">
          <li>戻す先のノード（元の act）が「揃っています」になっていることを確かめます。揃っていなければ「このノードを揃える」で DB の定義を送り直します。</li>
          <li>元の act の keepalived を動かします。preempt（既定）なら、優先度の高い元の act が VIP を取り戻します。nopreempt なら、今の act の keepalived を再起動するか優先度を下げて VIP を手放させます。</li>
          <li>この画面の act が元のノードに戻ったことを確かめます。昇格したノードには、notify_master のスクリプトから UI がすぐ送り直します。</li>
          <li>keepalived の track_script（rproxy-ui-ready.sh）は、揃っていないノードの優先度を下げます。揃うまでは、そのノードへ戻りません（今の act が落ちたときは、揃っていなくても昇格します）。</li>
        </ol>
        <p className="text-xs text-gray-600">スクリプトと keepalived.conf の例：contrib/keepalived/（.deb では /usr/share/doc/rproxy-ui/examples/keepalived/）。</p>
      </section>
    </div>
  );
};

export default HaPage;
