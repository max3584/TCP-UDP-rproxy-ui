import { signOut, signIn, useSession } from 'next-auth/react';
import { LOCALES, Locale } from '@/i18n/core';
import { useLocale } from '@/i18n/context';

const LOCALE_NAMES: Record<Locale, string> = { ja: '日本語', en: 'English' };

// 表示する言語の切り替え（日本語 / English）。言語の名前は、どちらの言語でもその言語で書く
const LanguageSwitch: React.FC = () => {
  const { locale, change } = useLocale();
  return (
    <div role="group" aria-label="Language" className="inline-flex rounded-sm overflow-hidden border border-gray-500">
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={locale === l}
          onClick={() => change(l)}
          className={locale === l
            ? 'bg-white text-gray-900 px-3 py-1 text-sm font-semibold max-lg:min-h-11'
            : 'bg-gray-700 text-white hover:bg-gray-600 px-3 py-1 text-sm max-lg:min-h-11'}
        >
          {LOCALE_NAMES[l]}
        </button>
      ))}
    </div>
  );
};

// 言語の切り替えとサインインの状態。広い幅ではヘッダー、狭い幅では開閉するメニューの中に出す
export const AccountControls: React.FC<{ className?: string }> = ({ className = '' }) => {
  const { data: session } = useSession();
  return (
    <div className={`flex flex-wrap items-center gap-4 ${className}`}>
      <LanguageSwitch />
      {session ? (
        <>
          <span className="break-all">Hello, {session.user?.name || session.user?.email}</span>
          <button
            onClick={() => signOut()}
            className="bg-red-600 hover:bg-red-500 text-white py-2 px-4 rounded-sm max-lg:min-h-11"
          >
            Sign Out
          </button>
        </>
      ) : (
        <span className="bg-blue-600 hover:bg-blue-500 text-white py-2 px-4 rounded-sm cursor-pointer">
          <button onClick={() => signIn('keycloak')}>
            Sign In
          </button>
        </span>
      )}
    </div>
  );
};

const Header: React.FC<{ menuOpen: boolean; onToggleMenu: () => void }> = ({ menuOpen, onToggleMenu }) => (
  <header className="bg-gray-800 text-white p-4 flex justify-between items-center gap-3">
    <div className="text-lg sm:text-xl font-bold min-w-0">TCP/UDP Forward Web UI</div>
    <AccountControls className="hidden lg:flex flex-nowrap" />
    {/* 狭い幅のメニューの開閉（メニューにはページへのリンク・言語の切り替え・サインアウト） */}
    <button
      type="button"
      className="lg:hidden shrink-0 inline-flex items-center gap-2 min-h-11 min-w-11 px-3 rounded-sm border border-gray-500 bg-gray-700 text-white hover:bg-gray-600 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-400"
      aria-expanded={menuOpen}
      aria-controls="main-menu"
      onClick={onToggleMenu}
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        {menuOpen
          ? <path d="M5 5l10 10M15 5L5 15" />
          : <path d="M3 5h14M3 10h14M3 15h14" />}
      </svg>
      <span className="text-sm">メニュー</span>
    </button>
  </header>
);

export default Header;
