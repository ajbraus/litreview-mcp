// api/mcp.ts: runs the server on the web, as a Vercel Function.
//
// Vercel turns each file in api/ into an HTTP endpoint, so this one is served at
// /api/mcp. vercel.json adds the shorter address /mcp.
//
// This is the second "transport": the same tools as stdio.ts, but messages
// arrive as HTTP requests. createMcpHandler does the protocol work, building a
// fresh server for each request. It also answers clients that only speak the
// older 2025 version of MCP, so both old and new clients can connect.

import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "../src/server.js";

const handler = createMcpHandler(createServer);

export default {
  fetch: (request: Request) => handler.fetch(request),
};
