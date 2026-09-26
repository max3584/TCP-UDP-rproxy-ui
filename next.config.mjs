/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // next dev が CLAUDE.md に説明を書き足さないようにする（Next 16 の説明書は node_modules/next/dist/docs/。CLAUDE.md に記載）
  agentRules: false,
};

export default nextConfig;
