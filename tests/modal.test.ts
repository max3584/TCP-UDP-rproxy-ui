// 入力フォーム（Modal）とプロファイルの確認。ブラウザは使わず、サーバ側の描画結果（HTML）を見る。
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Modal from '@/components/Modal';
import { PROFILES } from '@/components/profiles';
import { DEFAULT_MAX_RANGE_PORTS, ForwardRule } from '@/components/lib';
import { checkTls, portCount } from '@/components/tls';

const render = (initialData?: ForwardRule) =>
  renderToStaticMarkup(createElement(Modal, { isOpen: true, onClose: () => undefined, onSubmit: () => undefined, initialData }));

const udpRule: ForwardRule = {
  protocol: 'udp', srcAddr: '0.0.0.0', srcPort: 8000, srcPortEnd: 8001, distAddr: '10.0.0.30', distPort: 8000,
  sourceIp: 'proxy', udpIdleSecs: 30, tls: { mode: 'passthrough' }, starttls: null, starttlsRequired: true,
};

describe('Modal', () => {
  it('splits the form into four accessible tabs with the basic tab selected', () => {
    const html = render();
    expect(html).toContain('role="tablist"');
    const tabs = Array.from(html.matchAll(/<button[^>]*role="tab"[^>]*>(.*?)<\/button>/g));
    expect(tabs.map((t) => t[1])).toEqual(['基本', 'TLS / DTLS', 'メール (STARTTLS)', '詳細']);
    expect(tabs[0][0]).toContain('aria-selected="true"');
    expect(tabs[1][0]).toContain('aria-selected="false"');
    // tcp + passthrough では STARTTLS のタブは使えない
    expect(tabs[2][0]).toContain('aria-disabled="true"');
    expect(html.match(/role="tabpanel"/g)).toHaveLength(4);
    expect(html).toContain('プロファイル');
  });

  it('titles the TLS tab DTLS for UDP and keeps the range read-only when editing', () => {
    const html = render(udpRule);
    expect(html).toMatch(/role="tab"[^>]*>DTLS<\/button>/);
    expect(html).not.toContain('プロファイル');
    expect(html).toMatch(/value="8001"[^>]*readOnly|readOnly[^>]*value="8001"/i);
  });
});

describe('profiles', () => {
  const cert = [{ cert_file: '/c.pem', key_file: '/k.pem' }];

  it.each(PROFILES.map((p) => [p.id, p] as const))('%s is a valid rule', (_id, p) => {
    const count = portCount(p.srcPort, p.srcPortEnd ?? null, p.distPort, DEFAULT_MAX_RANGE_PORTS);
    const tls = p.tlsMode === 'terminate' ? { mode: p.tlsMode, certificates: cert } : { mode: p.tlsMode };
    expect(() => checkTls(p.protocol, tls, p.starttls ?? null, count)).not.toThrow();
    expect(p.description.length).toBeGreaterThan(0);
  });

  it('follows the PROFILES.md warnings', () => {
    const byId = Object.fromEntries(PROFILES.map((p) => [p.id, p]));
    expect(byId['webrtc-media']).toMatchObject({ protocol: 'udp', tlsMode: 'passthrough', srcPort: 50000, srcPortEnd: 60000, udpIdleSecs: 60 });
    expect(byId['smtp']).toMatchObject({ srcPort: 25, tlsMode: 'passthrough', sourceIp: 'proxy_v2' });
    expect(byId['smtp'].description).toContain('必須にする');
    expect(byId['rtsp']).toMatchObject({ protocol: 'tcp', srcPort: 554, tlsMode: 'passthrough' });
    expect(byId['turns-dtls']).toMatchObject({ protocol: 'udp', tlsMode: 'terminate' });
    expect(byId['submission']).toMatchObject({ srcPort: 587, tlsMode: 'terminate', starttls: 'smtp' });
  });
});
