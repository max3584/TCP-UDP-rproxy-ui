import Link from 'next/link';
import { useRouter } from 'next/router';




const Sidebar: React.FC = () => {
  const router = useRouter();

  return (
    <div className="w-64 bg-gray-800 text-white h-screen p-4">
      <h2 className="text-xl font-bold mb-6">Dashboard</h2>
      <ul className="space-y-4">
        <li>
          <Link href="/">
            <span className={`block px-4 py-2 rounded ${
              router.pathname === '/' ? 'bg-gray-600 text-white' : 'hover:bg-gray-600 text-gray-300'
            }`}>
              TCP/UDP Forwarding
            </span>
          </Link>
        </li>
        <li>
          <Link href="/profile">
            <span className={`block px-4 py-2 rounded ${
              router.pathname === '/profile' ? 'bg-gray-600 text-white' : 'hover:bg-gray-600 text-gray-300'
            }`}>
              Profile
            </span>
          </Link>
        </li>
        {/* 他のナビゲーションリンクを追加できます */}
      </ul>
    </div>
  );
};

export default Sidebar;
