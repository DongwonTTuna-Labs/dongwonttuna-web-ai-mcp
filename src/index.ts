#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type AppConfig, formatConfigError, loadConfig } from "./config.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./constants.js";
import { registerReadUrlTool } from "./tools/read-url.js";
import { registerSearchWebTool } from "./tools/search-web.js";

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(
      `${PACKAGE_NAME}: configuration error: ${formatConfigError(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  const server = new McpServer({
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
  });
  registerReadUrlTool(server, config);
  registerSearchWebTool(server, config);

  await server.connect(new StdioServerTransport());
  console.error(`${PACKAGE_NAME} ${PACKAGE_VERSION} started on stdio`);
}

main().catch(() => {
  console.error(`${PACKAGE_NAME}: fatal server startup error`);
  process.exitCode = 1;
});
