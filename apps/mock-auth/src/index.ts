const port = Number(process.env.PORT ?? 8080);
const target = process.env.AUTH_PROXY_TARGET ?? "http://api:3000";
const defaultUser = process.env.DEV_AUTH_USER ?? "cp20";
const targetOrigin = new URL(target);

Bun.serve({
  port,
  hostname: "0.0.0.0",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/_oauth/login") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: safeRedirect(url.searchParams.get("redirect")),
          "Set-Cookie": `onebrc_user=${encodeURIComponent(defaultUser)}; Path=/; HttpOnly; SameSite=Lax`,
          "Cache-Control": "no-store",
        },
      });
    }
    if (url.pathname === "/_oauth/logout") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/",
          "Set-Cookie":
            "onebrc_user=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
          "Cache-Control": "no-store",
        },
      });
    }

    const headers = new Headers(request.headers);
    headers.delete("x-forwarded-user");
    const username = parseCookie(headers.get("cookie") ?? "").onebrc_user;
    if (username && /^[A-Za-z0-9_-]{1,64}$/.test(username)) {
      headers.set("X-Forwarded-User", username);
    }
    headers.set("X-Forwarded-Host", url.host);
    headers.set("X-Forwarded-Proto", url.protocol.slice(0, -1));
    headers.set("host", targetOrigin.host);

    const upstream = new URL(`${url.pathname}${url.search}`, targetOrigin);
    try {
      const init: RequestInit = {
        method: request.method,
        headers,
        redirect: "manual",
      };
      if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = request.body;
      }
      return await fetch(upstream, init);
    } catch (error) {
      return new Response(
        `開発用認証プロキシからAPIへ接続できません: ${error instanceof Error ? error.message : String(error)}`,
        {
          status: 502,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        },
      );
    }
  },
});

process.stdout.write(`開発用認証プロキシをポート${port}で起動しました\n`);

function parseCookie(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split(";")
      .map((part) => part.trim().split("=", 2))
      .filter((item) => item.length === 2)
      .map(([key, item]) => [key!, decodeURIComponent(item!)]),
  );
}

function safeRedirect(value: string | null): string {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}
