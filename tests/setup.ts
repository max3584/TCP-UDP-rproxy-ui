// すべての試験で共通：名前解決（利用者の転送先の確認、components/usertargets.ts）を DNS に聞かずに決める。
// localhost は 127.0.0.1、*.invalid は解決できない、ほかの名前は文書用のアドレス 192.0.2.10
import { vi } from 'vitest';

vi.mock('node:dns/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:dns/promises')>();
  const lookup = async (host: string) => {
    const h = host.toLowerCase();
    if (h === 'localhost') return [{ address: '127.0.0.1', family: 4 }];
    if (h.endsWith('.invalid')) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return [{ address: '192.0.2.10', family: 4 }];
  };
  return { ...real, default: { ...real, lookup }, lookup };
});
