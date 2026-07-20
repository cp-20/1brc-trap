import { apiClient, apiResult } from "./api-client.js";

export const accountGateway = {
  me: () => apiResult(apiClient.GET("/api/v1/me")),
  issueAccessKey: () => apiResult(apiClient.POST("/api/v1/access-key")),
  revokeAccessKey: () => apiResult(apiClient.DELETE("/api/v1/access-key")),
};
