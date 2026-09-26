import Link from 'next/link';
import { useRouter } from 'next/router';

// ルールの詳細・変更の画面はダッシュボードの下にあるものとして扱う
const NAV: { href: string; label: string; active: (pathname: string) => boolean }[] = [
  { href: '/', label: 'ダッシュボード', active: (p) => p === '/' || (p.startsWith('/rules/') && p !== '/rules/new') },
  { href: '/rules/new', label: '新規ルール', active: (p) => p === '/rules/new' },
  { href: '/profile', label: 'Profile', active: (p) => p === '/profile' },
];

const Sidebar: React.FC = () => {
  const router = useRouter();

  return (
    <nav aria-label="メインメニュー" className="w-48 md:w-56 shrink-0 bg-gray-800 text-white p-4">
      <ul className="space-y-2 sticky top-4">
        {NAV.map((item) => {
          const active = item.active(router.pathname);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`block px-4 py-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
                  active ? 'bg-gray-600 text-white font-semibold' : 'text-gray-200 hover:bg-gray-700 hover:text-white'
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
};

export default Sidebar;
