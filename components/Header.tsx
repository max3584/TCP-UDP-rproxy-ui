import { signOut, signIn, useSession } from 'next-auth/react';

const Header: React.FC = () => {
  const { data: session } = useSession();

  return (
    <header className="bg-gray-800 text-white p-4 flex justify-between items-center">
      <div className="text-xl font-bold">TCP/UDP Forward Web UI</div>
      <div>
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
            <button onClick={() => signIn('auth0')}>
              Sign In
            </button>
          </span>
        )}
      </div>
    </header>
  );
};

export default Header;
