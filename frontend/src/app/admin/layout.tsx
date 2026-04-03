'use client';

import React, { useEffect, useState, useCallback, type ElementType } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useApolloClient } from '@apollo/client';
import { logout, getUser } from '@/lib/auth';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  FileText,
  MessageCircleQuestion,
  Tags,
  Users,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  Menu,
  X,
  LogOut,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Nav items
// ---------------------------------------------------------------------------

const NAV_ITEMS: { label: string; href: string; icon: ElementType }[] = [
  { label: 'DASHBOARD', href: '/admin', icon: LayoutDashboard },
  { label: 'TEMPLATES', href: '/admin/templates', icon: FileText },
  { label: 'QUESTIONS', href: '/admin/questions', icon: MessageCircleQuestion },
  { label: 'TAGS', href: '/admin/tags', icon: Tags },
  { label: 'USERS', href: '/admin/users', icon: Users },
  { label: 'INTERVIEWS', href: '/admin/interviews', icon: Mic },
];

const LS_KEY = 'arena-sidebar-collapsed';

// ---------------------------------------------------------------------------
// AdminLayout
// ---------------------------------------------------------------------------

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const client = useApolloClient();
  const [username, setUsername] = useState<string | null>(null);

  // Sidebar state
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [isTablet, setIsTablet] = useState(false);

  // Read persisted preference on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(LS_KEY);
      if (stored === 'true') setCollapsed(true);
    } catch { /* SSR / no localStorage */ }
  }, []);

  // Responsive breakpoints
  useEffect(() => {
    const mqMobile = window.matchMedia('(max-width: 767px)');
    const mqTablet = window.matchMedia('(min-width: 768px) and (max-width: 1024px)');

    const update = () => {
      setIsMobile(mqMobile.matches);
      setIsTablet(mqTablet.matches);
    };

    update();
    mqMobile.addEventListener('change', update);
    mqTablet.addEventListener('change', update);
    return () => {
      mqMobile.removeEventListener('change', update);
      mqTablet.removeEventListener('change', update);
    };
  }, []);

  // Auto-collapse on tablet; close mobile drawer on resize up
  useEffect(() => {
    if (isMobile) {
      setMobileOpen(false);
    }
    if (isTablet) {
      setCollapsed(true);
    }
  }, [isMobile, isTablet]);

  // Auth
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

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(LS_KEY, String(next)); } catch { /* noop */ }
      return next;
    });
  }, []);

  const handleNavClick = useCallback(() => {
    if (isMobile) setMobileOpen(false);
  }, [isMobile]);

  // Effective collapsed state: always collapsed on tablet, user pref on desktop
  const isCollapsed = isMobile ? false : (isTablet || collapsed);
  const sidebarWidth = isCollapsed ? 'w-16' : 'w-60';

  return (
    <div className="flex min-h-screen">
      {/* ---- Mobile top bar ---- */}
      {isMobile && (
        <header className="fixed top-0 left-0 right-0 h-14 bg-white border-b border-ivory-tint z-20 flex items-center px-4 gap-3">
          <button
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            className="p-1.5 -ml-1 text-graphite hover:text-horizon-red transition-colors"
          >
            <Menu size={22} />
          </button>
          <span className="font-primary font-light text-[10px] tracking-wide uppercase text-grey select-none">
            Arena AI — Admin
          </span>
        </header>
      )}

      {/* ---- Mobile backdrop ---- */}
      {isMobile && mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/30 transition-opacity"
          onClick={() => setMobileOpen(false)}
          aria-label="Close menu"
        />
      )}

      {/* ---- Sidebar ---- */}
      <aside
        className={cn(
          'fixed top-0 left-0 bottom-0 bg-white border-r border-ivory-tint flex flex-col z-40',
          'transition-[width,transform] duration-200 ease-in-out',
          sidebarWidth,
          isMobile
            ? mobileOpen
              ? 'w-60 translate-x-0'
              : 'w-60 -translate-x-full'
            : 'translate-x-0'
        )}
      >
        {/* Wordmark / lettermark */}
        <div className="py-5 px-6 border-b border-ivory-tint min-h-[72px] flex items-center">
          {isCollapsed ? (
            <span className="w-full text-center font-hero text-[22px] text-logo-grey select-none">
              A
            </span>
          ) : (
            <div>
              {isMobile && (
                <button
                  onClick={() => setMobileOpen(false)}
                  aria-label="Close menu"
                  className="absolute top-4 right-3 p-1 text-grey hover:text-horizon-red transition-colors"
                >
                  <X size={18} />
                </button>
              )}
              <span className="block font-primary font-thin text-[22px] tracking-[-0.06em] text-logo-grey lowercase select-none">
                elastichorizon
              </span>
              <span className="block mt-1.5 font-primary font-light text-[10px] tracking-wide uppercase text-grey select-none">
                Arena AI — Admin
              </span>
            </div>
          )}
        </div>

        {/* Nav links */}
        <nav className={cn('flex flex-col gap-0.5 pt-4 flex-1', isCollapsed ? 'px-2' : 'px-3')}>
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={handleNavClick}
                title={isCollapsed ? item.label : undefined}
                className={cn(
                  'flex items-center gap-3 rounded font-primary font-medium text-sm tracking-nav uppercase no-underline',
                  'transition-[border-radius,color,background-color] duration-200',
                  isCollapsed ? 'justify-center py-2.5 px-0' : 'py-2.5 px-3 pl-4',
                  active
                    ? isCollapsed
                      ? 'bg-horizon-red/[0.06] text-horizon-red'
                      : 'border-l-2 border-l-horizon-red bg-horizon-red/[0.06] text-horizon-red'
                    : isCollapsed
                      ? 'text-grey hover:text-graphite hover:bg-graphite/[0.02] hover:rounded-lg'
                      : 'border-l-2 border-l-transparent text-grey hover:text-graphite hover:bg-graphite/[0.02] hover:rounded-lg'
                )}
              >
                <Icon size={18} className="shrink-0" />
                {!isCollapsed && <span>{item.label}</span>}
              </Link>
            );
          })}

          {/* Collapse toggle — desktop/tablet only */}
          {!isMobile && (
            <button
              onClick={toggleCollapsed}
              aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className={cn(
                'mt-auto flex items-center gap-3 rounded py-2.5 font-primary text-sm text-grey',
                'hover:text-graphite hover:bg-graphite/[0.02] transition-colors duration-150',
                isCollapsed ? 'justify-center px-0' : 'px-3 pl-4'
              )}
            >
              {isCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
              {!isCollapsed && <span className="font-medium tracking-nav uppercase">Collapse</span>}
            </button>
          )}
        </nav>

        {/* User info + Sign out */}
        <div className={cn('py-4 border-t border-ivory-tint', isCollapsed ? 'px-2' : 'px-5')}>
          {isCollapsed ? (
            <button
              onClick={handleSignOut}
              title="Sign out"
              className="w-full flex justify-center py-1.5 text-grey hover:text-horizon-red transition-colors"
            >
              <LogOut size={18} />
            </button>
          ) : (
            <>
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
            </>
          )}
        </div>
      </aside>

      {/* ---- Main content ---- */}
      <div
        className={cn(
          'flex-1 min-h-screen bg-ivory transition-[margin] duration-200',
          isMobile ? 'ml-0 pt-14' : isCollapsed ? 'ml-16' : 'ml-60'
        )}
      >
        <main>{children}</main>
      </div>
    </div>
  );
}
