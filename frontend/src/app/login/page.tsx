'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, gql } from '@apollo/client';
import { login, isAdmin, setBypassUser } from '@/lib/auth';
import { cn } from '@/lib/utils';

const isBypass = process.env.NEXT_PUBLIC_COGNITO_BYPASS === 'true';

const LIST_USERS = gql`
  query LoginListUsers {
    listUsers {
      id
      name
      email
      role
    }
  }
`;

interface PickerUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

function BypassUserPicker() {
  const router = useRouter();
  const { data, loading, error } = useQuery<{ listUsers: PickerUser[] }>(LIST_USERS);

  function handlePick(user: PickerUser) {
    setBypassUser(user.id, user.name, user.role);
    router.push(user.role === 'admin' ? '/admin' : '/');
  }

  return (
    <div className="card w-full max-w-[400px] p-8">
      <h2 className="font-semibold text-2xl mb-2 text-graphite">Dev Login</h2>
      <p className="text-grey text-sm mb-6">Select a user to sign in as</p>

      {loading && <p className="text-grey text-sm">Loading users&hellip;</p>}

      {error && (
        <div role="alert" className="alert-error">
          {error.message}
        </div>
      )}

      {data?.listUsers.map((user) => (
        <button
          key={user.id}
          onClick={() => handlePick(user)}
          className="flex items-center justify-between w-full p-3 px-4 mb-3
                     rounded border border-grey bg-ivory-tint cursor-pointer text-left
                     transition-[border-radius,border-color] duration-200
                     hover:rounded-lg hover:border-graphite active:scale-[0.98]"
        >
          <div>
            <div className="font-semibold text-[15px] text-graphite">{user.name}</div>
            <div className="text-[13px] text-grey">{user.email}</div>
          </div>
          <span
            className={cn(
              'badge',
              user.role === 'admin' ? 'bg-horizon-red text-white' : 'bg-graphite text-white'
            )}
          >
            {user.role}
          </span>
        </button>
      ))}
    </div>
  );
}

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
        setError('You must set a new password. This flow is not yet implemented.');
        setLoading(false);
        return;
      }

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
    <div className="min-h-screen flex items-center justify-center bg-ivory">
      {isBypass ? (
        <BypassUserPicker />
      ) : (
        <form onSubmit={handleSubmit} className="card w-full max-w-[400px] p-8">
          <h2 className="font-semibold text-2xl mb-2 text-graphite">Sign in</h2>
          <p className="text-grey text-sm mb-6">elastichorizon Arena</p>

          {error && (
            <div role="alert" className="alert-error mb-4">
              {error}
            </div>
          )}

          <label htmlFor="email" className="block text-sm font-medium mb-1 text-graphite">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input-field mb-4"
          />

          <label htmlFor="password" className="block text-sm font-medium mb-1 text-graphite">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input-field mb-6"
          />

          <button
            type="submit"
            disabled={loading}
            className="btn-primary w-full py-2.5 text-base tracking-[0.03em]"
          >
            {loading ? 'Signing in\u2026' : 'Sign in'}
          </button>
        </form>
      )}
    </div>
  );
}
