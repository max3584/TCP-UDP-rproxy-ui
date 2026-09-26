/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // .next/standalone に実行に必要なものだけを集める（Debian パッケージは node server.js で動かす。packaging/）
  output: 'standalone',
  // next/image は使っていない。最適化を切って、CPU ごとのネイティブなライブラリ（sharp）をパッケージに入れない
  images: { unoptimized: true },
  // next dev が CLAUDE.md に説明を書き足さないようにする（Next 16 の説明書は node_modules/next/dist/docs/。CLAUDE.md に記載）
  agentRules: false,
};

export default nextConfig;
