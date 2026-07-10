import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  BookOpen,
  Clock3,
  Copy,
  Database,
  Download,
  Gauge,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogIn,
  Menu,
  Send,
  Server,
  ShieldCheck,
  Terminal,
  Trophy,
  UserRound,
} from "lucide-react";
import { Link, NavLink, Navigate, Route, Routes } from "react-router-dom";
import type { Language, Verdict } from "@1brc/contracts";
import { apiJson, formatBytes, formatDuration, rpc } from "./api.js";
import type {
  Contest,
  Leaderboard,
  LeaderboardEntry,
  Me,
  Submission,
} from "./types.js";

const navigation = [
  ["/", "ダッシュボード", LayoutDashboard],
  ["/contest", "コンテスト詳細", BookOpen],
  ["/leaderboard", "リーダーボード", Trophy],
  ["/submit", "提出", Send],
  ["/submissions", "提出履歴", ListChecks],
  ["/access-key", "アクセスキー", KeyRound],
] as const;

function useContest() {
  return useQuery<Contest>({
    queryKey: ["contest"],
    queryFn: async () => {
      const response = await rpc.contest.$get();
      if (!response.ok) throw new Error("コンテスト情報を取得できませんでした");
      return (await response.json()) as Contest;
    },
    refetchInterval: 30_000,
  });
}

function useMe() {
  return useQuery<Me>({
    queryKey: ["me"],
    queryFn: () => apiJson<Me>("/api/v1/me"),
  });
}

