import { useQuery } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { Link } from "react-router-dom";
import { ContestDocument } from "../components/contest/contest-document.js";
import { ErrorAlert, PageHeader } from "../components/ui.js";
import { contestGateway } from "../gateways/contest-gateway.js";
import styles from "./contest-page.module.css";

export function ContestPage() {
  const contest = useQuery({
    queryKey: ["contest"],
    queryFn: contestGateway.contest,
  });
  const datasets = useQuery({
    queryKey: ["datasets"],
    queryFn: contestGateway.datasets,
  });
  return (
    <div className="page-stack">
      <PageHeader
        title="コンテスト"
        action={
          contest.data && (
            <Link
              className={`btn btn-primary btn-sm ${styles.submitButton}`}
              to="/submit"
            >
              <Send size={16} /> 提出する
            </Link>
          )
        }
      />
      {contest.data ? (
        <ContestDocument
          environment={contest.data.environment}
          datasets={datasets.data}
          datasetsError={datasets.isError}
        />
      ) : contest.isError ? (
        <ErrorAlert message={contest.error.message} />
      ) : (
        <ContestSkeleton />
      )}
    </div>
  );
}

function ContestSkeleton() {
  return (
    <div className={styles.document} aria-label="コンテストを読み込み中">
      <aside className={styles.tocSkeleton} aria-hidden>
        {Array.from({ length: 5 }, (_, index) => (
          <span className="skeleton-block" key={index} />
        ))}
      </aside>
      <article className={styles.documentSkeleton} aria-hidden>
        <span className={`skeleton-block ${styles.skeletonNumber}`} />
        <span className={`skeleton-block ${styles.skeletonHeading}`} />
        <span className={`skeleton-block ${styles.skeletonLine}`} />
        <span className={`skeleton-block ${styles.skeletonLine}`} />
        <span className={`skeleton-block ${styles.skeletonLineShort}`} />
        <div className={styles.skeletonPanel}>
          <span className="skeleton-block" />
          <span className="skeleton-block" />
          <span className="skeleton-block" />
        </div>
      </article>
    </div>
  );
}
