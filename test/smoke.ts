// smoke.ts: an end-to-end test using a real MCP client and the live OpenAlex API.
//
// It runs the same checks over both transports, so it proves that stdio.ts and
// api/mcp.ts both work. Run it with `npm test`. It uses about $0.01 of your
// OpenAlex daily budget per run.

import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import handler from "../api/mcp.js";

const FOUR_PHASE_DOI = "10.1207/s15326985ep4102_4"; // Hidi & Renninger (2006)
const FOUR_PHASE_ID = "W2057673348";

// Calls a tool and parses the JSON text our server returns.
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0].text;
  assert.ok(!result.isError, `${name} failed: ${text}`);
  return JSON.parse(text);
}

async function checkServer(label: string, client: Client) {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "find_open_pdf",
    "get_citations",
    "get_paper",
    "search_papers",
  ]);

  // The re-ranking should put the landmark paper first, not liver guidelines.
  const search = await call(client, "search_papers", {
    query: "four phase interest development",
    sort: "citations",
    limit: 3,
  });
  assert.equal(search.results[0].id, FOUR_PHASE_ID);
  assert.equal(search.results.length, 3);

  // A DOI should work as an ID, and the abstract should come back as text.
  const paper = await call(client, "get_paper", { id: `https://doi.org/${FOUR_PHASE_DOI}` });
  assert.equal(paper.id, FOUR_PHASE_ID);
  assert.ok(paper.abstract?.includes("interest"), "abstract was not rebuilt");
  assert.match(paper.citation_apa_draft, /^Hidi, S\..*\(2006\)/);

  // A title ending in "?" shouldn't get a period after it.
  const question = await call(client, "get_paper", { id: "W3116178148" });
  assert.match(question.citation_apa_draft, /controversies\? American/);

  // The two directions must not be swapped. The paper has ~5,000 citing papers
  // but only ~140 references, so the totals tell them apart.
  const citedBy = await call(client, "get_citations", {
    id: FOUR_PHASE_ID,
    direction: "cited_by",
    limit: 2,
  });
  const references = await call(client, "get_citations", {
    id: FOUR_PHASE_DOI,
    direction: "references",
    limit: 2,
  });
  assert.ok(citedBy.total > 1000, `cited_by total was ${citedBy.total}`);
  assert.ok(references.total < 500, `references total was ${references.total}`);

  // A known open-access paper, and a known closed one.
  const open = await call(client, "find_open_pdf", { id: "W2741809807" });
  assert.equal(open.is_open_access, true);
  assert.ok(open.pdf_url || open.read_online_url, "no open link found");
  const closed = await call(client, "find_open_pdf", { id: FOUR_PHASE_ID });
  assert.equal(closed.pdf_url, null);

  // Bad input should come back as a readable tool error, not a crash.
  const bad = await client.callTool({ name: "get_paper", arguments: { id: "../../authors" } });
  assert.equal(bad.isError, true);

  const missing = await client.callTool({
    name: "get_paper",
    arguments: { id: "10.9999/doesnotexist" },
  });
  assert.equal(missing.isError, true);

  console.log(`ok: ${label}`);
}

// Transport 1: launch the server as a child process, as Claude Code would.
const stdioClient = new Client({ name: "smoke-test", version: "1.0.0" });
await stdioClient.connect(
  new StdioClientTransport({ command: "npx", args: ["tsx", "src/stdio.ts"] }),
);
await checkServer("stdio", stdioClient);
await stdioClient.close();

// Transport 2: send real HTTP Request objects to the Vercel entry point. The
// custom `fetch` hands each one straight to api/mcp.ts, so no server is needed.
const httpClient = new Client({ name: "smoke-test", version: "1.0.0" });
await httpClient.connect(
  new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), {
    fetch: (input, init) => handler.fetch(new Request(input, init)),
  }),
);
await checkServer("http", httpClient);
await httpClient.close();
