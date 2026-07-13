export type CurrentUser = {
  username: string;
  isAdmin: boolean;
  method: string;
};

export function avatarUrl(username: string, size = 64): string {
  const encodedUsername = encodeURIComponent(username);
  return `https://image-proxy.trap.jp/icon/${encodedUsername}?width=${size}&height=${size}&format=webp`;
}
