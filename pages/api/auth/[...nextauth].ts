import NextAuth, { NextAuthOptions } from 'next-auth';
import KeycloakProvider from 'next-auth/providers/keycloak';
import { sessionUser } from '@/components/lib';
import { accessOf, roleConfig, rolesFromToken } from '@/components/roles';

export const authOptions: NextAuthOptions = {
  providers: [
    KeycloakProvider({
      clientId: process.env.KEYCLOAK_CLIENT_ID ?? '',
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET ?? '',
      issuer: process.env.KEYCLOAK_ISSUER,
    })
  ],
  callbacks: {
    async jwt({ token, account }) {
      // サインイン時だけ account が渡される
      if (account?.access_token) {
        // 既定は realm_access.roles（RPROXY_UI_ROLES_CLAIM で変えられる）
        token.roles = rolesFromToken(account.access_token, roleConfig().claim);
      }
      return token;
    },
    async session({ session, token }): Promise<sessionUser> {
      const roles = Array.isArray(token.roles) ? (token.roles as string[]) : [];
      return {
        user: {
          name: token.name || '',
          email: token.email || '',
          image: token.picture || '',
          id: token.sub || '',
          role: roles.join(','),
          roles: roles,
          // 画面の表示用。API route はリクエストごとに roles から決め直す
          access: accessOf(roles, roleConfig()),
        },
        expires: session.expires || ''
      };
    },
  },
}

export default NextAuth(authOptions);
