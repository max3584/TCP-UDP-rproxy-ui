// 追加フォームの「プロファイル」。../rproxy-api/docs/PROFILES.md の推奨設定をフォームに入れるだけのひな形。
// アドレスと証明書のパスは利用者が入力する。PROFILES.md を変えたらここも合わせること。

import type { Protocol, SourceIp, StartTls, TlsMode } from './lib';

export interface Profile {
  id: string;
  label: string;
  // select の下に出す説明と注意
  description: string;
  protocol: Protocol;
  srcPort: number;
  srcPortEnd?: number;
  distPort: number;
  sourceIp?: SourceIp;
  udpIdleSecs?: number;
  tlsMode: TlsMode;
  starttls?: StartTls;
  starttlsRequired?: boolean;
  // L7（HTTP）のひな形。proxy: サービスへ転送するルート / redirect: HTTP→HTTPS のリダイレクトだけ
  l7?: 'proxy' | 'redirect';
}

export const PROFILES: Profile[] = [
  {
    id: 'https-l7', label: 'HTTPS リバースプロキシ（L7）', protocol: 'tcp', srcPort: 443, distPort: 443, tlsMode: 'terminate', l7: 'proxy',
    description: 'rproxy で TLS を終端し、Host・パスなどでリクエストごとに転送先を選びます（Traefik のルーターと同じ）。TLS タブで証明書を、「L7 (HTTP)」タブでルートとサービスを設定してください。証明書は certbot / cert-manager で取ったファイルを指定します（更新は rproxy が自動で読み直します）。',
  },
  {
    id: 'http-redirect', label: 'HTTP→HTTPS リダイレクト（80 番、L7）', protocol: 'tcp', srcPort: 80, distPort: 80, tlsMode: 'passthrough', l7: 'redirect',
    description: '平文の HTTP を受けて、すべて https:// へリダイレクト（301 / 308）します。certbot の http-01 を使うなら、「L7 (HTTP)」タブで PathPrefix(`/.well-known/acme-challenge/`) のルートを certbot（webroot のサーバか standalone のポート）へ転送するよう足してください。',
  },
  {
    id: 'https-sni', label: 'HTTPS（443 を SNI で振り分け）', protocol: 'tcp', srcPort: 443, distPort: 443, tlsMode: 'sni',
    description: '証明書は転送先がそれぞれ持ち、rproxy は SNI（サーバ名）だけを見て転送先を選びます。サーバ名ごとの転送先を追加してください。一致しない名前は下の転送先へ送ります。',
  },
  {
    id: 'smtp', label: 'SMTP（25、MTA 間の受信）', protocol: 'tcp', srcPort: 25, distPort: 25, sourceIp: 'proxy_v2', tlsMode: 'passthrough',
    description: 'そのまま流し、PROXY v2 で送信元 IP を渡します（Postfix の postscreen_upstream_proxy_protocol = haproxy）。rproxy で TLS を受ける場合は、TLS を「終端」、STARTTLS を smtp にして「STARTTLS を必須にする」を外してください（TLS を使わない MTA もあるため）。',
  },
  {
    id: 'submission', label: 'Submission（587、メール送信）', protocol: 'tcp', srcPort: 587, distPort: 587, sourceIp: 'proxy_v2', tlsMode: 'terminate', starttls: 'smtp', starttlsRequired: true,
    description: 'rproxy が STARTTLS を受けて TLS を終端し、転送先には平文で送ります（PROXY v2 で送信元 IP と TLS の情報を渡す）。転送先で平文の AUTH を許すか、転送先の TLS で再暗号化してください。',
  },
  {
    id: 'smtps', label: 'SMTPS（465）', protocol: 'tcp', srcPort: 465, distPort: 465, tlsMode: 'terminate',
    description: 'rproxy で TLS を終端します。転送先には平文で届くので、転送先のポートは平文で待ち受けているものに合わせてください。',
  },
  {
    id: 'imap', label: 'IMAP（143、STARTTLS）', protocol: 'tcp', srcPort: 143, distPort: 143, tlsMode: 'terminate', starttls: 'imap', starttlsRequired: true,
    description: 'rproxy が STARTTLS を受けて TLS を終端します。IMAP では STARTTLS が必須です（TLS の前のログインは拒否します）。',
  },
  {
    id: 'imaps', label: 'IMAPS（993）', protocol: 'tcp', srcPort: 993, distPort: 993, tlsMode: 'terminate',
    description: 'rproxy で TLS を終端します。証明書を転送先（Dovecot）に持たせる場合は、TLS を「passthrough」、送信元 IP を proxy_v2 にしてください（Dovecot の haproxy = yes）。',
  },
  {
    id: 'pop3', label: 'POP3（110、STARTTLS）', protocol: 'tcp', srcPort: 110, distPort: 110, tlsMode: 'terminate', starttls: 'pop3', starttlsRequired: true,
    description: 'rproxy が STARTTLS（STLS）を受けて TLS を終端します。POP3 では STARTTLS が必須です。',
  },
  {
    id: 'pop3s', label: 'POP3S（995）', protocol: 'tcp', srcPort: 995, distPort: 995, tlsMode: 'terminate',
    description: 'rproxy で TLS を終端し、転送先には平文で送ります。',
  },
  {
    id: 'rtsp', label: 'RTSP（554）', protocol: 'tcp', srcPort: 554, distPort: 554, tlsMode: 'passthrough',
    description: 'RTSP の制御をそのまま流します。映像は TCP interleaved（554 番の接続の中）を推奨します。MediaMTX なら送信元 IP を proxy_v2 にして rtspTrustedProxies と組み合わせられます。',
  },
  {
    id: 'rtsps', label: 'RTSPS（322）', protocol: 'tcp', srcPort: 322, distPort: 322, tlsMode: 'terminate',
    description: 'rproxy で TLS を終端します（証明書を転送先が持つなら passthrough でもよい）。',
  },
  {
    id: 'rtp-range', label: 'RTP / RTCP（UDP 8000-8001）', protocol: 'udp', srcPort: 8000, srcPortEnd: 8001, distPort: 8000, tlsMode: 'passthrough',
    description: '注意：UDP の RTP はクライアントからサーバへ送る方向でしか使えません（再生の戻りの経路は L4 の転送では作れない）。できるだけ RTSP の TCP interleaved を使ってください。MediaMTX の既定ポート 8000 / 8001 の例です。',
  },
  {
    id: 'webrtc-media', label: 'WebRTC メディア（UDP 50000-60000）', protocol: 'udp', srcPort: 50000, srcPortEnd: 60000, distPort: 50000, udpIdleSecs: 60, tlsMode: 'passthrough',
    description: 'メディアは DTLS-SRTP で暗号化されているので、必ず passthrough で流します（rproxy で DTLS を終端すると接続できません）。メディアサーバには rproxy の公開 IP を自分のアドレスとして告知させてください（LiveKit rtc.node_ip、mediasoup announcedAddress、Janus nat_1_1_mapping）。範囲はメディアサーバの設定に合わせてください。',
  },
  {
    id: 'turn-udp', label: 'TURN（3478/udp）', protocol: 'udp', srcPort: 3478, distPort: 3478, tlsMode: 'passthrough',
    description: 'coturn にそのまま流します。リレー用のポート範囲（min-port〜max-port）も範囲ルールにし、coturn の external-ip に rproxy の公開 IP を設定してください。',
  },
  {
    id: 'turn-tcp', label: 'TURN（3478/tcp）', protocol: 'tcp', srcPort: 3478, distPort: 3478, tlsMode: 'passthrough',
    description: 'coturn にそのまま流します。coturn の external-ip に rproxy の公開 IP を設定してください。',
  },
  {
    id: 'turns-tls', label: 'TURN over TLS（5349/tcp）', protocol: 'tcp', srcPort: 5349, distPort: 3478, tlsMode: 'terminate',
    description: 'rproxy で TLS を終端し、coturn の平文の TURN（3478）へ送ります。証明書を coturn が持つなら passthrough でもよい。',
  },
  {
    id: 'turns-dtls', label: 'TURN over DTLS（5349/udp）', protocol: 'udp', srcPort: 5349, distPort: 3478, tlsMode: 'terminate',
    description: 'rproxy で DTLS を終端し、coturn の平文の TURN（3478/udp）へ送ります。DTLS の秘密鍵は PKCS#8（BEGIN PRIVATE KEY）に限ります。WebRTC のメディアには使えません。',
  },
  {
    id: 'ftp', label: 'FTP（21）', protocol: 'tcp', srcPort: 21, distPort: 21, tlsMode: 'passthrough',
    description: '制御の接続をそのまま流します。パッシブモードのデータ用に「FTP パッシブ」の範囲ルールも追加し、vsftpd の pasv_address に rproxy の公開 IP を設定してください。',
  },
  {
    id: 'ftp-passive', label: 'FTP パッシブ（TCP の範囲）', protocol: 'tcp', srcPort: 30000, srcPortEnd: 30100, distPort: 30000, tlsMode: 'passthrough',
    description: 'パッシブモードのデータ用のポート範囲です。vsftpd の pasv_min_port〜pasv_max_port に合わせてください（例は 30000-30100）。',
  },
];
