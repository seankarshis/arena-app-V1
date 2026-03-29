'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useApolloClient } from '@apollo/client';
import { logout, getUser } from '@/lib/auth';

// ---------------------------------------------------------------------------
// Nav items
// ---------------------------------------------------------------------------

const NAV_ITEMS = [
  { label: 'DASHBOARD', href: '/admin' },
  { label: 'TEMPLATES', href: '/admin/templates' },
  { label: 'QUESTIONS', href: '/admin/questions' },
  { label: 'TAGS', href: '/admin/tags' },
  { label: 'USERS', href: '/admin/users' },
  { label: 'INTERVIEWS', href: '/admin/interviews' },
];

// ---------------------------------------------------------------------------
// AdminLayout
// ---------------------------------------------------------------------------

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const client = useApolloClient();
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    getUser().then((u) => { if (u) setUsername(u.username); });
  }, []);

  async function handleSignOut() {
    await logout();
    await client.clearStore();
    router.push('/login');
  }

  const isActive = (href: string) => {
    if (href === '/admin') return pathname === '/admin';
    return pathname.startsWith(href);
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      {/* Sidebar */}
      <aside
        style={{
          width: 240,
          minWidth: 240,
          backgroundColor: 'var(--white)',
          borderRight: '1px solid var(--ivory-tint)',
          display: 'flex',
          flexDirection: 'column',
          position: 'fixed',
          top: 0,
          left: 0,
          bottom: 0,
          zIndex: 10,
        }}
      >
        {/* Wordmark */}
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--ivory-tint)' }}>
          <span
            style={{
              display: 'block',
              fontFamily: 'var(--font-logo)',
              fontWeight: 100,
              fontSize: 22,
              letterSpacing: '-0.06em',
              color: 'var(--logo-grey)',
              textTransform: 'lowercase',
              userSelect: 'none',
            }}
          >
            elastichorizon
          </span>
          <span
            style={{
              display: 'block',
              marginTop: 6,
              fontFamily: 'var(--font-primary)',
              fontWeight: 300,
              fontSize: 10,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: 'var(--grey)',
              userSelect: 'none',
            }}
          >
            Arena AI — Admin
          </span>
        </div>

        {/* Nav links */}
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '16px 12px 0', flex: 1 }}>
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                style={{
                  display: 'block',
                  padding: '10px 12px 10px 16px',
                  borderRadius: 6,
                  borderLeft: active ? '3px solid var(--horizon-red)' : '3px solid transparent',
                  backgroundColor: active ? 'rgba(122, 14, 19, 0.06)' : 'transparent',
                  color: active ? 'var(--horizon-red)' : 'var(--grey)',
                  fontFamily: 'var(--font-primary)',
                  fontWeight: 500,
                  fontSize: 14,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  textDecoration: 'none',
                  transition: 'color 0.15s, background-color 0.15s',
                }}
                onMouseEnter={(e) => {
                  if (!active) {
                    e.currentTarget.style.color = 'var(--graphite)';
                    e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.02)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!active) {
                    e.currentTarget.style.color = 'var(--grey)';
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }
                }}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* User info + Sign out */}
        <div
          style={{
            padding: '16px 20px',
            borderTop: '1px solid var(--ivory-tint)',
          }}
        >
          {username && (
            <p
              style={{
                fontFamily: 'var(--font-primary)',
                fontSize: 12,
                color: 'var(--grey)',
                marginBottom: 8,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={username}
            >
              {username}
            </p>
          )}
          <button
            onClick={handleSignOut}
            style={{
              background: 'none',
              border: 'none',
              fontFamily: 'var(--font-primary)',
              fontSize: 13,
              fontWeight: 500,
              color: 'var(--grey)',
              cursor: 'pointer',
              padding: 0,
              transition: 'color 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--horizon-red)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--grey)'; }}
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div style={{ flex: 1, marginLeft: 240, minHeight: '100vh', backgroundColor: 'var(--ivory)' }}>
        <main>{children}</main>
      </div>
    </div>
  );
}
