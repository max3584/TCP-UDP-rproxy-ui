import { SessionProvider } from 'next-auth/react';
import type { AppProps } from 'next/app';
import Layout from '../components/Layout';
import RequireAuth, { isPublicPath } from '../components/RequireAuth';
import '../styles/globals.css'; // Tailwind CSSのインポート

function MyApp({ Component, pageProps: { session, ...pageProps }, router }: AppProps) {
  const page = <Component {...pageProps} />;
  return (
    <SessionProvider session={session}>
      <Layout>
        {isPublicPath(router.pathname) ? page : <RequireAuth>{page}</RequireAuth>}
      </Layout>
    </SessionProvider>
  );
}

export default MyApp;
