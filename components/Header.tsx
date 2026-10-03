import { signOut, signIn, useSession } from 'next-auth/react';
import { LOCALES, Locale } from '@/i18n/core';
import { useLocale } from '@/i18n/context';

const LOCALE_NAMES: Record<Locale, string> = { ja: '日本語', en: 'English' };

// 表示する言語の切り替え（日本語 / English）。言語の名前は、どちらの言語でもその言語で書く
const LanguageSwitch: React.FC = () => {
  const { locale, change } = useLocale();
  return (
    <div role="group" aria-label="Language" className="inline-flex rounded overflow-hidden border border-gray-500 mr-4">
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={locale === l}
          onClick={() => change(l)}
          className={locale === l
            ? 'bg-white text-gray-900 px-3 py-1 text-sm font-semibold'
            : 'bg-gray-700 text-white hover:bg-gray-600 px-3 py-1 text-sm'}
        >
          {LOCALE_NAMES[l]}
        </button>
      ))}
    </div>
  );
};

const Header: React.FC = () => {
  const { data: session } = useSession();

  return (
    <header className="bg-gray-800 text-white p-4 flex justify-between items-center">
      <div className="text-xl font-bold">TCP/UDP Forward Web UI</div>
      <div className="flex items-center">
        <LanguageSwitch />
        {session ? (
          <>
            <span className="mr-4">Hello, {session.user?.name || session.user?.email}</span>
            <button
              onClick={() => signOut()}
              className="bg-red-600 hover:bg-red-500 text-white py-2 px-4 rounded"
            >
              Sign Out
            </button>
          </>
        ) : (
          <span className="bg-blue-600 hover:bg-blue-500 text-white py-2 px-4 rounded cursor-pointer">
            <button onClick={() => signIn('keycloak')}>
              Sign In
            </button>
          </span>
        )}
      </div>
    </header>
  );
};

export default Header;
