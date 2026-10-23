// すべての応答に付けるセキュリティのヘッダ（components/securityheaders.ts、proxy.ts）
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, securityHeaders } from '@/components/securityheaders';

const PROD = { NODE_ENV: 'production', KEYCLOAK_ISSUER: 'https://sso.example.com:8443/realms/rproxy', NEXTAUTH_URL: 'http://ui.example' };

describe('security headers', () => {
  it('sends a strict CSP with the Keycloak origin in form-action', () => {
    expect(contentSecurityPolicy(PROD)).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; "
      + "connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self' https://sso.example.com:8443; frame-ancestors 'none'",
    );
  });

  it('adds the per-request nonce and strict-dynamic to script-src', () => {
    expect(contentSecurityPolicy(PROD, 'abc+/=')).toContain("script-src 'self' 'nonce-abc+/=' 'strict-dynamic'; style-src 'self' 'unsafe-inline';");
    expect(Object.fromEntries(securityHeaders(PROD, 'n1'))['Content-Security-Policy']).toContain("'nonce-n1'");
  });

  it('leaves the Keycloak origin out when the issuer is missing or bad', () => {
    expect(contentSecurityPolicy({ NODE_ENV: 'production' })).toContain("form-action 'self';");
    expect(contentSecurityPolicy({ NODE_ENV: 'production', KEYCLOAK_ISSUER: 'not a url' })).toContain("form-action 'self';");
  });

  it('relaxes the CSP for next dev only', () => {
    const dev = contentSecurityPolicy({ ...PROD, NODE_ENV: 'development' });
    expect(dev).toContain("script-src 'self' 'unsafe-eval';");
    expect(dev).toContain("connect-src 'self' ws: wss:;");
    expect(contentSecurityPolicy(PROD)).not.toContain('unsafe-eval');
  });

  it('sends the other headers, and HSTS only behind https', () => {
    const h = Object.fromEntries(securityHeaders(PROD));
    expect(h).toMatchObject({
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    expect(h['Strict-Transport-Security']).toBeUndefined();
    const https = Object.fromEntries(securityHeaders({ ...PROD, NEXTAUTH_URL: 'https://ui.example' }));
    expect(https['Strict-Transport-Security']).toBe('max-age=31536000; includeSubDomains');
  });
});
