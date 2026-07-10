import { createServer } from "node:http";
import httpProxy from "http-proxy";

const port = Number(process.env.PORT ?? 8080);
const target = process.env.AUTH_PROXY_TARGET ?? "http://api:3000";
const defaultUser = process.env.DEV_AUTH_USER ?? "cp20";
const proxy = httpProxy.createProxyServer({
  target,
  changeOrigin: false,
  xfwd: true,
});

proxy.on("proxyReq", (proxyRequest, request) => {
  proxyRequest.removeHeader("x-forwarded-user");
  const username = parseCookie(request.headers.cookie ?? "").onebrc_user;
  if (username && /^[A-Za-z0-9_-]{1,64}$/.test(username)) {
    proxyRequest.setHeader("X-Forwarded-User", username);
  }
});

proxy.on("error", (error, _request, response) => {
  if ("writeHead" in response) {
    response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`mock auth proxy error: ${error.message}`);
  }
});

const server = createServer((request, response) => {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  if (url.pathname === "/_oauth/login") {
    const redirect = safeRedirect(url.searchParams.get("redirect"));
    response.writeHead(302, {
      Location: redirect,
      "Set-Cookie": `onebrc_user=${encodeURIComponent(defaultUser)}; Path=/; HttpOnly; SameSite=Lax`,
      "Cache-Control": "no-store",
    });
    response.end();
    return;
  }
  if (url.pathname === "/_oauth/logout") {
    response.writeHead(302, {
      Location: "/",
      "Set-Cookie": "onebrc_user=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
      "Cache-Control": "no-store",
    });
    response.end();
    return;
  }
  proxy.web(request, response);
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`mock auth proxy listening on ${port}\n`);
});

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
