import NextAuth, { NextAuthOptions } from 'next-auth';
import KeycloakProvider from 'next-auth/providers/keycloak';
import { sessionUser } from '@/components/lib';

// アクセストークンは発行元からバックチャネルで受け取ったものなので、署名は検証せずに中身だけを読む
export function realmRoles(accessToken: string): string[] {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
    const roles = payload?.realm_access?.roles;
    return Array.isArray(roles) ? roles.filter((r: unknown): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

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
        token.roles = realmRoles(account.access_token);
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
        },
        expires: session.expires || ''
      };
    },
  },
}

export default NextAuth(authOptions);
