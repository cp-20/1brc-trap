import { useQuery } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { Link } from "react-router-dom";
import { ContestDocument } from "../components/contest/contest-document.js";
import { ErrorAlert, Loading, PageHeader } from "../components/ui.js";
import { contestGateway } from "../gateways/contest-gateway.js";

export function ContestPage() {
  const contest = useQuery({
    queryKey: ["contest"],
    queryFn: contestGateway.contest,
  });
  const datasets = useQuery({
    queryKey: ["datasets"],
    queryFn: contestGateway.datasets,
  });
  if (contest.isPending) return <Loading />;
  if (!contest.data) return <ErrorAlert message={contest.error?.message} />;

  return (
    <div className="page-stack">
      <PageHeader
        title="コンテスト"
        action={
          <Link className="btn btn-primary btn-sm" to="/submit">
            <Send size={16} /> 提出する
          </Link>
        }
      />
      <ContestDocument
        environment={contest.data.environment}
        datasets={datasets.data}
        datasetsError={datasets.isError}
      />
    </div>
  );
}
