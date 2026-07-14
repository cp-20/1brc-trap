import type { AccountRepository } from "../repositories/account-repository.js";
import { issueAccessKey } from "../utils/crypto.js";

export type AccountService = ReturnType<typeof createAccountService>;

export function createAccountService(repository: AccountRepository) {
  return {
    issueAccessKey(username: string) {
      const issued = issueAccessKey();
      return repository
        .issueAccessKey(username, issued.hash, issued.prefix)
        .map(() => ({ accessKey: issued.token, prefix: issued.prefix }));
    },
    revokeAccessKey: (username: string) => repository.revokeAccessKey(username),
  };
}
