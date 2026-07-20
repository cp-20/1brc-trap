import type { operations } from "@1brc/api";
import type { Language, LeaderboardBoard } from "@1brc/domain";

import { apiClient, apiResult, apiUrl } from "./api-client.js";

const getContest = () => apiResult(apiClient.GET("/api/v1/contest"));
const getLeaderboard = (board: LeaderboardBoard, language?: Language) =>
  apiResult(
    apiClient.GET("/api/v1/leaderboard", {
      params: { query: { board, ...(language ? { language } : {}) } },
    }),
  );
const getLeaderboardReplay = () =>
  apiResult(apiClient.GET("/api/v1/leaderboard/replay"));

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
  leaderboardReplay: ["leaderboard-replay"] as const,
};

export const contestGateway = {
  contest: getContest,
  datasets: () => apiResult(apiClient.GET("/api/v1/datasets")),
  leaderboard: getLeaderboard,
  leaderboardReplay: getLeaderboardReplay,
  subscribe(
    board: LeaderboardBoard,
    language: Language | undefined,
    onUpdate: (data: ContestLiveUpdate) => void,
  ) {
    const query = {
      board,
      ...(language ? { language } : {}),
    } satisfies operations["streamContest"]["parameters"]["query"];
    const source = new EventSource(apiUrl("/api/v1/contest/events", query));
    source.addEventListener("contest", (event) => {
      onUpdate(JSON.parse(event.data) as ContestLiveUpdate);
    });
    return () => source.close();
  },
};
