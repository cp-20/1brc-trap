import { useMutation } from "@tanstack/react-query";
import { Copy, KeyRound } from "lucide-react";
import { useState } from "react";

import {
  ErrorAlert,
  PageHeader,
  Panel,
  SuccessNotice,
} from "../components/ui.js";
import { accountGateway } from "../gateways/account-gateway.js";

export function AccessKeyPage() {
  const [key, setKey] = useState<string | null>(null);
  const issue = useMutation({
    mutationFn: accountGateway.issueAccessKey,
    onSuccess: ({ accessKey }) => setKey(accessKey),
  });
  const revoke = useMutation({
    mutationFn: accountGateway.revokeAccessKey,
    onSuccess: () => setKey(null),
  });
  return (
    <div className="page-stack">
      <PageHeader title="アクセスキー" />
      <Panel className="access-key-panel">
        {key ? (
          <>
            <SuccessNotice>
              このキーは今だけ表示されます。安全な場所に保存してください。
            </SuccessNotice>
            <div className="key-value">
              <code>{key}</code>
              <button
                className="btn btn-square btn-sm"
                onClick={() => void navigator.clipboard.writeText(key)}
                aria-label="アクセスキーをコピー"
              >
                <Copy size={16} />
              </button>
            </div>
          </>
        ) : (
          <p>
            現在のキーは安全のため表示できません。必要なときに発行してください。
          </p>
        )}
        <div className="form-actions">
          <button
            className="btn btn-primary"
            onClick={() => issue.mutate()}
            disabled={issue.isPending}
          >
            <KeyRound size={17} /> 発行する
          </button>
          <button
            className="btn btn-outline"
            onClick={() => revoke.mutate()}
            disabled={revoke.isPending}
          >
            失効する
          </button>
        </div>
        {(issue.error || revoke.error) && (
          <ErrorAlert message={(issue.error ?? revoke.error)?.message} />
        )}
      </Panel>
    </div>
  );
}