export function App() {
  const me = useMe();
  return (
    <div className="min-h-screen text-base-content">
      <header className="sticky top-0 z-40 border-b border-base-300/80 bg-base-100/90 backdrop-blur-xl">
        <div className="navbar mx-auto max-w-7xl px-4">
          <div className="navbar-start gap-2">
            <div className="dropdown lg:hidden">
              <button
                className="btn btn-ghost btn-square"
                tabIndex={0}
                aria-label="メニュー"
              >
                <Menu size={20} />
              </button>
              <ul
                className="menu dropdown-content z-50 mt-3 w-60 rounded-box border border-base-300 bg-base-200 p-2 shadow-2xl"
                tabIndex={0}
              >
                {navigation.map(([to, label, Icon]) => (
                  <li key={to}>
                    <NavLink to={to}>
                      <Icon size={17} />
                      {label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
            <Link to="/" className="flex items-center gap-3">
              <div className="grid size-10 place-items-center rounded-xl bg-primary text-lg font-black text-primary-content">
                1B
              </div>
              <div>
                <div className="font-bold leading-tight">1BRC for traP</div>
                <div className="text-xs text-base-content/55">
                  One Billion Rows Challenge
                </div>
              </div>
            </Link>
          </div>
          <nav className="navbar-center hidden lg:flex">
            <ul className="menu menu-horizontal gap-1 px-1">
              {navigation.slice(0, 4).map(([to, label]) => (
                <li key={to}>
                  <NavLink
                    to={to}
                    className={({ isActive }) =>
                      isActive ? "font-semibold text-primary" : ""
                    }
                  >
                    {label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <div className="navbar-end">
            {me.data?.user ? (
              <div className="dropdown dropdown-end">
                <button className="btn btn-ghost gap-2" tabIndex={0}>
                  <UserRound size={18} />
                  {me.data.user.username}
                </button>
                <ul
                  className="menu dropdown-content z-50 mt-3 w-56 rounded-box border border-base-300 bg-base-200 p-2 shadow-2xl"
                  tabIndex={0}
                >
                  <li>
                    <Link to="/submissions">提出履歴</Link>
                  </li>
                  <li>
                    <Link to="/access-key">アクセスキー</Link>
                  </li>
                  {me.data.user.isAdmin && (
                    <li>
                      <Link to="/admin">管理</Link>
                    </li>
                  )}
                </ul>
              </div>
            ) : (
              <a
                className="btn btn-primary btn-sm gap-2"
                href="/_oauth/login?redirect=/"
              >
                <LogIn size={16} />
                ログイン
              </a>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-8 md:py-12">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/contest" element={<ContestPage />} />
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
              me.data?.user?.isAdmin ? (
                <AdminPage />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <footer className="border-t border-base-300 py-8 text-center text-sm text-base-content/50">
        1BRC for traP · Ubuntu 26.04 benchmark environment
      </footer>
    </div>
  );
}

function RequireLogin({
  user,
  children,
}: {
  user: Me["user"] | undefined;
  children: ReactNode;
}) {
  if (user) return children;
  return (
    <div className="panel mx-auto max-w-xl p-8 text-center">
      <LogIn className="mx-auto mb-4 text-primary" size={40} />
      <h1 className="text-2xl font-bold">ログインが必要です</h1>
      <p className="mt-2 text-base-content/65">
        提出・履歴・アクセスキーはtraPアカウントでログイン後に利用できます。
      </p>
      <a className="btn btn-primary mt-6" href="/_oauth/login?redirect=/">
        ログイン
      </a>
    </div>
  );
}

function Dashboard() {
  const contest = useContest();
  const leaderboard = useQuery<Leaderboard>({
    queryKey: ["leaderboard", "dashboard"],
    queryFn: () => apiJson<Leaderboard>("/api/v1/leaderboard"),
    refetchInterval: 15_000,
  });
  if (contest.isPending) return <Loading />;
  if (!contest.data) return <ErrorAlert message={contest.error?.message} />;
  const status = contestStatus(contest.data);
  return (
    <div className="space-y-8">
      <section className="relative overflow-hidden rounded-3xl border border-primary/20 bg-gradient-to-br from-primary/15 via-base-200 to-secondary/10 px-6 py-10 shadow-2xl md:px-12 md:py-16">
        <div className="relative z-10 max-w-3xl">
          <div className={`badge ${status.tone} mb-5 gap-2 p-3`}>
            <Activity size={14} />
            {status.label}
          </div>
          <h1 className="text-4xl font-black tracking-tight md:text-6xl">
            10億行を、<span className="text-primary">最速</span>で集計せよ。
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-base-content/70">
            traQメッセージを模した巨大CSVを処理し、チャンネル・月単位の統計を出力する最適化コンテストです。
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link className="btn btn-primary gap-2" to="/submit">
              <Send size={18} />
              最終計測を提出
            </Link>
            <Link className="btn btn-ghost gap-2" to="/contest">
              <BookOpen size={18} />
              ルールを読む
            </Link>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Stat
          icon={<Clock3 />}
          title={status.timeLabel}
          value={<Countdown target={status.target} />}
        />
        <Stat
          icon={<ListChecks />}
          title="計測待ち"
          value={`${contest.data.queueActive} 件`}
        />
        <Stat
          icon={<Server />}
          title="計測機"
          value={contest.data.environment.instanceType}
        />
        <Stat
          icon={<Gauge />}
          title="計測方式"
          value={`${contest.data.environment.repetitions}回の中央値`}
        />
      </section>

      <section className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <div className="panel overflow-hidden">
          <div className="flex items-center justify-between border-b border-base-300 px-6 py-5">
            <div>
              <h2 className="text-xl font-bold">Public leaderboard</h2>
              <p className="text-sm text-base-content/55">
                各ユーザーの直近Accepted提出
              </p>
            </div>
            <Link className="btn btn-ghost btn-sm" to="/leaderboard">
              すべて見る
            </Link>
          </div>
          <LeaderboardTable
            entries={leaderboard.data?.ranked.slice(0, 8) ?? []}
            compact
          />
        </div>
        <div className="panel p-6">
          <h2 className="flex items-center gap-2 text-xl font-bold">
            <ShieldCheck className="text-success" />
            Public / Private
          </h2>
          <div className="mt-5 space-y-5">
            <Step
              number="1"
              title="Public計測"
              text="公開1Bデータで3回計測し、結果をすぐ表示します。"
            />
            <Step
              number="2"
              title="Private計測"
              text="同じ提出を非公開データで計測し、結果を封印します。"
            />
            <Step
              number="3"
              title="最終公開"
              text="締切前に開始されたuploadを処理後、順位と代表sourceを公開します。"
            />
          </div>
        </div>
      </section>
    </div>
  );
}

function ContestPage() {
  const contest = useContest();
  const datasets = useQuery<{ datasets: DatasetArtifact[] }>({
    queryKey: ["datasets"],
    queryFn: () => apiJson("/api/v1/datasets"),
  });
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="REGULATION"
        title="コンテスト詳細"
        description="提出前に、入出力・計測条件・利用可能な機能を確認してください。"
      />
      <Section title="課題" icon={<Database />}>
        <p>
          traQメッセージを模したCSVを読み込み、チャンネルパスと月ごとにメッセージ長・件数・スタンプ数を集計します。
        </p>
        <Code>{`unix_timestamp,channel_path,message_length,stamp_count
1798761600,team/dev/api,120,3

出力:
team/dev/api,2027-01=120/120.00/120/1/3`}</Code>
        <p>
          プログラムの第1引数に入力CSV、第2引数に出力ファイルを渡します。stdoutは採点対象外です。
        </p>
      </Section>
      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="採点" icon={<Gauge />}>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              public/privateそれぞれ新しいprocessで3回実行し、全成功時の中央値を使用。
            </li>
            <li>
              出力の行順、LF/CRLF、空行は無視。キーと値はexpectedへ完全一致。
            </li>
            <li>直近public Acceptedが代表。自己ベストではありません。</li>
            <li>
              privateのWrong Answer / Runtime Error / Timeout / Output
              Limit等は最終失格で、以前の提出へ戻りません。
            </li>
          </ul>
        </Section>
        <Section title="締切" icon={<Clock3 />}>
          <p>
            締切時刻までにuploadを開始できた提出が対象です。upload完了が締切後でも、15分以内に完了すればqueueへ追加されます。
          </p>
          <p className="mt-3">
            同じユーザーがuploading / queued /
            runningを同時に複数持つことはできません。
          </p>
          <div className="mt-4 rounded-xl bg-base-300 p-4 mono-number">
            締切: {contest.data ? formatDate(contest.data.endAt) : "—"}
          </div>
        </Section>
      </div>
      <Section title="利用可能なもの / 禁止事項" icon={<ShieldCheck />}>
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <h3 className="font-bold text-success">利用可能</h3>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>標準library</li>
              <li>thread / process、SIMD、mmap</li>
              <li>割り当てられたtmpfs</li>
              <li>runner imageに明記されたUbuntu共有library</li>
            </ul>
          </div>
          <div>
            <h3 className="font-bold text-error">禁止</h3>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>外部package・vendored code</li>
              <li>expected埋め込み・dataset固有hardcode</li>
              <li>network・sandbox回避・host妨害</li>
              <li>複数アカウントによる参加</li>
            </ul>
          </div>
        </div>
      </Section>
      <Section title="提出ファイル" icon={<Send />}>
        <p>
          実装全体をUTF-8・NULなし・最大1MiBの単一source
          fileとして提出してください。Nativeはsourceに加え、Ubuntu 26.04
          x86_64で動く最大64MiBのELF
          binaryが必要です。sourceは監査・公開用で、計測にはbinaryだけを使います。
        </p>
        <Code>{`C: .c        C++: .cc / .cpp / .cxx
Go: .go      Rust: .rs      Zig: .zig      C#: .cs
JavaScript: .js      TypeScript: .ts      Ruby: .rb`}</Code>
        <p>
          JavaScript / TypeScriptはNode.js
          24.18.0、Rubyは4.0.5に固定し、いずれも標準libraryだけを利用できます。
        </p>
      </Section>
      <Section title="実行環境" icon={<Server />}>
        {contest.data && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Info label="OS" value={contest.data.environment.os} />
            <Info label="EC2" value={contest.data.environment.instanceType} />
            <Info label="CPU" value={contest.data.environment.cpu} />
            <Info label="Memory" value={contest.data.environment.memory} />
            <Info label="Kernel" value={contest.data.environment.kernel} />
            <Info label="Docker" value={contest.data.environment.docker} />
            <Info label="Node.js" value={contest.data.environment.node} />
            <Info label="Ruby" value={contest.data.environment.ruby} />
            <Info
              label="Timeout"
              value={`${contest.data.environment.timeoutSeconds} 秒`}
            />
            <Info
              label="PID limit"
              value={String(contest.data.environment.pidLimit)}
            />
          </div>
        )}
        <p className="mt-4 break-all text-sm text-base-content/60">
          Runner: {contest.data?.environment.runnerImage ?? "—"}
        </p>
        <p className="mt-3 text-sm text-base-content/60">
          利用可能な共有library:{" "}
          {contest.data?.environment.sharedLibraries.join(", ") ?? "—"}
        </p>
        <Code>{`docker build -t onebrc-runner -f apps/runner/image/Dockerfile .
docker run --rm --network none --read-only onebrc-runner /opt/node/bin/node --version`}</Code>
        <p className="text-sm text-base-content/60">
          参加者向けrunner Dockerfileはリポジトリで公開し、本番で使うimage
          digestを上記Runner欄へ表示します。
        </p>
      </Section>
      <Section title="公開データ" icon={<Download />}>
        <DatasetList datasets={datasets.data?.datasets ?? []} />
      </Section>
      <Section title="Source公開" icon={<BookOpen />}>
        <p>
          全言語で実装全体を単一source fileとして提出します。private
          leaderboard公開後、最終代表sourceはAccepted・失格を問わず公開されます。非代表sourceだけが削除されます。
        </p>
      </Section>
    </div>
  );
}

function LeaderboardPage() {
  const contest = useContest();
  const [board, setBoard] = useState<"public" | "private">("public");
  const [language, setLanguage] = useState("");
  useEffect(() => {
    if (contest.data?.privatePublishedAt) setBoard("private");
  }, [contest.data?.privatePublishedAt]);
  const leaderboard = useQuery<Leaderboard>({
    queryKey: ["leaderboard", board, language],
    queryFn: () =>
      apiJson(
        `/api/v1/leaderboard?board=${board}${language ? `&language=${language}` : ""}`,
      ),
    refetchInterval: 15_000,
  });
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="RANKING"
        title="リーダーボード"
        description="速い順ではなく、各ユーザーの直近Accepted提出を表示します。"
      />
      <div className="flex flex-wrap items-center gap-3">
        <div className="tabs tabs-box">
          <button
            className={`tab ${board === "public" ? "tab-active" : ""}`}
            onClick={() => setBoard("public")}
          >
            Public
          </button>
          <button
            className={`tab ${board === "private" ? "tab-active" : ""}`}
            disabled={!contest.data?.privatePublishedAt}
            onClick={() => setBoard("private")}
          >
            Private
          </button>
        </div>
        <select
          className="select select-bordered"
          value={language}
          onChange={(event) => setLanguage(event.target.value)}
        >
          <option value="">すべての言語</option>
          {[
            "c",
            "cpp",
            "go",
            "rust",
            "zig",
            "csharp",
            "javascript",
            "typescript",
            "ruby",
          ].map((value) => (
            <option key={value} value={value}>
              {languageLabel(value)}
            </option>
          ))}
        </select>
      </div>
      <div className="panel overflow-hidden">
        <LeaderboardTable entries={leaderboard.data?.ranked ?? []} />
      </div>
      {board === "private" &&
        (leaderboard.data?.disqualified.length ?? 0) > 0 && (
          <div className="panel overflow-hidden border-error/30">
            <div className="border-b border-base-300 px-6 py-5">
              <h2 className="text-xl font-bold text-error">失格</h2>
              <p className="text-sm text-base-content/55">
                Privateで正解しなかった代表提出
              </p>
            </div>
            <LeaderboardTable entries={leaderboard.data!.disqualified} />
          </div>
        )}
    </div>
  );
}

function SubmitPage() {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState("typescript");
  const [language, setLanguage] = useState("cpp");
  const [source, setSource] = useState<File | null>(null);
  const [binary, setBinary] = useState<File | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!source) throw new Error("sourceを選択してください");
      const form = new FormData();
      form.set("executionKind", kind);
      if (kind === "native") form.set("language", language);
      form.set("source", source);
      if (kind === "native") {
        if (!binary) throw new Error("Native binaryを選択してください");
        form.set("binary", binary);
      }
      return apiJson<{ id: string }>("/api/v1/submissions", {
        method: "POST",
        body: form,
      });
    },
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["submissions"] }),
  });
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="SUBMIT"
        title="最終計測を提出"
        description="upload開始が締切前なら、完了が締切後でもqueueへ追加されます。"
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_.8fr]">
        <form
          className="panel space-y-6 p-6"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <label className="form-control">
            <span className="label-text mb-2 font-semibold">実行形式</span>
            <select
              className="select select-bordered"
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              <option value="typescript">TypeScript</option>
              <option value="javascript">JavaScript</option>
              <option value="ruby">Ruby</option>
              <option value="native">Native binary</option>
            </select>
          </label>
          {kind === "native" && (
            <label className="form-control">
              <span className="label-text mb-2 font-semibold">実装言語</span>
              <select
                className="select select-bordered"
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
              >
                {["c", "cpp", "go", "rust", "zig", "csharp"].map((value) => (
                  <option key={value} value={value}>
                    {languageLabel(value)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="form-control">
            <span className="label-text mb-2 font-semibold">
              Source file{" "}
              <span className="font-normal text-base-content/50">
                最大1MiB / UTF-8
              </span>
            </span>
            <input
              className="file-input file-input-bordered w-full"
              type="file"
              required
              onChange={(event) => setSource(event.target.files?.[0] ?? null)}
            />
          </label>
          {kind === "native" && (
            <label className="form-control">
              <span className="label-text mb-2 font-semibold">
                Ubuntu 26.04 x86_64 ELF{" "}
                <span className="font-normal text-base-content/50">
                  最大64MiB
                </span>
              </span>
              <input
                className="file-input file-input-bordered w-full"
                type="file"
                required
                onChange={(event) => setBinary(event.target.files?.[0] ?? null)}
              />
            </label>
          )}
          <label className="label cursor-pointer justify-start gap-3">
            <input
              type="checkbox"
              className="checkbox checkbox-primary"
              required
            />
            <span className="label-text">
              外部libraryを含まず、代表sourceが公開されることに同意します。
            </span>
          </label>
          {mutation.error && <ErrorAlert message={mutation.error.message} />}
          {mutation.data && (
            <div className="alert alert-success">
              <span>
                提出しました: <code>{mutation.data.id}</code>
              </span>
            </div>
          )}
          <button
            className="btn btn-primary w-full gap-2"
            disabled={mutation.isPending}
          >
            {mutation.isPending ? (
              <span className="loading loading-spinner" />
            ) : (
              <Send size={18} />
            )}
            提出する
          </button>
        </form>
        <CurlGuide />
      </div>
    </div>
  );
}

function SubmissionsPage() {
  const submissions = useQuery<{ submissions: Submission[] }>({
    queryKey: ["submissions"],
    queryFn: () => apiJson("/api/v1/submissions"),
    refetchInterval: (query) =>
      query.state.data?.submissions.some((item) =>
        ["uploading", "queued", "running"].includes(item.status),
      )
        ? 2_000
        : false,
  });
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="HISTORY"
        title="提出履歴"
        description="Private結果は最終公開までレスポンス自体から除外されます。"
      />
      <div className="panel overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>提出</th>
              <th>言語</th>
              <th>Status</th>
              <th>Public</th>
              <th>Private</th>
              <th>時刻</th>
            </tr>
          </thead>
          <tbody>
            {submissions.data?.submissions.map((item) => (
              <tr key={item.id}>
                <td>
                  <div className="font-mono text-xs">{item.id.slice(0, 8)}</div>
                  <div className="text-xs text-base-content/50">
                    {item.sourceFilename}
                  </div>
                </td>
                <td>{item.language ? languageLabel(item.language) : "—"}</td>
                <td>
                  <StatusBadge value={item.status} />
                </td>
                <td>
                  {item.public ? (
                    <>
                      <VerdictBadge verdict={item.public.verdict} />
                      <div className="mt-1 text-xs mono-number">
                        {formatDuration(item.public.scoreNs)}
                      </div>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  {item.private === undefined ? (
                    <span className="badge badge-ghost">sealed</span>
                  ) : item.private ? (
                    <VerdictBadge verdict={item.private.verdict} />
                  ) : (
                    "—"
                  )}
                </td>
                <td className="text-xs">{formatDate(item.uploadStartedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {submissions.data?.submissions.length === 0 && (
          <Empty text="まだ提出がありません" />
        )}
      </div>
    </div>
  );
}

function AccessKeyPage() {
  const [key, setKey] = useState<string | null>(null);
  const issue = useMutation({
    mutationFn: () =>
      apiJson<{ accessKey: string }>("/api/v1/access-key", { method: "POST" }),
    onSuccess: (data) => setKey(data.accessKey),
  });
  const revoke = useMutation({
    mutationFn: () =>
      fetch("/api/v1/access-key", { method: "DELETE" }).then((response) => {
        if (!response.ok) throw new Error("失効できませんでした");
      }),
    onSuccess: () => setKey(null),
  });
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="API"
        title="アクセスキー"
        description="curlからの提出と、自分の提出状態取得にだけ利用できます。"
      />
      <div className="panel mx-auto max-w-3xl p-6 md:p-8">
        <div className="alert alert-warning">
          <ShieldCheck size={20} />
          <span>
            再発行すると以前のキーは即時失効します。新しいキーはこの画面で一度だけ表示されます。
          </span>
        </div>
        {key ? (
          <div className="mt-6">
            <div className="join flex">
              <input
                className="input input-bordered join-item w-full font-mono"
                readOnly
                value={key}
              />
              <button
                className="btn join-item"
                onClick={() => void navigator.clipboard.writeText(key)}
              >
                <Copy size={17} />
              </button>
            </div>
          </div>
        ) : (
          <p className="mt-6 text-base-content/65">
            現在のキーは安全のため表示できません。初回発行または再発行してください。
          </p>
        )}
        <div className="mt-6 flex flex-wrap gap-3">
          <button
            className="btn btn-primary"
            onClick={() => issue.mutate()}
            disabled={issue.isPending}
          >
            <KeyRound size={18} />
            発行 / 再発行
          </button>
          <button
            className="btn btn-error btn-outline"
            onClick={() => revoke.mutate()}
            disabled={revoke.isPending}
          >
            失効
          </button>
        </div>
        {(issue.error || revoke.error) && (
          <div className="mt-4">
            <ErrorAlert message={(issue.error ?? revoke.error)?.message} />
          </div>
        )}
      </div>
      <CurlGuide />
    </div>
  );
}

function AdminPage() {
  const queryClient = useQueryClient();
  const [manifest, setManifest] = useState<File | null>(null);
  const submissions = useQuery<{ submissions: Submission[] }>({
    queryKey: ["admin-submissions"],
    queryFn: () => apiJson("/api/v1/admin/submissions"),
    refetchInterval: 5_000,
  });
  const publish = useMutation({
    mutationFn: () =>
      apiJson("/api/v1/admin/private/publish", { method: "POST" }),
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  const importManifest = useMutation({
    mutationFn: async () => {
      if (!manifest) throw new Error("manifestを選択してください");
      return apiJson("/api/v1/admin/datasets/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await manifest.text(),
      });
    },
  });
  const retry = useMutation({
    mutationFn: (id: string) =>
      apiJson(`/api/v1/admin/submissions/${id}/retry`, { method: "POST" }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["admin-submissions"] }),
  });
  const disqualify = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiJson(`/api/v1/admin/submissions/${id}/disqualify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["admin-submissions"] }),
  });
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="ADMIN"
        title="運営管理"
        description="Private値は公開操作まで管理画面にも表示されません。"
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="panel p-6">
          <h2 className="text-xl font-bold">Dataset manifest</h2>
          <p className="mt-2 text-sm text-base-content/55">
            Go CLIが生成したmanifestを取り込み、public object
            allowlistを更新します。
          </p>
          <input
            className="file-input file-input-bordered mt-5 w-full"
            type="file"
            accept="application/json"
            onChange={(event) => setManifest(event.target.files?.[0] ?? null)}
          />
          <button
            className="btn btn-primary mt-4"
            onClick={() => importManifest.mutate()}
            disabled={importManifest.isPending}
          >
            Import
          </button>
          {importManifest.error && (
            <div className="mt-3">
              <ErrorAlert message={importManifest.error.message} />
            </div>
          )}
        </div>
        <div className="panel p-6">
          <h2 className="text-xl font-bold">Private leaderboard</h2>
          <p className="mt-2 text-sm text-base-content/55">
            uploading / queued / running / infrastructure
            errorが残っている間は公開できません。
          </p>
          <button
            className="btn btn-error mt-5"
            onClick={() => publish.mutate()}
            disabled={publish.isPending}
          >
            最終結果を公開
          </button>
          {publish.error && (
            <div className="mt-3">
              <ErrorAlert message={publish.error.message} />
            </div>
          )}
        </div>
      </div>
      {(retry.error || disqualify.error) && (
        <ErrorAlert message={(retry.error ?? disqualify.error)?.message} />
      )}
      <div className="panel overflow-x-auto">
        <table className="table table-sm">
          <thead>
            <tr>
              <th>ID</th>
              <th>User</th>
              <th>Status</th>
              <th>Language</th>
              <th>Public</th>
              <th>Started</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {submissions.data?.submissions.map((item) => (
              <tr key={item.id}>
                <td className="font-mono">{item.id.slice(0, 8)}</td>
                <td>{item.username}</td>
                <td>
                  <StatusBadge value={item.status} />
                </td>
                <td>{item.language}</td>
                <td>{item.public?.verdict ?? "—"}</td>
                <td>{formatDate(item.uploadStartedAt)}</td>
                <td>
                  <div className="flex gap-2">
                    {item.status === "infrastructure_error" && (
                      <button
                        className="btn btn-xs btn-warning"
                        onClick={() => retry.mutate(item.id)}
                      >
                        再試行
                      </button>
                    )}
                    <button
                      className="btn btn-xs btn-error btn-outline"
                      disabled={[
                        "uploading",
                        "running",
                        "disqualified",
                      ].includes(item.status)}
                      onClick={() => {
                        const reason = window.prompt("失格理由");
                        if (reason?.trim())
                          disqualify.mutate({
                            id: item.id,
                            reason: reason.trim(),
                          });
                      }}
                    >
                      失格
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LeaderboardTable({
  entries,
  compact = false,
}: {
  entries: LeaderboardEntry[];
  compact?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className={`table ${compact ? "table-sm" : ""}`}>
        <thead>
          <tr>
            <th>Rank</th>
            <th>User</th>
            <th>Language</th>
            <th>Score</th>
            <th>Submitted</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr
              key={entry.submissionId}
              className={entry.rank && entry.rank <= 3 ? "bg-primary/5" : ""}
            >
              <td className="text-lg font-black">
                {entry.rank ? `#${entry.rank}` : "—"}
              </td>
              <td className="font-semibold">{entry.username}</td>
              <td>
                <span className="badge badge-outline">
                  {languageLabel(entry.language)}
                </span>
              </td>
              <td className="mono-number font-mono font-bold">
                {entry.verdict === "accepted" ? (
                  formatDuration(entry.scoreNs)
                ) : (
                  <VerdictBadge verdict={entry.verdict} />
                )}
              </td>
              <td className="text-xs text-base-content/55">
                {formatDate(entry.submittedAt)}
              </td>
              <td>
                {entry.sourceAvailable && (
                  <a
                    className="btn btn-ghost btn-xs"
                    href={`/api/v1/submissions/${entry.submissionId}/source`}
                  >
                    <Download size={14} />
                    source
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {entries.length === 0 && <Empty text="表示できる記録がありません" />}
    </div>
  );
}

type DatasetArtifact = {
  id: string;
  kind: string;
  label: string;
  rows: string;
  compressedBytes: string;
  compressedSha256: string;
  downloadUrl: string;
};
function DatasetList({ datasets }: { datasets: DatasetArtifact[] }) {
  if (datasets.length === 0)
    return <Empty text="データはまだ公開されていません" />;
  return (
    <div className="grid gap-3">
      {datasets.map((item) => (
        <div
          key={item.id}
          className="flex flex-col gap-3 rounded-xl bg-base-300/60 p-4 md:flex-row md:items-center"
        >
          <div className="grow">
            <div className="flex items-center gap-2">
              <span className="badge badge-primary badge-sm">{item.kind}</span>
              <span className="font-semibold">{item.label}</span>
            </div>
            <div className="mt-1 text-xs text-base-content/50">
              {Number(item.rows).toLocaleString()} rows ·{" "}
              {formatBytes(item.compressedBytes)} · SHA-256{" "}
              {item.compressedSha256.slice(0, 16)}…
            </div>
          </div>
          <a className="btn btn-sm gap-2" href={item.downloadUrl}>
            <Download size={16} />
            R2から取得
          </a>
        </div>
      ))}
    </div>
  );
}
function CurlGuide() {
  const source = `export ONEBRC_ACCESS_KEY='1brc_...'

curl --fail-with-body \\
  -H "Authorization: Bearer \${ONEBRC_ACCESS_KEY}" \\
  -F executionKind=typescript \\
  -F source=@main.ts \\
  https://example.com/api/v1/submissions

# Native C++
curl --fail-with-body \\
  -H "Authorization: Bearer \${ONEBRC_ACCESS_KEY}" \\
  -F executionKind=native -F language=cpp \\
  -F binary=@main -F source=@main.cpp \\
  https://example.com/api/v1/submissions`;
  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-base-300 px-5 py-4">
        <h2 className="flex items-center gap-2 font-bold">
          <Terminal size={18} />
          curlで提出
        </h2>
        <button
          className="btn btn-ghost btn-xs"
          onClick={() => void navigator.clipboard.writeText(source)}
        >
          <Copy size={14} />
          copy
        </button>
      </div>
      <pre className="overflow-x-auto p-5 text-xs leading-relaxed text-base-content/75">
        <code>{source}</code>
      </pre>
    </div>
  );
}

function PageHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <header>
      <p className="text-sm font-bold tracking-[.22em] text-primary">
        {eyebrow}
      </p>
      <h1 className="page-title mt-2">{title}</h1>
      <p className="mt-3 max-w-3xl text-base-content/60">{description}</p>
    </header>
  );
}
function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel p-6 md:p-8">
      <h2 className="mb-5 flex items-center gap-3 text-2xl font-bold">
        <span className="text-primary">{icon}</span>
        {title}
      </h2>
      <div className="leading-relaxed text-base-content/75">{children}</div>
    </section>
  );
}
function Stat({
  icon,
  title,
  value,
}: {
  icon: ReactNode;
  title: string;
  value: ReactNode;
}) {
  return (
    <div className="panel p-5">
      <div className="flex items-center gap-2 text-sm text-base-content/50">
        <span className="text-primary">{icon}</span>
        {title}
      </div>
      <div className="mt-3 text-2xl font-black mono-number">{value}</div>
    </div>
  );
}
function Step({
  number,
  title,
  text,
}: {
  number: string;
  title: string;
  text: string;
}) {
  return (
    <div className="flex gap-4">
      <div className="grid size-8 shrink-0 place-items-center rounded-full bg-primary font-bold text-primary-content">
        {number}
      </div>
      <div>
        <h3 className="font-bold">{title}</h3>
        <p className="mt-1 text-sm text-base-content/55">{text}</p>
      </div>
    </div>
  );
}
function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-base-300/60 p-4">
      <div className="text-xs uppercase tracking-wider text-base-content/45">
        {label}
      </div>
      <div className="mt-1 font-semibold">{value}</div>
    </div>
  );
}
function Code({ children }: { children: string }) {
  return (
    <pre className="my-5 overflow-x-auto rounded-xl bg-neutral p-5 text-sm text-neutral-content">
      <code>{children}</code>
    </pre>
  );
}
function Loading() {
  return (
    <div className="grid min-h-80 place-items-center">
      <span className="loading loading-spinner loading-lg text-primary" />
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return (
    <div className="p-10 text-center text-sm text-base-content/45">{text}</div>
  );
}
function ErrorAlert({
  message = "エラーが発生しました",
}: {
  message?: string | undefined;
}) {
  return (
    <div className="alert alert-error">
      <span>{message}</span>
    </div>
  );
}
function StatusBadge({ value }: { value: string }) {
  const tone =
    value === "completed"
      ? "badge-success"
      : value === "running"
        ? "badge-info"
        : value === "queued" || value === "uploading"
          ? "badge-warning"
          : value.includes("error") ||
              value === "rejected" ||
              value === "disqualified"
            ? "badge-error"
            : "badge-ghost";
  return <span className={`badge ${tone}`}>{value}</span>;
}
function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const tone =
    verdict === "accepted"
      ? "badge-success"
      : verdict === "infrastructure_error"
        ? "badge-warning"
        : "badge-error";
  return <span className={`badge ${tone}`}>{verdict}</span>;
}

function Countdown({ target }: { target: Date }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((target.getTime() - now) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return (
    <span>
      {days > 0 && `${days}日 `}
      {String(hours).padStart(2, "0")}:{String(minutes).padStart(2, "0")}:
      {String(rest).padStart(2, "0")}
    </span>
  );
}

function contestStatus(contest: Contest) {
  const now = new Date();
  const start = new Date(contest.startAt);
  const end = new Date(contest.endAt);
  if (contest.privatePublishedAt)
    return {
      label: "最終結果公開済み",
      tone: "badge-success",
      timeLabel: "終了",
      target: now,
    };
  if (now < start)
    return {
      label: "開催前",
      tone: "badge-info",
      timeLabel: "開始まで",
      target: start,
    };
  if (now <= end)
    return {
      label: "開催中",
      tone: "badge-success",
      timeLabel: "締切まで",
      target: end,
    };
  return {
    label: "計測処理中",
    tone: "badge-warning",
    timeLabel: "締切済み",
    target: now,
  };
}

function languageLabel(value: string) {
  return (
    (
      {
        c: "C",
        cpp: "C++",
        go: "Go",
        rust: "Rust",
        zig: "Zig",
        csharp: "C#",
        javascript: "JavaScript",
        typescript: "TypeScript",
        ruby: "Ruby",
      } as Record<string, string>
    )[value] ?? value
  );
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Tokyo",
  }).format(new Date(value));
}
