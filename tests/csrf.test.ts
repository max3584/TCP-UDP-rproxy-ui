// ほかのサイトからの状態を変える要求（CSRF）の確認（セキュリティレビュー L2）
import { describe, expect, it } from 'vitest';
import { isCrossSiteRequest } from '@/components/apiguard';

const req = (method: string, headers: Record<string, string>) => ({ method, headers }) as never;
const env = { NEXTAUTH_URL: 'https://rproxy.example.com' };

describe('isCrossSiteRequest', () => {
  it('GET は見ない', () => {
    expect(isCrossSiteRequest(req('GET', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }), env)).toBe(false);
  });

  it('同じオリジンの画面からの POST は通す（Host・X-Forwarded-Host・NEXTAUTH_URL）', () => {
    expect(isCrossSiteRequest(req('POST', { host: 'ui.internal:3000', origin: 'http://ui.internal:3000', 'sec-fetch-site': 'same-origin' }), env)).toBe(false);
    expect(isCrossSiteRequest(req('POST', { host: '127.0.0.1:3000', 'x-forwarded-host': 'rproxy.example.com', origin: 'https://rproxy.example.com' }), env)).toBe(false);
    expect(isCrossSiteRequest(req('POST', { host: '127.0.0.1:3000', origin: 'https://rproxy.example.com' }), env)).toBe(false);
    expect(isCrossSiteRequest(req('POST', { host: 'ui.internal', referer: 'http://ui.internal/rules/new' }), env)).toBe(false);
  });

  it('ブラウザでない要求（Origin も Referer もない）は通す', () => {
    expect(isCrossSiteRequest(req('POST', { host: 'ui.internal' }), env)).toBe(false);
  });

  it('ほかのオリジン・Sec-Fetch-Site が same-origin でない・Origin: null は断る', () => {
    expect(isCrossSiteRequest(req('POST', { host: 'ui.internal', origin: 'https://evil.example' }), env)).toBe(true);
    expect(isCrossSiteRequest(req('POST', { host: 'ui.internal', referer: 'https://evil.example/x' }), env)).toBe(true);
    expect(isCrossSiteRequest(req('POST', { host: 'ui.internal', 'sec-fetch-site': 'cross-site' }), env)).toBe(true);
    expect(isCrossSiteRequest(req('POST', { host: 'ui.internal', 'sec-fetch-site': 'same-site', origin: 'https://other.example.com' }), env)).toBe(true);
    expect(isCrossSiteRequest(req('DELETE', { host: 'ui.internal', origin: 'null' }), env)).toBe(true);
    expect(isCrossSiteRequest(req('POST', { host: 'ui.internal', origin: 'not a url' }), env)).toBe(true);
  });
});
