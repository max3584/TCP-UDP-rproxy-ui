// 画面の言語の状態と切り替え。選んだ言語は cookie（SSR で読む）と localStorage に残す
import { Fragment, createContext, useCallback, useContext, useEffect, useState } from 'react';
import { LOCALE_COOKIE, Locale, detectLocale, isLocale, localeFromCookie, setLocale } from './core';

interface LocaleState {
  locale: Locale;
  change: (l: Locale) => void;
}

const LocaleContext = createContext<LocaleState>({ locale: 'ja', change: () => undefined });

export function useLocale(): LocaleState {
  return useContext(LocaleContext);
}

// SSR から渡された言語で描き始め、ブラウザでは cookie / localStorage / navigator.languages の順で確かめる
export function LocaleProvider({ initial, children }: { initial: Locale; children: React.ReactNode }) {
  const [locale, setState] = useState<Locale>(initial);
  // 描画の前に、jsx-runtime が使う言語を合わせる
  setLocale(locale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const change = useCallback((l: Locale) => {
    setLocale(l);
    document.cookie = `${LOCALE_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
    try {
      window.localStorage.setItem(LOCALE_COOKIE, l);
    } catch {
      // localStorage を使えない（プライベートブラウズなど）ときは cookie だけ
    }
    setState(l);
  }, []);

  // 切り替えたら中身を作り直す（訳は描画のときに決まるので、メモ化された部分にも新しい言語を行き渡らせる）
  return (
    <LocaleContext.Provider value={{ locale, change }}>
      <Fragment key={locale}>{children}</Fragment>
    </LocaleContext.Provider>
  );
}

// SSR がない（クライアントでのページ遷移）ときの言語：cookie → localStorage → ブラウザの言語
export function clientLocale(): Locale {
  const fromCookie = localeFromCookie(document.cookie);
  if (fromCookie) return fromCookie;
  try {
    const saved = window.localStorage.getItem(LOCALE_COOKIE);
    if (isLocale(saved)) return saved;
  } catch {
    // 読めなければブラウザの言語
  }
  return detectLocale(navigator.languages);
}
