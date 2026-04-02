'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useApolloClient } from '@apollo/client';
import { logout, getUser } from '@/lib/auth';
import { cn } from '@/lib/utils';

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
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="w-60 min-w-[240px] bg-white border-r border-ivory-tint flex flex-col fixed top-0 left-0 bottom-0 z-10">
        {/* Wordmark */}
        <div className="py-5 px-6 border-b border-ivory-tint">
          <span className="block font-primary font-thin text-[22px] tracking-[-0.06em] text-logo-grey lowercase select-none">
            elastichorizon
          </span>
          <span className="block mt-1.5 font-primary font-light text-[10px] tracking-wide uppercase text-grey select-none">
            Arena AI — Admin
          </span>
        </div>

        {/* Nav links */}
        <nav className="flex flex-col gap-0.5 pt-4 px-3 flex-1">
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'block py-2.5 px-3 pl-4 rounded font-primary font-medium text-sm tracking-nav uppercase no-underline',
                  'transition-[border-radius,color,background-color] duration-200',
                  active
                    ? 'border-l-2 border-l-horizon-red bg-horizon-red/[0.06] text-horizon-red'
                    : 'border-l-2 border-l-transparent text-grey hover:text-graphite hover:bg-graphite/[0.02] hover:rounded-lg'
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* User info + Sign out */}
        <div className="py-4 px-5 border-t border-ivory-tint">
          {username && (
            <p
              className="text-xs text-grey mb-2 overflow-hidden text-ellipsis whitespace-nowrap"
              title={username}
            >
              {username}
            </p>
          )}
          <button onClick={handleSignOut} className="btn-ghost text-[13px] font-medium p-0">
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 ml-60 min-h-screen bg-ivory">
        <main>{children}</main>
      </div>
    </div>
  );
}
