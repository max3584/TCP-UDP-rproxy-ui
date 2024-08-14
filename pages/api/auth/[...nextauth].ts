import NextAuth, {NextAuthOptions, Session, User as NextAuthUser } from 'next-auth';
import Auth0Provider from "next-auth/providers/auth0";
import { sessionUser } from '@/components/lib';


const getAccessToken = async () => {
  let res = await fetch(`${process.env.AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.AUTH0_CLIENT_ID,
      client_secret: process.env.AUTH0_CLIENT_SECRET,
      audience: `${process.env.AUTH0_DOMAIN}/api/v2/`
    })
  });
  let data = await res.json();
  return data;
}

const getRole = async (id: string) => {
  let token = await getAccessToken();
  let option = {
    headers: {
      authorization: `${token.token_type} ${token.access_token}`,
    },
  }
  let res = await fetch(`${process.env.AUTH0_DOMAIN}/api/v2/users/${id}/roles`, option);
  let data = await res.json();
  return data[0]?.name;
}

export const authOptions: NextAuthOptions = {
  providers: [
    Auth0Provider({
      clientId: process.env.AUTH0_CLIENT_ID ?? '',
      clientSecret: process.env.AUTH0_CLIENT_SECRET ?? '',
      issuer: process.env.AUTH0_DOMAIN
    })
  ],
  callbacks: {
    async session({ session, token }): Promise<sessionUser> {
      let sessionUser: sessionUser = {
        user: {
          name: token.name || '',
          email: token.email || '',
          image: token.picture || '',
          id: token.sub || '',
          role: ''
        },
        expires: session.expires || ''
      }

        let role = await getRole(sessionUser.user.id);
        if (!role || role !== 'undefined') {
          sessionUser.user.role = role;
        }
      return sessionUser;
    },
  },
  pages: {
    signIn: '/auth/signin',
  },
}

export default NextAuth(authOptions);
