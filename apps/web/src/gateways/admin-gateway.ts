import type { DatasetManifest } from "@1brc/domain";

import { rpc, rpcResult } from "./api-client.js";

export const adminGateway = {
  submissions: () => rpcResult(rpc.admin.submissions.$get()),
  publishPrivate: () => rpcResult(rpc.admin.private.publish.$post()),
  unpublishPrivate: () => rpcResult(rpc.admin.private.unpublish.$post()),
  retry: (id: string) =>
    rpcResult(rpc.admin.submissions[":id"].retry.$post({ param: { id } })),
  disqualify: (id: string, reason: string) =>
    rpcResult(
      rpc.admin.submissions[":id"].disqualify.$post({
        param: { id },
        json: { reason },
      }),
    ),
  importDatasets: (manifest: DatasetManifest) =>
    rpcResult(rpc.admin.datasets.import.$post({ json: manifest })),
};
