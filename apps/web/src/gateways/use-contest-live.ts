import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  contestGateway,
  contestQueryKeys,
  type ContestOverview,
} from "./contest-gateway.js";

export function useContestLive(board: "public" | "private", language = "all") {
  const queryClient = useQueryClient();

  useEffect(
    () =>
      contestGateway.subscribe(
        board,
        language === "all" ? undefined : language,
        (update) => {
          queryClient.setQueryData<ContestOverview>(
            contestQueryKeys.overview,
            (current) =>
              current ? { ...current, ...update.contest } : current,
          );
          queryClient.setQueryData(
            contestQueryKeys.leaderboard(board, language),
            update.leaderboard,
          );
        },
      ),
    [board, language, queryClient],
  );
}
