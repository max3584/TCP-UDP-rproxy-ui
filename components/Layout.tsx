import Sidebar from './Sidebar';
import Header from './Header';

const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    // ページ全体が伸びる（内側だけのスクロールにしない）。サイドバーはスクロールしても残す
    <div className="flex flex-col min-h-screen bg-gray-100 text-gray-900">
      <Header />
      <div className="flex flex-1">
        <Sidebar />
        <main className="flex-1 min-w-0 p-4 md:p-6 bg-gray-100 text-gray-900">
          {children}
        </main>
      </div>
    </div>
  );
};

export default Layout;
