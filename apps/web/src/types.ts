import type { Language, Verdict } from "@1brc/contracts";

export type Contest = {
  id: string;
  name: string;
  startAt: string;
  endAt: string;
  privatePublishedAt: string | null;
  queueActive: number;
  environment: {
    id: string;
    instanceType: string;
    cpu: string;
    memory: string;
    os: string;
    kernel: string;
    docker: string;
    runnerImage: string;
    node: string;
    ruby: string;
    sharedLibraries: string[];
    repetitions: number;
    timeoutSeconds: number;
    pidLimit: number;
    outputLimitBytes: number;
  };
};

export type Me = {
  user: { username: string; isAdmin: boolean; method: string } | null;
};

export type LeaderboardEntry = {
  rank: number | null;
  username: string;
  submissionId: string;
  language: Language;
  scoreNs: string | null;
  verdict: Verdict;
  submittedAt: string;
  sourceAvailable: boolean;
};

export type Leaderboard = {
  board: "public" | "private";
  privatePublished: boolean;
  ranked: LeaderboardEntry[];
  disqualified: LeaderboardEntry[];
};

export type Submission = {
  id: string;
  username: string;
  executionKind: string | null;
  language: Language | null;
  sourceFilename: string | null;
  artifactSha256: string | null;
  status: string;
  public: {
    verdict: Verdict;
    scoreNs: string | null;
    error: string | null;
  } | null;
  private?: { verdict: Verdict; scoreNs: string | null } | null;
  infrastructureError: string | null;
  disqualifiedReason: string | null;
  uploadStartedAt: string;
  queuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
};
