import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Sidebar from './Sidebar';
import Header from './Header';

const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const router = useRouter();
  // 狭い幅（lg 未満）ではメニューを開閉する。広い幅では常に出す（menuOpen は使わない）
  const [menuOpen, setMenuOpen] = useState(false);

  // 画面を移ったら（戻る・進むを含む）閉じる
  useEffect(() => {
    const close = () => setMenuOpen(false);
    router.events?.on('routeChangeStart', close);
    return () => router.events?.off('routeChangeStart', close);
  }, [router.events]);

  // Esc で閉じる
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    // ページ全体が伸びる（内側だけのスクロールにしない）。サイドバーはスクロールしても残す
    <div className="flex flex-col min-h-screen bg-gray-100 text-gray-900">
      <Header menuOpen={menuOpen} onToggleMenu={() => setMenuOpen(!menuOpen)} />
      <div className="flex flex-col lg:flex-row flex-1 min-w-0">
        <Sidebar open={menuOpen} onNavigate={() => setMenuOpen(false)} />
        <main className="flex-1 min-w-0 p-4 md:p-6 bg-gray-100 text-gray-900">
          {children}
        </main>
      </div>
    </div>
  );
};

export default Layout;
