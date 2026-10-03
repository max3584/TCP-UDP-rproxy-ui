import Document, { Html, Head, Main, NextScript, type DocumentContext, type DocumentInitialProps } from "next/document";
import { requestLocale } from "../i18n/server";
import type { Locale } from "../i18n/core";

// <html lang> は画面の言語（cookie か Accept-Language）に合わせる。切り替えたあとは LocaleProvider が直す
export default class MyDocument extends Document<{ locale: Locale }> {
  static async getInitialProps(ctx: DocumentContext): Promise<DocumentInitialProps & { locale: Locale }> {
    const props = await Document.getInitialProps(ctx);
    return { ...props, locale: requestLocale(ctx.req) };
  }

  render() {
    return (
      <Html lang={this.props.locale}>
        <Head />
        <body>
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}
