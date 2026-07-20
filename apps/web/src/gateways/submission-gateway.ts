import type { components } from "@1brc/api";

import type { SubmissionDraft } from "../models/submission.js";
import { apiClient, apiResult, apiUrl } from "./api-client.js";

const listSubmissions = () => apiResult(apiClient.GET("/api/v1/submissions"));
export type SubmissionList = Awaited<ReturnType<typeof listSubmissions>>;
export type SubmissionItem = SubmissionList["submissions"][number];

export const submissionGateway = {
  list: listSubmissions,
  subscribe(onUpdate: (data: SubmissionList) => void) {
    const source = new EventSource(apiUrl("/api/v1/submissions/events"));
    source.addEventListener("submissions", (event) => {
      onUpdate(JSON.parse(event.data) as SubmissionList);
    });
    return () => source.close();
  },
  async source(id: string) {
    return apiResult(
      apiClient.GET("/api/v1/submissions/{id}/source", {
        params: { path: { id } },
        parseAs: "text",
      }),
    );
  },
  submit: (draft: SubmissionDraft) => {
    if (!draft.source) throw new Error("ソースコードを選択してください");
    if (draft.executionKind === "native" && !draft.binary) {
      throw new Error("実行ファイルを選択してください");
    }
    const body: components["schemas"]["SubmissionUpload"] = {
      executionKind: draft.executionKind,
      ...(draft.executionKind === "native" ? { language: draft.language } : {}),
      source: draft.source as unknown as string,
      ...(draft.executionKind === "native" && draft.binary
        ? { binary: draft.binary as unknown as string }
        : {}),
    };
    return apiResult(
      apiClient.POST("/api/v1/submissions", {
        body,
        bodySerializer: (value) => {
          const form = new FormData();
          form.set("executionKind", value.executionKind);
          if (value.language) form.set("language", value.language);
          form.set("source", value.source);
          if (value.binary) form.set("binary", value.binary);
          return form;
        },
      }),
    );
  },
};
