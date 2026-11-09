import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { ThingsMCP } from "./things-mcp.js";
import { OAuthCredentials } from "./oauth-storage.js";
import { ThingsHandler } from "./things-handler.js";
import { CONNECTOR_RESOURCE_METADATA, CONNECTOR_ORIGIN } from "./brand-assets.js";

export { ThingsMCP, OAuthCredentials };

const provider = new OAuthProvider({
  apiHandlers: {
    "/mcp": ThingsMCP.serve("/mcp"),
    "/sse": ThingsMCP.serveSSE("/sse"),
  },
  defaultHandler: ThingsHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["read", "write"],
  resourceMetadata: CONNECTOR_RESOURCE_METADATA,
  allowPlainPKCE: false,
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Plain HTTP for the connector's own host goes to HTTPS (same path and query),
    // so crawlers and Google's favicon service, which looks sites up by http://,
    // never see a second copy of the site. The target host is the configured
    // origin, never taken from the request.
    const connectorHost = new URL(CONNECTOR_ORIGIN).host;
    if (url.protocol === "http:" && url.host === connectorHost) {
      return new Response(null, {
        status: 308,
        headers: { Location: `${CONNECTOR_ORIGIN}${url.pathname}${url.search}`, "Cache-Control": "no-store" },
      });
    }

    // Let ASSETS handle static files directly if present
    if (env.ASSETS && (
      url.pathname.endsWith(".png") ||
      url.pathname.endsWith(".ico") ||
      url.pathname.endsWith(".txt") ||
      url.pathname.endsWith(".xml")
    )) {
      const assetRes = await env.ASSETS.fetch(request);
      if (assetRes.status !== 404) {
        const headers = new Headers(assetRes.headers);
        headers.set("Access-Control-Allow-Origin", "*");
        // robots.txt and sitemap.xml change; icons are content-stable.
        const crawlerFile = url.pathname.endsWith(".txt") || url.pathname.endsWith(".xml");
        headers.set("Cache-Control", crawlerFile ? "public, max-age=3600" : "public, max-age=31536000, immutable");
        return new Response(assetRes.body, { status: assetRes.status, headers });
      }
    }

    const response = await provider.fetch(request, env, ctx);
    const headers = new Headers(response.headers);
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, { status: response.status, headers });
  },
};
