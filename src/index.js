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
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
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
