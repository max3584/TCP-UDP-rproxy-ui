import Document, { Html, Head, Main, NextScript, type DocumentContext, type DocumentInitialProps } from "next/document";
import { requestLocale } from "../i18n/server";
import type { Locale } from "../i18n/core";
import { NONCE_HEADER } from "../components/securityheaders";

// <html lang> は画面の言語（cookie か Accept-Language）に合わせる。切り替えたあとは LocaleProvider が直す。
// CSP の nonce（proxy.ts が要求ごとに作って x-nonce で渡す）を Next のスクリプトに付ける（components/securityheaders.ts）
export default class MyDocument extends Document<{ locale: Locale; nonce?: string }> {
  static async getInitialProps(ctx: DocumentContext): Promise<DocumentInitialProps & { locale: Locale; nonce?: string }> {
    const props = await Document.getInitialProps(ctx);
    const nonce = ctx.req?.headers[NONCE_HEADER];
    return { ...props, locale: requestLocale(ctx.req), ...(typeof nonce === "string" ? { nonce } : {}) };
  }

  render() {
    const { nonce } = this.props;
    return (
      <Html lang={this.props.locale}>
        <Head nonce={nonce} />
        <body>
          <Main />
          <NextScript nonce={nonce} />
        </body>
      </Html>
    );
  }
}
