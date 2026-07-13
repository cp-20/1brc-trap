import { datasetManifestSchema } from "@1brc/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  ErrorAlert,
  PageHeader,
  Panel,
  StatusBadge,
  SuccessNotice,
} from "../components/ui.js";
import { adminGateway } from "../gateways/admin-gateway.js";
import { contestGateway } from "../gateways/contest-gateway.js";
import { formatDate } from "../utils/format.js";
import styles from "./admin-page.module.css";

export function AdminPage() {
  const queryClient = useQueryClient();
  const [manifest, setManifest] = useState<File | null>(null);
  const submissions = useQuery({
    queryKey: ["admin-submissions"],
    queryFn: adminGateway.submissions,
    refetchInterval: 5_000,
  });
  const contest = useQuery({
    queryKey: ["contest"],
    queryFn: contestGateway.contest,
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin-submissions"] }),
      queryClient.invalidateQueries({ queryKey: ["contest"] }),
      queryClient.invalidateQueries({ queryKey: ["leaderboard"] }),
      queryClient.invalidateQueries({ queryKey: ["submissions"] }),
    ]);
  };
  const publish = useMutation({
    mutationFn: adminGateway.publishPrivate,
    onSuccess: refresh,
  });
  const unpublish = useMutation({
    mutationFn: adminGateway.unpublishPrivate,
    onSuccess: refresh,
  });
  const retry = useMutation({
    mutationFn: adminGateway.retry,
    onSuccess: refresh,
  });
  const disqualify = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      adminGateway.disqualify(id, reason),
    onSuccess: refresh,
  });
  const importManifest = useMutation({
    mutationFn: async () => {
      if (!manifest) throw new Error("マニフェストを選択してください");
      return adminGateway.importDatasets(
        datasetManifestSchema.parse(JSON.parse(await manifest.text())),
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["datasets"] });
    },
  });
  return (
    <div className="page-stack">
      <PageHeader title="運営管理" />
      <div className={styles.grid}>
        <Panel className={styles.card!}>
          <h2>公開データ</h2>
          <p>データセットのマニフェストを取り込みます。</p>
          <input
            className="file-input file-input-bordered w-full"
            type="file"
            accept="application/json"
            onChange={(event) => {
              importManifest.reset();
              setManifest(event.target.files?.[0] ?? null);
            }}
          />
          <button
            className="btn btn-primary"
            onClick={() => importManifest.mutate()}
            disabled={!manifest || importManifest.isPending}
          >
            {importManifest.isPending ? "確認しています…" : "取り込む"}
          </button>
          {importManifest.data && !importManifest.isPending && (
            <SuccessNotice>
              {importManifest.data.imported}件のデータセット情報を取り込みました
            </SuccessNotice>
          )}
          {importManifest.error && (
            <ErrorAlert message={importManifest.error.message} />
          )}
        </Panel>
        <Panel className={styles.card!}>
          <h2>最終結果</h2>
          <p>
            {contest.data?.privatePublishedAt
              ? `Private結果を公開中 · ${formatDate(contest.data.privatePublishedAt)}`
              : "未完了の提出がないことを確認してから公開してください。"}
          </p>
          {contest.data?.privatePublishedAt ? (
            <button
              className="btn btn-outline"
              onClick={() => unpublish.mutate()}
              disabled={unpublish.isPending}
            >
              非公開に戻す
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={() => publish.mutate()}
              disabled={publish.isPending || contest.isPending}
            >
              公開する
            </button>
          )}
          {(publish.error || unpublish.error) && (
            <ErrorAlert message={(publish.error ?? unpublish.error)?.message} />
          )}
        </Panel>
      </div>
      {(retry.error || disqualify.error) && (
        <ErrorAlert message={(retry.error ?? disqualify.error)?.message} />
      )}
      <Panel className="panel-table">
        <div className="overflow-x-auto">
          <table className="submission-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>ユーザー</th>
                <th>状態</th>
                <th>言語</th>
                <th>提出日時</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {submissions.data?.submissions.map((submission) => (
                <tr key={submission.id}>
                  <td>
                    <code>{submission.id.slice(0, 8)}</code>
                  </td>
                  <td>{submission.username}</td>
                  <td>
                    <StatusBadge value={submission.status} />
                  </td>
                  <td>{submission.language}</td>
                  <td>{formatDate(submission.uploadStartedAt)}</td>
                  <td className={styles.actions}>
                    {submission.status === "infrastructure_error" && (
                      <button
                        className="btn btn-xs"
                        onClick={() => retry.mutate(submission.id)}
                      >
                        再試行
                      </button>
                    )}
                    <button
                      className="btn btn-xs btn-outline"
                      disabled={[
                        "uploading",
                        "running",
                        "disqualified",
                      ].includes(submission.status)}
                      onClick={() => {
                        const reason = window.prompt("失格理由");
                        if (reason?.trim())
                          disqualify.mutate({
                            id: submission.id,
                            reason: reason.trim(),
                          });
                      }}
                    >
                      失格
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
