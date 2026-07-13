import type { SubmissionDraft } from "../models/submission.js";
import { rpc, rpcResult } from "./api-client.js";

const listSubmissions = () => rpcResult(rpc.submissions.$get());
export type SubmissionList = Awaited<ReturnType<typeof listSubmissions>>;
export type SubmissionItem = SubmissionList["submissions"][number];

export const submissionGateway = {
  list: listSubmissions,
  subscribe(onUpdate: (data: SubmissionList) => void) {
    const source = new EventSource(rpc.submissions.events.$url());
    source.addEventListener("submissions", (event) => {
      onUpdate(JSON.parse(event.data) as SubmissionList);
    });
    return () => source.close();
  },
  async source(id: string) {
    const response = await rpc.submissions[":id"].source.$get({
      param: { id },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(
        body?.error?.message ?? "ソースコードを取得できませんでした",
      );
    }
    return response.text();
  },
  submit: (draft: SubmissionDraft) => {
    if (!draft.source) throw new Error("ソースコードを選択してください");
    if (draft.executionKind === "native" && !draft.binary) {
      throw new Error("実行ファイルを選択してください");
    }
    const form = new FormData();
    form.set("executionKind", draft.executionKind);
    if (draft.executionKind === "native") form.set("language", draft.language);
    form.set("source", draft.source);
    if (draft.executionKind === "native" && draft.binary) {
      form.set("binary", draft.binary);
    }
    return rpcResult(
      rpc.submissions.$post(undefined, { init: { body: form } }),
    );
  },
};
