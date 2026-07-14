import type { Language, LeaderboardBoard } from "@1brc/domain";

import { rpc, rpcResult } from "./api-client.js";

const getContest = () => rpcResult(rpc.contest.$get());
const getLeaderboard = (board: LeaderboardBoard, language?: Language) =>
  rpcResult(
    rpc.leaderboard.$get({
      query: language ? { board, language } : { board },
    }),
  );

export type ContestOverview = Awaited<ReturnType<typeof getContest>>;
type Leaderboard = Awaited<ReturnType<typeof getLeaderboard>>;
export type ContestLiveUpdate = {
  contest: Pick<
    ContestOverview,
    "privatePublishedAt" | "participants" | "totalSubmissions"
  >;
  leaderboard: Leaderboard;
};

export const contestQueryKeys = {
  overview: ["contest"] as const,
  leaderboard: (board: LeaderboardBoard, language = "all") =>
    ["leaderboard", board, language] as const,
};

export const contestGateway = {
  contest: getContest,
  datasets: () => rpcResult(rpc.datasets.$get()),
  leaderboard: getLeaderboard,
  subscribe(
    board: LeaderboardBoard,
    language: Language | undefined,
    onUpdate: (data: ContestLiveUpdate) => void,
  ) {
    const source = new EventSource(
      rpc.contest.events.$url({
        query: language ? { board, language } : { board },
      }),
    );
    source.addEventListener("contest", (event) => {
      onUpdate(JSON.parse(event.data) as ContestLiveUpdate);
    });
    return () => source.close();
  },
};
