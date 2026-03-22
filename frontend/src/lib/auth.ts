'use client';

import { Amplify } from 'aws-amplify';
import {
  signIn,
  signOut,
  fetchAuthSession,
  getCurrentUser,
  type SignInInput,
} from 'aws-amplify/auth';

// Configure Amplify with Cognito settings from environment variables.
// NEXT_PUBLIC_ prefix makes these available in the browser.
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

/**
 * Returns the current Cognito ID token JWT string, or null if not authenticated.
 */
export async function getIdToken(): Promise<string | null> {
  try {
    const session = await fetchAuthSession();
    return session.tokens?.idToken?.toString() ?? null;
  } catch {
    return null;
  }
}

/**
 * Returns the groups from the current user's Cognito JWT, or an empty array.
 */
export async function getUserGroups(): Promise<string[]> {
  try {
    const session = await fetchAuthSession();
    const payload = session.tokens?.idToken?.payload;
    const groups = payload?.['cognito:groups'];
    if (Array.isArray(groups)) {
      return groups as string[];
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Returns true if the current user belongs to the 'admin' Cognito group.
 */
export async function isAdmin(): Promise<boolean> {
  const groups = await getUserGroups();
  return groups.includes('admin');
}

/**
 * Sign in with email/password. Returns the sign-in result.
 */
export async function login(email: string, password: string) {
  const input: SignInInput = { username: email, password };
  return signIn(input);
}

/**
 * Sign out the current user.
 */
export async function logout() {
  return signOut();
}

/**
 * Returns the currently authenticated user, or null if not signed in.
 */
export async function getUser() {
  try {
    return await getCurrentUser();
  } catch {
    return null;
  }
}
