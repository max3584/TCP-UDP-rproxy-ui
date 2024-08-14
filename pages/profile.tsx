import { useSession, signIn, signOut } from 'next-auth/react';
import { sessionUser } from '@/components/lib';

const Profile: React.FC = () => {
  const { data: session, status } = useSession();
  const sessionUser = session as sessionUser;

  if (status === 'loading') {
    return <p className="text-center text-gray-500">Loading...</p>;
  }

  if (!sessionUser) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-gray-100">
        <div className="bg-white p-8 rounded-lg shadow-lg w-full max-w-md text-center">
          <p className="text-lg font-medium mb-4">You are not signed in</p>
          <button
            onClick={() => signIn('auth0')}
            className="bg-blue-500 hover:bg-blue-600 text-white font-semibold py-2 px-4 rounded transition duration-300 ease-in-out"
          >
            Sign In
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-screen bg-gray-100">
      <div className="bg-white p-8 rounded-lg shadow-lg w-full max-w-md">
        <h1 className="text-2xl font-bold mb-4 text-center">Profile</h1>
        <div className="mb-4">
          <p className="text-lg font-medium"><strong>Name:</strong> {sessionUser.user?.name}</p>
          <p className="text-lg font-medium"><strong>Email:</strong> {sessionUser.user?.email}</p>
          <p className="text-lg font-medium"><strong>ID:</strong> {sessionUser.user?.id}</p>
          <p className="text-lg font-medium"><strong>role:</strong> {sessionUser.user?.role}</p>
        </div>
        <div className="text-center">
          <button
            onClick={() => signOut()}
            className="bg-red-600 hover:bg-red-700 text-white font-semibold py-2 px-4 rounded-full transition duration-300 ease-in-out"
          >
            Sign Out
          </button>
        </div>
      </div>
    </div>
  );
};

export default Profile;
