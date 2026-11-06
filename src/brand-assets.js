export const CONNECTOR_ORIGIN = "https://things3mcp.org";
export const CONNECTOR_MCP_URL = `${CONNECTOR_ORIGIN}/mcp`;

export const REMOTE_SERVER_INFO = {
  name: "Things 3",
  title: "Things 3",
  version: "1.0.0",
  description:
    "Direct personal cloud connector for Things 3 tasks, projects, and inbox via Things Cloud. Operates headlessly without requiring your Mac to be powered on.",
  icons: [
    {
      src: `${CONNECTOR_ORIGIN}/icon-512.png`,
      mimeType: "image/png",
      sizes: ["512x512"],
    },
    {
      src: `${CONNECTOR_ORIGIN}/icon-192.png`,
      mimeType: "image/png",
      sizes: ["192x192"],
    },
    {
      src: `${CONNECTOR_ORIGIN}/apple-touch-icon.png`,
      mimeType: "image/png",
      sizes: ["180x180"],
    },
    {
      src: `${CONNECTOR_ORIGIN}/favicon-32x32.png`,
      mimeType: "image/png",
      sizes: ["32x32"],
    },
  ],
  websiteUrl: CONNECTOR_ORIGIN,
};

export const CONNECTOR_RESOURCE_METADATA = {
  resource: CONNECTOR_MCP_URL,
  authorization_servers: [CONNECTOR_ORIGIN],
  scopes_supported: ["read", "write"],
  bearer_methods_supported: ["header"],
  resource_name: "Things 3",
};

export function remoteServerInfo(origin = CONNECTOR_ORIGIN) {
  const canonical = new URL(origin).origin;
  return {
    ...REMOTE_SERVER_INFO,
    websiteUrl: canonical,
    icons: REMOTE_SERVER_INFO.icons.map((icon) => ({
      ...icon,
      src: new URL(new URL(icon.src).pathname, canonical).href,
    })),
  };
}
