import { Hono } from "hono";
import { landingPage, loginPage, privacyPage, errorPage } from "./pages.js";
import { ThingsCloudClient } from "./things-client.js";

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
    return c.html(errorPage("Invalid authorization request."), 400);
  }

  if (!oauthReqInfo?.clientId) {
    return c.html(errorPage("Missing OAuth client id."), 400);
  }

  const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
  const clientName = client?.clientName || oauthReqInfo.clientId;

  const queryParams = Object.fromEntries(new URL(c.req.url).searchParams.entries());
  return c.html(loginPage({ clientName, queryParams }));
});

// OAuth 2.1 Login Form Submission
app.post("/authorize/login", async (c) => {
  const body = await c.req.parseBody();
  const email = (body.email || "").toString().trim();
  const password = (body.password || "").toString();
  const oauthParamsRaw = body.oauthParams ? decodeURIComponent(body.oauthParams.toString()) : "{}";
  let oauthParams = {};
  try {
    oauthParams = JSON.parse(oauthParamsRaw);
  } catch (_) {}

  if (!email || !password) {
    return c.html(loginPage({ clientName: "AI Assistant", queryParams: oauthParams, error: "Email and password are required." }), 400);
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
        queryParams: oauthParams,
        error: err.message || "Failed to authenticate with Things Cloud.",
      }),
      401
    );
  }

  // Construct fake request for parseAuthRequest from original parameters
  const authUrl = new URL(`${c.env.CONNECTOR_BASE_URL || "https://things3mcp.org"}/authorize`);
  for (const [k, v] of Object.entries(oauthParams)) {
    authUrl.searchParams.set(k, v);
  }

  const dummyReq = new Request(authUrl.toString(), {
    headers: c.req.raw.headers,
  });

  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(dummyReq);
  const grantId = crypto.randomUUID();

  // Store credentials securely in Durable Object
  const credDO = c.env.OAUTH_CREDENTIALS.get(c.env.OAUTH_CREDENTIALS.idFromName(grantId));
  await credDO.setCredentials({
    email,
    password,
    historyKey: accountInfo.historyKey,
    mailDropEmail: accountInfo.mailDropEmail,
  });

  // Complete OAuth flow and redirect back to client (Claude / ChatGPT / etc.)
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuth(oauthReqInfo, {
    props: {
      grantId,
      email,
      historyKey: accountInfo.historyKey,
    },
    userId: email,
    scope: oauthReqInfo.scope || "read write",
  });

  return c.redirect(redirectTo, 302);
});

export { app as ThingsHandler };
