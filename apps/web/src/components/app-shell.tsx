import {
  BookOpen,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogIn,
  Menu,
  Send,
  Trophy,
  UserRound,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";

import type { CurrentUser } from "../models/identity.js";

const navigation = [
  ["/", "概要", LayoutDashboard],
  ["/contest", "コンテスト", BookOpen],
  ["/leaderboard", "リーダーボード", Trophy],
  ["/submit", "提出", Send],
] as const;

export function AppShell({
  user,
  children,
}: {
  user: CurrentUser | null | undefined;
  children: ReactNode;
}) {
  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="site-header-inner">
          <Link to="/" className="brand" aria-label="1BRC for traP ホーム">
            <span>1BRC</span>
            <small>for traP</small>
          </Link>
          <nav className="desktop-nav" aria-label="メインメニュー">
            {navigation.map(([to, label]) => (
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
                {navigation.map(([to, label, Icon]) => (
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
