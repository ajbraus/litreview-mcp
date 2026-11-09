# litreview-mcp

An MCP server for literature reviews. It lets an AI assistant search scholarly papers, follow citation trails and find legal open-access PDFs, using data from [OpenAlex](https://openalex.org).

| Tool | What it does |
|---|---|
| `search_papers` | Searches titles and abstracts, sorted by relevance, citations or newest |
| `get_paper` | Returns the abstract, full author list and a draft APA citation |
| `get_citations` | Lists the papers that cite a paper, or the papers it cites |
| `find_open_pdf` | Finds a free, legal copy of a paper |

## Reading order

The code is commented so you can read it top to bottom:

1. **[src/server.ts](src/server.ts)**: what MCP actually is. The tools, their descriptions and their schemas.
2. **[src/openalex.ts](src/openalex.ts)**: plain code that calls the OpenAlex API. No MCP here.
3. **[src/stdio.ts](src/stdio.ts)** and **[api/mcp.ts](api/mcp.ts)**: two tiny files that serve the same tools locally and on the web.
4. **[test/smoke.ts](test/smoke.ts)**: a real MCP client calling the server, which shows the protocol from the other side.

## Five ideas to take away

1. **Tool descriptions are prompts.** The model never sees your code, only the descriptions and schemas.
2. **Tool output uses up the model's context.** Return what it needs for the next decision, not everything you have. That's why search results leave out abstracts.
3. **Errors are for the model to read.** A clear error returned with `isError: true` lets it recover or explain the problem.
4. **Tools and transports are separate.** The tools are defined once, and stdio and HTTP are thin wrappers around them.
5. **Keep the server stateless.** A fresh server per request is what makes cheap serverless hosting possible.

## Run it locally

```bash
npm install
npm test            # end-to-end check over both transports, using live OpenAlex data
npm run typecheck
npm run inspect     # opens MCP Inspector, a web UI for calling your tools by hand
```

To use it from Claude Code, run this from this folder:

```bash
claude mcp add litreview -- "$PWD/node_modules/.bin/tsx" "$PWD/src/stdio.ts"
```

Then try: *"Find the seminal papers on interest development, then show me what's been built on the most cited one since 2020."*

## OpenAlex API key

The server works without a key, but you then share $0.10 a day with everyone on your IP address. A free key from [openalex.org/settings/api](https://openalex.org/settings/api) gives you $1 a day, or about 1,000 searches. Single-paper lookups are free. New accounts spend their first $1 at up to $0.10 every 5 minutes.

Locally, add `-e OPENALEX_API_KEY=your_key` after `claude mcp add litreview`. Budgets reset at midnight UTC.

## Deploy to Vercel

```bash
npx vercel link
npx vercel env add OPENALEX_API_KEY    # needed: Vercel's IPs are shared
npx vercel deploy --prod
```

Your server is then at `https://<your-project>.vercel.app/mcp`. To connect it:

```bash
claude mcp add --transport http litreview https://<your-project>.vercel.app/mcp
```

## Before making it public

There's no login, so anyone with the URL can use your OpenAlex budget. On the free key the worst case is that the server stops working until midnight UTC, not a bill. Before sharing it widely:

- Add a rate limit rule in the Vercel Firewall. It has to be there rather than in this code, because in-memory counters don't work across serverless instances.
- Check that Vercel's Deployment Protection isn't blocking the URL for other people.

## Known limits

- OpenAlex's coverage is broad but not complete, and abstracts are missing for many papers.
- `sort: "citations"` ranks the 200 most relevant matches, not every match, so a famous paper that matches the query poorly can be missed.
- Citations are drafts. Surnames with several words and title capitalization can be wrong.

## License

[MIT](LICENSE)
