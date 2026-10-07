import Link from 'next/link';
import { useRouter } from 'next/router';
import { AccountControls } from './Header';
import { SidebarVersions } from './VersionInfo';

// ルールの詳細・変更の画面はダッシュボードの下にあるものとして扱う
const NAV: { href: string; label: string; active: (pathname: string) => boolean }[] = [
  { href: '/', label: 'ダッシュボード', active: (p) => p === '/' || (p.startsWith('/rules/') && p !== '/rules/new' && p !== '/rules/import') },
  { href: '/rules/new', label: '新規ルール', active: (p) => p === '/rules/new' },
  { href: '/rules/import', label: 'インポート', active: (p) => p === '/rules/import' },
  { href: '/history', label: '変更の履歴', active: (p) => p === '/history' },
  { href: '/usage', label: '利用量', active: (p) => p === '/usage' },
  { href: '/system', label: 'rproxy の機能と設定', active: (p) => p === '/system' },
  { href: '/profile', label: 'Profile', active: (p) => p === '/profile' },
];

// 広い幅（lg 以上）では左の列に常に出す。狭い幅ではヘッダーの「メニュー」で開閉し、ヘッダーの下に出す
const Sidebar: React.FC<{ open: boolean; onNavigate: () => void }> = ({ open, onNavigate }) => {
  const router = useRouter();

  return (
    <nav
      id="main-menu"
      aria-label="メインメニュー"
      className={`${open ? 'block' : 'hidden'} lg:block w-full lg:w-56 shrink-0 bg-gray-800 text-white p-4 max-lg:pt-0 max-lg:border-t max-lg:border-gray-700`}
    >
      <ul className="space-y-2 lg:sticky lg:top-4 max-lg:pt-4">
        {NAV.map((item) => {
          const active = item.active(router.pathname);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                onClick={onNavigate}
                className={`block px-4 py-3 lg:py-2 rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-400 ${
                  active ? 'bg-gray-600 text-white font-semibold' : 'text-gray-200 hover:bg-gray-700 hover:text-white'
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
      <AccountControls className="lg:hidden mt-4 pt-4 border-t border-gray-700 text-white" />
      <SidebarVersions />
    </nav>
  );
};

export default Sidebar;
