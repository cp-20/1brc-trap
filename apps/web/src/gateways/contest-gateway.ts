import { rpc, rpcResult } from "./api-client.js";

const getContest = () => rpcResult(rpc.contest.$get());
const getLeaderboard = (board: "public" | "private", language?: string) =>
  rpcResult(
    rpc.leaderboard.$get({
      query: language ? { board, language } : { board },
    }),
  );

export type ContestOverview = Awaited<ReturnType<typeof getContest>>;
export type Leaderboard = Awaited<ReturnType<typeof getLeaderboard>>;
export type ContestLiveUpdate = {
  contest: Pick<
    ContestOverview,
    "privatePublishedAt" | "participants" | "totalSubmissions"
  >;
  leaderboard: Leaderboard;
};

export const contestQueryKeys = {
  overview: ["contest"] as const,
  leaderboard: (board: "public" | "private", language = "all") =>
    ["leaderboard", board, language] as const,
};

export const contestGateway = {
  contest: getContest,
  datasets: () => rpcResult(rpc.datasets.$get()),
  leaderboard: getLeaderboard,
  subscribe(
    board: "public" | "private",
    language: string | undefined,
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
