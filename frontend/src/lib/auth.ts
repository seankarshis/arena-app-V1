'use client';

const isBypass = process.env.NEXT_PUBLIC_COGNITO_BYPASS === 'true';

// Only configure Amplify when not bypassing
if (!isBypass) {
  const { Amplify } = require('aws-amplify');
  Amplify.configure(
    {
      Auth: {
        Cognito: {
          userPoolId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID ?? '',
          userPoolClientId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID ?? '',
        },
      },
    },
    { ssr: true }
  );
}

export async function getIdToken(): Promise<string | null> {
  if (isBypass) return null;
  try {
    const { fetchAuthSession } = await import('aws-amplify/auth');
    const session = await fetchAuthSession();
    return session.tokens?.idToken?.toString() ?? null;
  } catch {
    return null;
  }
}

export async function getUserGroups(): Promise<string[]> {
  if (isBypass) return ['admin'];
  try {
    const { fetchAuthSession } = await import('aws-amplify/auth');
    const session = await fetchAuthSession();
    const payload = session.tokens?.idToken?.payload;
    const groups = payload?.['cognito:groups'];
    if (Array.isArray(groups)) return groups as string[];
    return [];
  } catch {
    return [];
  }
}

export async function isAdmin(): Promise<boolean> {
  const groups = await getUserGroups();
  return groups.includes('admin');
}

export async function login(email: string, password: string) {
  if (isBypass) {
    return { isSignedIn: true, nextStep: { signInStep: 'DONE' } };
  }
  const { signIn } = await import('aws-amplify/auth');
  return signIn({ username: email, password });
}

export async function logout() {
  if (isBypass) return;
  const { signOut } = await import('aws-amplify/auth');
  return signOut();
}

export async function getUser() {
  if (isBypass) {
    return { userId: 'mock-admin', username: 'dev@localhost' };
  }
  try {
    const { getCurrentUser } = await import('aws-amplify/auth');
    return await getCurrentUser();
  } catch {
    return null;
  }
}
