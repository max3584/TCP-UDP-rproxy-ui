// Kubernetes の rproxy（見るだけのノード）が 401 を返したら、発見の Secret を読み直すまで聞かない
// （入れ替わりの間の古い Pod は UI のトークンを知らない。rproxy は認証の失敗が続いた送信元を締め出す）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RproxyError, clearStaleNodes, isStaleNode, listRules, withNode } from '@/components/rproxy';

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  clearStaleNodes();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const pod = { name: 'k8s:team-a/web/rproxy-1', url: 'http://10.0.0.5:9443', token: 't', readonly: true };

describe('a Kubernetes rproxy that refuses the UI token', () => {
  it('is not asked again until the discovery is read again', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'unauthorized', code: 'unauthorized' }, 401));
    await expect(withNode(pod, () => listRules())).rejects.toMatchObject({ status: 401 });
    expect(isStaleNode(pod.name)).toBe(true);
    const err = await withNode(pod, () => listRules()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RproxyError);
    expect((err as RproxyError).code).toBe('unreachable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // a new discovery Secret (loadDiscovery) clears it
    clearStaleNodes();
    fetchMock.mockResolvedValue(json([]));
    await expect(withNode(pod, () => listRules())).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('other nodes are asked again as before', async () => {
    const vm = { name: 'node1', url: 'http://192.0.2.1:8081', token: 't' };
    fetchMock.mockImplementation(async () => json({ error: 'unauthorized', code: 'unauthorized' }, 401));
    await expect(withNode(vm, () => listRules())).rejects.toMatchObject({ status: 401 });
    await expect(withNode(vm, () => listRules())).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(isStaleNode('node1')).toBe(false);
  });
});
