import { SessionProvider } from 'next-auth/react';
import type { AppContext, AppProps } from 'next/app';
import App from 'next/app';
import Layout from '../components/Layout';
import RequireAuth, { isPublicPath } from '../components/RequireAuth';
import { Locale, localeFromCookie, detectLocale } from '../i18n/core';
import { LocaleProvider, clientLocale } from '../i18n/context';
import '../styles/globals.css'; // Tailwind CSSのインポート

function MyApp({ Component, pageProps: { session, ...pageProps }, router, locale }: AppProps & { locale: Locale }) {
  const page = <Component {...pageProps} />;
  return (
    <LocaleProvider initial={locale}>
      <SessionProvider session={session}>
        <Layout>
          {isPublicPath(router.pathname) ? page : <RequireAuth>{page}</RequireAuth>}
        </Layout>
      </SessionProvider>
    </LocaleProvider>
  );
}

// 言語：選んだもの（cookie）があればそれ、なければ Accept-Language（SSR）か navigator.languages（ブラウザ）
MyApp.getInitialProps = async (ctx: AppContext) => {
  const props = await App.getInitialProps(ctx);
  const req = ctx.ctx.req;
  let locale: Locale;
  if (req) {
    const accept = req.headers['accept-language'];
    locale = localeFromCookie(req.headers.cookie) ?? detectLocale(typeof accept === 'string' ? accept : undefined);
  } else {
    locale = clientLocale();
  }
  return { ...props, locale };
};

export default MyApp;
