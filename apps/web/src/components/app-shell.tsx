import {
  BookOpen,
  BookOpenCheck,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogIn,
  Menu,
  Send,
  Trophy,
  UserRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";

import type { CurrentUser } from "../models/identity.js";

type NavigationItem = readonly [string, string, LucideIcon];

function navigation(showGuide: boolean): readonly NavigationItem[] {
  const guideItems: readonly NavigationItem[] = showGuide
    ? [["/guide", "解説", BookOpenCheck]]
    : [];
  return [
    ["/", "概要", LayoutDashboard],
    ["/contest", "コンテスト", BookOpen],
    ["/leaderboard", "リーダーボード", Trophy],
    ...guideItems,
    ["/submit", "提出", Send],
  ];
}

export function AppShell({
  user,
  showGuide,
  children,
}: {
  user: CurrentUser | null | undefined;
  showGuide: boolean;
  children: ReactNode;
}) {
  const navigationItems = navigation(showGuide);
  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="site-header-inner">
          <Link to="/" className="brand" aria-label="1BRC for traP ホーム">
            <span>1BRC</span>
            <small>for traP</small>
          </Link>
          <nav className="desktop-nav" aria-label="メインメニュー">
            {navigationItems.map(([to, label]) => (
              <NavLink key={to} to={to} end={to === "/"}>
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="header-actions">
            {user ? (
              <div className="dropdown dropdown-end">
                <button className="account-button" tabIndex={0}>
                  <UserRound size={17} />
                  <span>{user.username}</span>
                </button>
                <ul className="menu dropdown-content account-menu" tabIndex={0}>
                  <li>
                    <Link to="/submissions">
                      <ListChecks size={16} /> 提出履歴
                    </Link>
                  </li>
                  <li>
                    <Link to="/access-key">
                      <KeyRound size={16} /> アクセスキー
                    </Link>
                  </li>
                  {user.isAdmin && (
                    <li>
                      <Link to="/admin">運営管理</Link>
                    </li>
                  )}
                </ul>
              </div>
            ) : (
              <a
                className="btn btn-primary btn-sm"
                href="/_oauth/login?redirect=/"
              >
                <LogIn size={16} /> ログイン
              </a>
            )}
            <div className="dropdown dropdown-end mobile-nav">
              <button
                className="btn btn-ghost btn-square btn-sm"
                tabIndex={0}
                aria-label="メニュー"
              >
                <Menu size={20} />
              </button>
              <ul className="menu dropdown-content account-menu" tabIndex={0}>
                {navigationItems.map(([to, label, Icon]) => (
                  <li key={to}>
                    <NavLink to={to}>
                      <Icon size={16} /> {label}
                    </NavLink>
                  </li>
                ))}
                {user && (
                  <li>
                    <Link to="/submissions">
                      <ListChecks size={16} /> 提出履歴
                    </Link>
                  </li>
                )}
              </ul>
            </div>
          </div>
        </div>
      </header>
      <main className="site-main">{children}</main>
      <footer className="site-footer">1BRC for traP</footer>
    </div>
  );
}
