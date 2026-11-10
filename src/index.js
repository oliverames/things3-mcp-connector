import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { ThingsMCP } from "./things-mcp.js";
import { OAuthCredentials } from "./oauth-storage.js";
import { ThingsHandler } from "./things-handler.js";
import { CONNECTOR_RESOURCE_METADATA, CONNECTOR_ORIGIN } from "./brand-assets.js";
import { withSecurityHeaders } from "./pages.js";
import { upgradeGrantProps } from "./credential-crypto.js";

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
  // Each time a grant gets a token, bring its stored credentials up to date: re-encrypt props
  // still under the old key, and delete the second copy older grants kept in a Durable Object.
  // A failure here must not block the token, and nothing about the credentials is logged.
  tokenExchangeCallback: async ({ props }) => {
    const workerEnv = currentEnv;
    if (!workerEnv) return;
    try {
      const newProps = await upgradeGrantProps(props, workerEnv.DATA_ENCRYPTION_KEY, (grantId) =>
        workerEnv.OAUTH_CREDENTIALS.get(workerEnv.OAUTH_CREDENTIALS.idFromName(grantId)).clear()
      );
      if (newProps) return { newProps };
    } catch {
      console.error("Stored credentials for a grant could not be upgraded; the grant is unchanged.");
    }
  },
});

// The provider's callbacks get no env argument; fetch records the one it was called with.
let currentEnv = null;

export default {
  async fetch(request, env, ctx) {
    currentEnv = env;
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
        // These paths are not versioned, so none of them may be immutable: the
        // icons changed in place on 2026-11-09. Crawler files change more often.
        const crawlerFile = url.pathname.endsWith(".txt") || url.pathname.endsWith(".xml");
        headers.set("Cache-Control", crawlerFile ? "public, max-age=3600" : "public, max-age=86400");
        return new Response(assetRes.body, { status: assetRes.status, headers });
      }
    }

    return withSecurityHeaders(await provider.fetch(request, env, ctx));
  },
};
