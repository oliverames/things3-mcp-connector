import { Hono } from "hono";
import { landingPage, loginPage, privacyPage, errorPage } from "./pages.js";
import { ThingsCloudClient } from "./things-client.js";
import { encryptJson } from "./credential-crypto.js";

const app = new Hono();

// Helper to serve public assets from ASSETS binding or memory
app.get("/icon-512.png", async (c) => c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.notFound());
app.get("/icon-1024.png", async (c) => c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.notFound());
app.get("/icon-192.png", async (c) => c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.notFound());
app.get("/apple-touch-icon.png", async (c) => c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.notFound());
app.get("/favicon.ico", async (c) => c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.notFound());
app.get("/favicon-32x32.png", async (c) => c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.notFound());
app.get("/favicon-16x16.png", async (c) => c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.notFound());
app.get("/robots.txt", async (c) => c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.notFound());
app.get("/sitemap.xml", async (c) => c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.notFound());

app.get("/", (c) => c.html(landingPage()));
app.get("/privacy", (c) => c.html(privacyPage()));

// OAuth 2.1 Authorization Endpoint
app.get("/authorize", async (c) => {
  let oauthReqInfo;
  try {
    oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (err) {
    console.error("parseAuthRequest error:", err);
    return c.html(errorPage("Invalid authorization request. Please try connecting from your AI client again."), 400);
  }

  if (!oauthReqInfo?.clientId) {
    return c.html(errorPage("Missing OAuth client id."), 400);
  }

  const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
  const clientName = client?.clientName || oauthReqInfo.clientId;

  const consentId = crypto.randomUUID();
  if (c.env.OAUTH_KV) {
    await c.env.OAUTH_KV.put(`consent:${consentId}`, JSON.stringify(oauthReqInfo), {
      expirationTtl: 900,
    });
  }

  const queryParams = Object.fromEntries(new URL(c.req.url).searchParams.entries());
  return c.html(loginPage({ clientName, consentId, queryParams }));
});

// OAuth 2.1 Login Form Submission
app.post("/authorize/login", async (c) => {
  let oauthParams = {};
  let email = "";
  let password = "";
  let consentId = "";

  try {
    const body = await c.req.parseBody();
    email = (body.email || "").toString().trim();
    password = (body.password || "").toString();
    consentId = (body.consentId || "").toString().trim();
    const oauthParamsRaw = body.oauthParams ? decodeURIComponent(body.oauthParams.toString()) : "{}";
    try {
      oauthParams = JSON.parse(oauthParamsRaw);
    } catch (_) {}

    if (!email || !password) {
      return c.html(
        loginPage({
          clientName: "AI Assistant",
          consentId,
          queryParams: oauthParams,
          error: "Email and password are required.",
        }),
        400
      );
    }

    // The OAuth request comes first: without a pending consent record or a valid authorization
    // request, the password is never sent to Things Cloud, so this endpoint cannot be used on its
    // own to test whether a password is right.
    let oauthReqInfo = null;
    if (consentId && c.env.OAUTH_KV) {
      try {
        const stored = await c.env.OAUTH_KV.get(`consent:${consentId}`);
        if (stored) {
          oauthReqInfo = JSON.parse(stored);
        }
      } catch (kvErr) {
        console.error("Failed to read consent from KV:", kvErr);
      }
    }

    if (!oauthReqInfo) {
      // Fallback: Reconstruct request from original parameters
      const authUrl = new URL(`${c.env.CONNECTOR_BASE_URL || "https://things3mcp.org"}/authorize`);
      for (const [k, v] of Object.entries(oauthParams)) {
        authUrl.searchParams.set(k, v);
      }

      const dummyReq = new Request(authUrl.toString(), {
        headers: c.req.raw.headers,
      });

      try {
        oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(dummyReq);
      } catch (_) {
        oauthReqInfo = null;
      }
    }

    if (!oauthReqInfo?.clientId) {
      return c.html(errorPage("Authorization request expired or invalid. Please restart connection from your AI client."), 400);
    }

    // Validate credentials directly with Things Cloud
    let accountInfo;
    try {
      const client = new ThingsCloudClient({ email, password });
      accountInfo = await client.validateAndFetchAccount();
    } catch (err) {
      return c.html(
        loginPage({
          clientName: "AI Assistant",
          consentId,
          queryParams: oauthParams,
          error: err.message || "Failed to authenticate with Things Cloud. Please check your email and password.",
        }),
        401
      );
    }

    // The credentials are stored once, encrypted, in the grant's props. The provider deletes the
    // props with the grant, both when the grant is revoked and when a new sign-in by the same
    // user and client replaces it (completeAuthorization revokes the earlier grants by default),
    // so nothing outlives the grant.
    const encryptedCredentials = await encryptJson(
      {
        email,
        password,
        historyKey: accountInfo.historyKey,
        mailDropEmail: accountInfo.mailDropEmail,
      },
      c.env.DATA_ENCRYPTION_KEY
    );

    const scopes = Array.isArray(oauthReqInfo.scope)
      ? oauthReqInfo.scope
      : (typeof oauthReqInfo.scope === "string" ? oauthReqInfo.scope.split(" ").filter(Boolean) : ["read", "write"]);

    // Complete OAuth flow and redirect back to client (Claude / ChatGPT / etc.)
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId: email,
      metadata: {
        authorizedAt: new Date().toISOString(),
        email,
      },
      scope: scopes.length > 0 ? scopes : ["read", "write"],
      props: {
        email,
        historyKey: accountInfo.historyKey,
        encryptedCredentials,
      },
    });

    // Clean up temporary consent record
    if (consentId && c.env.OAUTH_KV) {
      c.executionCtx.waitUntil(c.env.OAUTH_KV.delete(`consent:${consentId}`));
    }

    return c.redirect(redirectTo, 302);
  } catch (err) {
    console.error("OAuth authorization error:", err);
    return c.html(
      loginPage({
        clientName: "AI Assistant",
        consentId,
        queryParams: oauthParams,
        error: `Authorization error: ${err.message || "An unexpected error occurred."}`,
      }),
      500
    );
  }
});

export { app as ThingsHandler };
