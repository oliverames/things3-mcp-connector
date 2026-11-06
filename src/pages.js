const styles = `
  :root {
    --bg: #f5f5f7;
    --card-bg: #ffffff;
    --text: #1d1d1f;
    --secondary-text: #86868b;
    --accent: #2e66f6;
    --border: rgba(0, 0, 0, 0.08);
    --input-border: #d2d2d7;
    --shadow: 0 12px 36px rgba(0, 0, 0, 0.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #000000;
      --card-bg: #1c1c1e;
      --text: #f5f5f7;
      --secondary-text: #a1a1a6;
      --accent: #2e66f6;
      --border: rgba(255, 255, 255, 0.12);
      --input-border: #38383a;
      --shadow: 0 12px 36px rgba(0, 0, 0, 0.35);
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 20px;
    box-shadow: var(--shadow);
    width: 100%;
    max-width: 440px;
    padding: 36px 32px;
    text-align: center;
  }
  .app-icon {
    width: 88px;
    height: 88px;
    border-radius: 20px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
    margin-bottom: 20px;
  }
  h1 { font-size: 24px; font-weight: 700; margin-bottom: 8px; letter-spacing: -0.01em; }
  p { font-size: 15px; color: var(--secondary-text); line-height: 1.45; margin-bottom: 24px; }
  .badge {
    display: inline-block;
    background: rgba(46, 102, 246, 0.12);
    color: var(--accent);
    padding: 4px 10px;
    border-radius: 12px;
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 16px;
  }
  form { text-align: left; }
  .field { margin-bottom: 18px; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  input[type="text"], input[type="email"], input[type="password"] {
    width: 100%;
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid var(--input-border);
    background: transparent;
    color: var(--text);
    font-size: 15px;
    outline: none;
    transition: border-color 0.15s ease;
  }
  input:focus { border-color: var(--accent); }
  button {
    width: 100%;
    padding: 14px;
    border-radius: 12px;
    border: none;
    background: var(--accent);
    color: #ffffff;
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
    margin-top: 10px;
    transition: opacity 0.15s ease;
  }
  button:hover { opacity: 0.92; }
  .error-box {
    background: rgba(255, 59, 48, 0.1);
    color: #ff3b30;
    border-radius: 10px;
    padding: 12px;
    font-size: 14px;
    margin-bottom: 20px;
    text-align: left;
  }
  .footer { margin-top: 24px; font-size: 13px; color: var(--secondary-text); }
  .footer a { color: var(--accent); text-decoration: none; }
`;

function layout({ title, content }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - Things 3 MCP</title>
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
  <link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
  <meta property="og:title" content="${title} - Things 3 MCP">
  <meta property="og:description" content="Personal remote MCP server for Things 3 Cloud">
  <meta property="og:image" content="https://things3mcp.org/icon-512.png">
  <style>${styles}</style>
</head>
<body>
  <div class="card">
    <img src="/icon-512.png" alt="Things 3 Icon" class="app-icon">
    ${content}
  </div>
  <div class="footer">
    <p>Independent personal connector for Things 3 &bull; <a href="/privacy">Privacy</a></p>
  </div>
</body>
</html>`;
}

export function landingPage() {
  return layout({
    title: "Things 3 Cloud MCP",
    content: `
      <div class="badge">Model Context Protocol</div>
      <h1>Things 3 Cloud Server</h1>
      <p>A personal remote MCP server running in the cloud. Access your Things 3 to-dos, inbox, and projects from Claude, ChatGPT, or any remote AI assistant—no Mac required.</p>
      <div style="background: rgba(0,0,0,0.04); border-radius: 12px; padding: 14px; font-family: ui-monospace, Menlo, monospace; font-size: 13px; text-align: left; word-break: break-all; margin-bottom: 20px;">
        <strong>MCP Endpoint:</strong><br>
        <code>https://things3mcp.org/mcp</code>
      </div>
    `,
  });
}

export function loginPage({ clientName, consentId = "", queryParams = {}, error = null }) {
  return layout({
    title: "Connect Things 3",
    content: `
      <div class="badge">${clientName || "AI Assistant"}</div>
      <h1>Connect Things 3</h1>
      <p>Log in with your Things Cloud credentials to authorize <strong>${clientName || "your AI Assistant"}</strong>.</p>
      ${error ? `<div class="error-box">${error}</div>` : ""}
      <form action="/authorize/login" method="POST">
        <input type="hidden" name="consentId" value="${consentId || ""}">
        <input type="hidden" name="oauthParams" value="${encodeURIComponent(JSON.stringify(queryParams))}">
        <div class="field">
          <label for="email">Things Cloud Email</label>
          <input type="email" id="email" name="email" required autocomplete="email" placeholder="you@example.com">
        </div>
        <div class="field">
          <label for="password">Things Cloud Password</label>
          <input type="password" id="password" name="password" required autocomplete="current-password">
        </div>
        <button type="submit">Authorize &amp; Connect</button>
      </form>
    `,
  });
}

export function privacyPage() {
  return layout({
    title: "Privacy Policy",
    content: `
      <h1>Privacy Policy</h1>
      <p style="text-align: left; font-size: 14px; margin-top: 16px;">
        This server functions solely as an authorized bridge between your AI client and your Things Cloud account.<br><br>
        Credentials are encrypted at rest using AES-GCM and stored only in your private Cloudflare worker storage. No third party has access to your data or credentials.<br><br>
        All communications with Cultured Code's Things Cloud servers are encrypted over TLS.
      </p>
      <div style="margin-top: 24px;">
        <a href="/" style="color: var(--accent); text-decoration: none; font-weight: 600;">&larr; Back to Home</a>
      </div>
    `,
  });
}

export function errorPage(msg) {
  return layout({
    title: "Error",
    content: `
      <h1>Connection Error</h1>
      <div class="error-box">${msg}</div>
      <a href="/" style="color: var(--accent); text-decoration: none; font-weight: 600;">Return to Home</a>
    `,
  });
}
