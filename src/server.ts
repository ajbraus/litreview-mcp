// server.ts: the MCP layer. This is where we tell AI clients what tools exist.
//
// An MCP server is mostly a list of tools. Each tool has three parts:
//
//   1. A description: how the model decides when to use the tool. The model
//      only ever sees this text, never your code, so it's effectively a prompt.
//   2. An input schema: what arguments it takes. The SDK turns this into JSON
//      Schema for the model and also validates each incoming call against it.
//   3. A handler: the function that runs when the model calls the tool.
//
// This file doesn't know how it's being served. stdio.ts (local) and api/mcp.ts
// (Vercel) both call createServer(), so the tools are only defined once.

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { findOpenPdf, getCitations, getPaper, searchPapers } from "./openalex.js";

/**
 * Runs a tool's work and packages the outcome the way MCP expects.
 *
 * Tool results are a list of content blocks. We return one text block holding
 * JSON, which models read easily.
 *
 * Note the error path. When something fails, we return the message as a normal
 * result marked `isError: true` instead of letting the exception escape. That
 * way the model sees the error, and it can correct itself or tell the user.
 */
async function toolResult(work: () => Promise<unknown>) {
  try {
    const data = await work();
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }
}

// Annotations are hints to the client about how a tool behaves, and clients can
// use them to decide things like whether to ask permission first.
const READ_ONLY_TOOL = {
  readOnlyHint: true, // never changes anything
  openWorldHint: true, // talks to an outside service
};

// These schema pieces are shared by several tools. The .describe() text is sent
// to the model, so write it for the model. A concrete example helps a lot.
const paperId = z
  .string()
  .describe("OpenAlex ID (W2057673348) or DOI (10.1207/s15326985ep4102_4)");
const limit = z.number().int().min(1).max(50).default(10).describe("How many papers to return");
const fromYear = z.number().int().optional().describe("Only papers published in or after this year");

/**
 * Builds a new server with all tools registered.
 *
 * It's a factory function rather than a single shared object because the SDK
 * asks for a fresh server for each HTTP request. That's what lets this run on
 * serverless hosting: nothing is remembered between requests, so any instance
 * can answer any call.
 */
export function createServer() {
  const server = new McpServer(
    { name: "litreview", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      // Clients may show this to the model once, as general guidance on how the
      // tools fit together. Per-tool advice belongs in the tool descriptions.
      instructions:
        "Tools for literature reviews, backed by OpenAlex. A typical review: use search_papers " +
        "sorted by citations to find seminal work, search again sorted by newest with a recent " +
        "from_year for current research, use get_citations to follow the trail from key papers, " +
        "then get_paper for abstracts and citations. Only cite papers these tools returned. " +
        "Never invent a citation.",
    },
  );

  server.registerTool(
    "search_papers",
    {
      title: "Search papers",
      description:
        "Search scholarly papers by topic, matching titles and abstracts. Returns compact " +
        "summaries without abstracts; use get_paper for details. Put exact phrases in double " +
        'quotes for much better precision, e.g. "growth mindset" teachers. With sort "citations" ' +
        'or "newest", results are the top 200 most relevant papers re-ranked, so a famous paper ' +
        "that matches the query poorly can be missed. Each search uses some of the server's " +
        "daily budget, so prefer a few well-chosen queries.",
      inputSchema: z.object({
        query: z.string().min(2).describe("Topic to search for"),
        sort: z
          .enum(["relevance", "citations", "newest"])
          .default("relevance")
          .describe('Use "citations" to find seminal papers, "newest" for current research'),
        from_year: fromYear,
        to_year: z.number().int().optional().describe("Only papers published in or before this year"),
        open_access_only: z.boolean().default(false).describe("Only papers that are free to read"),
        limit,
      }),
      annotations: READ_ONLY_TOOL,
    },
    // The SDK has already validated these arguments against the schema above,
    // and TypeScript knows their types, so no checking is needed here.
    async ({ query, sort, from_year, to_year, open_access_only, limit }) =>
      toolResult(() =>
        searchPapers({
          query,
          sort,
          limit,
          fromYear: from_year,
          toYear: to_year,
          openAccessOnly: open_access_only,
        }),
      ),
  );

  server.registerTool(
    "get_paper",
    {
      title: "Get paper details",
      description:
        "Get one paper's abstract, full author list, citation count and a draft APA citation. " +
        "The citation is generated from metadata: check author names and title capitalization " +
        "before using it. The abstract is null when OpenAlex doesn't have one.",
      inputSchema: z.object({ id: paperId }),
      annotations: READ_ONLY_TOOL,
    },
    async ({ id }) => toolResult(() => getPaper(id)),
  );

  server.registerTool(
    "get_citations",
    {
      title: "Follow citations",
      description:
        "Follow the citation trail from a paper, most cited first. Direction " +
        '"cited_by" finds later papers that cite it, which shows how the idea developed. ' +
        'Direction "references" finds the papers it cites, which shows its foundations.',
      inputSchema: z.object({
        id: paperId,
        direction: z.enum(["cited_by", "references"]),
        from_year: fromYear,
        limit,
      }),
      annotations: READ_ONLY_TOOL,
    },
    async ({ id, direction, from_year, limit }) =>
      toolResult(() => getCitations({ id, direction, limit, fromYear: from_year })),
  );

  server.registerTool(
    "find_open_pdf",
    {
      title: "Find open-access PDF",
      description:
        "Find a free, legal copy of a paper. Returns a direct pdf_url when one is known, and " +
        "otherwise a read_online_url. Both are null if no open copy is known, in which case the " +
        "paper is probably paywalled. Check the version field: a preprint can differ from the " +
        "published paper.",
      inputSchema: z.object({ id: paperId }),
      annotations: READ_ONLY_TOOL,
    },
    async ({ id }) => toolResult(() => findOpenPdf(id)),
  );

  return server;
}
