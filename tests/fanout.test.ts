import { describe, expect, it, vi } from 'vitest';
import { FanoutError, applyToNodes } from '@/components/fanout';
import { RproxyError, RproxyNode, currentNode } from '@/components/rproxy';

const a: RproxyNode = { name: 'a', url: 'http://a:1' };
const b: RproxyNode = { name: 'b', url: 'http://b:1' };
const c: RproxyNode = { name: 'c', url: 'http://c:1' };
const logger = { error: vi.fn() };

describe('applyToNodes', () => {
  it('runs the step on every node, inside that node\'s context', async () => {
    const seen: string[] = [];
    const undone: string[] = [];
    const { undo, results } = await applyToNodes([a, b, c], async () => {
      seen.push(currentNode()!.name);
      return async () => { undone.push(currentNode()!.name); };
    }, logger);
    expect(seen.sort()).toEqual(['a', 'b', 'c']);
    expect(results).toEqual([{ node: 'a', ok: true }, { node: 'b', ok: true }, { node: 'c', ok: true }]);
    // COMMIT に失敗したときの undo は全員を戻す（それぞれのノードで）
    await undo();
    expect(undone.sort()).toEqual(['a', 'b', 'c']);
  });

  it('undoes the nodes that succeeded when one fails, and reports each node', async () => {
    const undone: string[] = [];
    const err = await applyToNodes([a, b, c], async () => {
      if (currentNode()!.name === 'b') throw new RproxyError('address already in use', 'bind_failed', 409);
      return async () => { undone.push(currentNode()!.name); };
    }, logger).catch((e) => e);
    expect(err).toBeInstanceOf(FanoutError);
    expect(err.node).toBe('b');
    expect(err.reason).toBeInstanceOf(RproxyError);
    expect(err.message).toBe('ノード b: address already in use');
    expect(undone.sort()).toEqual(['a', 'c']);
    expect(err.results).toEqual([
      { node: 'a', ok: true, undone: true },
      { node: 'b', ok: false, error: 'address already in use', code: 'bind_failed' },
      { node: 'c', ok: true, undone: true },
    ]);
  });

  it('reports an undo that failed too (DB and that node disagree)', async () => {
    const err = await applyToNodes([a, b], async () => {
      const name = currentNode()!.name;
      if (name === 'b') throw new Error('boom');
      return async () => { throw new Error('undo failed'); };
    }, logger).catch((e) => e);
    expect(err.results[0]).toEqual({ node: 'a', ok: true, undone: false });
    expect(logger.error).toHaveBeenCalled();
  });

  it('a single node throws its own error unchanged (the single-node responses stay the same)', async () => {
    const original = new RproxyError('nope', 'conflict', 409);
    await expect(applyToNodes([a], async () => { throw original; }, logger)).rejects.toBe(original);
    const undo = vi.fn(async () => currentNode()?.name);
    const out = await applyToNodes([a], async () => undo, logger);
    expect(out.results).toEqual([{ node: 'a', ok: true }]);
    await expect(out.undo()).resolves.toBe('a');
  });

  it('the combined undo reports the nodes that could not be undone', async () => {
    const { undo } = await applyToNodes([a, b], async () => async () => {
      if (currentNode()!.name === 'a') throw new Error('gone');
    }, logger);
    await expect(undo()).rejects.toThrow('a: gone');
  });
});
