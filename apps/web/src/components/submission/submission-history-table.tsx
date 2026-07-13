import { Fragment } from "react";
import { Link } from "react-router-dom";
import type { SubmissionItem } from "../../gateways/submission-gateway.js";
import { languageLabel } from "../../models/labels.js";
import { formatDate } from "../../utils/format.js";
import styles from "../../pages/submissions-page.module.css";
import { AnimatedDuration } from "../animated-number.js";
import { Panel } from "../ui.js";

export function SubmissionHistoryTable({
  submissions,
  submittedId,
  privatePublished,
}: {
  submissions: SubmissionItem[];
  submittedId: string | null;
  privatePublished: boolean;
}) {
  return (
    <Panel className="panel-table">
      <div className="overflow-x-auto">
        <table className={`submission-table ${styles.table}`}>
          <thead>
            <tr>
              <th>提出回数</th>
              <th>実行時間</th>
              <th>提出内容</th>
              <th>提出日時</th>
            </tr>
          </thead>
          <tbody>
            {submissions.map((item) => {
              const error = item.public?.error ?? item.infrastructureError;
              const highlighted = item.id === submittedId;
              return (
                <Fragment key={item.id}>
                  <tr
                    className={`${highlighted ? styles.newSubmission : ""} ${error ? styles.rowWithError : ""}`}
                  >
                    <td className={styles.numberCell}>
                      #{item.submissionNumber ?? "—"}
                    </td>
                    <td className={styles.scoreCell}>
                      <div className={styles.scorePair}>
                        <div className={styles.scorePart}>
                          <small>Public</small>
                          {item.public?.verdict === "accepted" ? (
                            <strong>
                              <AnimatedDuration
                                nanoseconds={item.public.scoreNs}
                              />
                            </strong>
                          ) : item.status === "uploading" ||
                            item.status === "queued" ||
                            item.status === "running" ? (
                            <strong className={styles.measuring}>
                              <i aria-hidden="true" />
                              {item.status === "running" ? "計測中" : "待機中"}
                            </strong>
                          ) : (
                            <strong className={styles.errorScore}>
                              エラー
                            </strong>
                          )}
                        </div>
                        {privatePublished && (
                          <div className={styles.scorePart}>
                            <small>Private</small>
                            {item.private === undefined ? (
                              <strong className={styles.unpublishedScore}>
                                公開前
                              </strong>
                            ) : item.private?.verdict === "accepted" ? (
                              <strong>
                                <AnimatedDuration
                                  nanoseconds={item.private.scoreNs}
                                />
                              </strong>
                            ) : item.private ? (
                              <strong className={styles.errorScore}>
                                エラー
                              </strong>
                            ) : (
                              <strong className={styles.unpublishedScore}>
                                —
                              </strong>
                            )}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className={styles.fileCell}>
                      <strong>
                        {item.language ? languageLabel(item.language) : "—"}
                      </strong>
                      <small>{item.sourceFilename}</small>
                    </td>
                    <td className="muted-cell">
                      {formatDate(item.uploadStartedAt)}
                    </td>
                  </tr>
                  {error && (
                    <tr
                      className={`${styles.errorRow} ${highlighted ? styles.newSubmission : ""}`}
                    >
                      <td colSpan={4}>
                        <details className={styles.errorDetails}>
                          <summary>エラー詳細</summary>
                          <pre>{error}</pre>
                        </details>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {submissions.length === 0 && (
        <div className="empty-state">
          <p>まだ提出がありません。</p>
          <Link className="text-link" to="/submit">
            最初のプログラムを提出する
          </Link>
        </div>
      )}
    </Panel>
  );
}
