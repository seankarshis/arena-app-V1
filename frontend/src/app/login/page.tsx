'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { login, isAdmin } from '@/lib/auth';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await login(email, password);

      if (result.nextStep?.signInStep === 'CONFIRM_SIGN_UP') {
        setError('Please confirm your account before signing in.');
        setLoading(false);
        return;
      }

      if (
        result.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED'
      ) {
        // TODO: implement new-password challenge flow
        setError('You must set a new password. This flow is not yet implemented.');
        setLoading(false);
        return;
      }

      // Route based on group membership
      const admin = await isAdmin();
      router.push(admin ? '/admin' : '/');
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Sign-in failed. Please try again.';
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'var(--ivory)',
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          width: '100%',
          maxWidth: 400,
          padding: 32,
          backgroundColor: 'var(--white)',
          borderRadius: 8,
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
        }}
      >
        <h2
          style={{
            fontFamily: 'var(--font-primary)',
            fontWeight: 600,
            fontSize: 24,
            marginBottom: 8,
            color: 'var(--graphite)',
          }}
        >
          Sign in
        </h2>
        <p
          style={{
            fontFamily: 'var(--font-primary)',
            color: 'var(--grey)',
            fontSize: 14,
            marginBottom: 24,
          }}
        >
          elastichorizon Arena
        </p>

        {error && (
          <div
            role="alert"
            style={{
              padding: '8px 12px',
              marginBottom: 16,
              borderRadius: 4,
              backgroundColor: '#FEE2E2',
              color: 'var(--horizon-red)',
              fontSize: 14,
            }}
          >
            {error}
          </div>
        )}

        <label
          htmlFor="email"
          style={{
            display: 'block',
            fontSize: 14,
            fontWeight: 500,
            marginBottom: 4,
            color: 'var(--graphite)',
          }}
        >
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{
            width: '100%',
            padding: '8px 12px',
            marginBottom: 16,
            borderRadius: 4,
            border: '1px solid var(--grey)',
            backgroundColor: 'var(--ivory-tint)',
            fontFamily: 'var(--font-primary)',
            fontSize: 16,
          }}
        />

        <label
          htmlFor="password"
          style={{
            display: 'block',
            fontSize: 14,
            fontWeight: 500,
            marginBottom: 4,
            color: 'var(--graphite)',
          }}
        >
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{
            width: '100%',
            padding: '8px 12px',
            marginBottom: 24,
            borderRadius: 4,
            border: '1px solid var(--grey)',
            backgroundColor: 'var(--ivory-tint)',
            fontFamily: 'var(--font-primary)',
            fontSize: 16,
          }}
        />

        <button
          type="submit"
          disabled={loading}
          style={{
            width: '100%',
            padding: '10px 0',
            borderRadius: 999,
            border: 'none',
            backgroundColor: 'var(--horizon-red)',
            color: 'var(--white)',
            fontFamily: 'var(--font-primary)',
            fontWeight: 600,
            fontSize: 16,
            letterSpacing: '0.03em',
            cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? 'Signing in\u2026' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
