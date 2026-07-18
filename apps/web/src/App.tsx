import { useQuery } from "@tanstack/react-query";
import { LogIn } from "lucide-react";
import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "./components/app-shell.js";
import { accountGateway } from "./gateways/account-gateway.js";
import {
  contestGateway,
  contestQueryKeys,
} from "./gateways/contest-gateway.js";
import { useClock } from "./gateways/use-clock.js";
import { hasContestEnded } from "./models/contest.js";
import { AccessKeyPage } from "./pages/access-key-page.js";
import { AdminPage } from "./pages/admin-page.js";
import { ContestPage } from "./pages/contest-page.js";
import { DashboardPage } from "./pages/dashboard-page.js";
import { GuidePage } from "./pages/guide-page.js";
import { LeaderboardPage } from "./pages/leaderboard-page.js";
import { SubmissionsPage } from "./pages/submissions-page.js";
import { SubmitPage } from "./pages/submit-page.js";

export function App() {
  const now = useClock();
  const me = useQuery({ queryKey: ["me"], queryFn: accountGateway.me });
  const contest = useQuery({
    queryKey: contestQueryKeys.overview,
    queryFn: contestGateway.contest,
  });
  const guideAvailable = contest.data
    ? hasContestEnded(contest.data, now)
    : false;
  return (
    <AppShell user={me.data?.user} showGuide={guideAvailable}>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/contest" element={<ContestPage />} />
        <Route
          path="/guide"
          element={
            contest.isPending ? (
              <div className="empty-state">解説を読み込み中...</div>
            ) : guideAvailable ? (
              <GuidePage />
            ) : (
              <Navigate to="/contest" replace />
            )
          }
        />
        <Route path="/leaderboard" element={<LeaderboardPage />} />
        <Route
          path="/submit"
          element={
            <RequireLogin user={me.data?.user}>
              <SubmitPage />
            </RequireLogin>
          }
        />
        <Route
          path="/submissions"
          element={
            <RequireLogin user={me.data?.user}>
              <SubmissionsPage />
            </RequireLogin>
          }
        />
        <Route
          path="/access-key"
          element={
            <RequireLogin user={me.data?.user}>
              <AccessKeyPage />
            </RequireLogin>
          }
        />
        <Route
          path="/admin"
          element={
            me.data?.user?.isAdmin ? <AdminPage /> : <Navigate to="/" replace />
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}

function RequireLogin({
  user,
  children,
}: {
  user: { username: string } | null | undefined;
  children: ReactNode;
}) {
  if (user) return children;
  return (
    <div className="login-required">
      <LogIn size={32} />
      <h1>ログインが必要です</h1>
      <p>提出、提出履歴、アクセスキーはログイン後に利用できます。</p>
      <a className="btn btn-primary" href="/_oauth/login?redirect=/">
        ログイン
      </a>
    </div>
  );
}
