import { rpc, rpcResult } from "./api-client.js";

export const accountGateway = {
  me: () => rpcResult(rpc.me.$get()),
  issueAccessKey: () => rpcResult(rpc["access-key"].$post()),
  revokeAccessKey: () => rpcResult(rpc["access-key"].$delete()),
};
