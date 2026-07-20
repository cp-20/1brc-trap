import type { DatasetManifest } from "@1brc/domain";

import { apiClient, apiResult } from "./api-client.js";

export const adminGateway = {
  submissions: () => apiResult(apiClient.GET("/api/v1/admin/submissions")),
  publishPrivate: () =>
    apiResult(apiClient.POST("/api/v1/admin/private/publish")),
  unpublishPrivate: () =>
    apiResult(apiClient.POST("/api/v1/admin/private/unpublish")),
  retry: (id: string) =>
    apiResult(
      apiClient.POST("/api/v1/admin/submissions/{id}/retry", {
        params: { path: { id } },
      }),
    ),
  disqualify: (id: string, reason: string) =>
    apiResult(
      apiClient.POST("/api/v1/admin/submissions/{id}/disqualify", {
        params: { path: { id } },
        body: { reason },
      }),
    ),
  importDatasets: (manifest: DatasetManifest) =>
    apiResult(
      apiClient.POST("/api/v1/admin/datasets/import", { body: manifest }),
    ),
};
