// openalex.ts: everything that talks to OpenAlex, a free catalog of over
// 300 million scholarly works.
//
// Notice that nothing in this file knows about MCP. It's ordinary code that
// takes arguments and returns plain objects. Keeping it separate means the MCP
// layer (server.ts) stays thin, and you could reuse this file in a CLI or a
// website without changing it.

const BASE_URL = "https://api.openalex.org";

// OpenAlex charges each request against a daily budget:
//   - searches and lists cost $0.0001 to $0.001
//   - fetching one paper by ID is free
// With no key, you share $0.10/day with everyone on your IP address. That's
// fine for local use, but on a shared host like Vercel you need your own key,
// which gets its own $1/day (roughly 1,000 searches).
const REQUEST_TIMEOUT_MS = 15_000;

// How many relevant papers we pull before re-ranking. See searchPapers() for
// why. 200 is the most OpenAlex returns in one page, and a page of 200 costs
// the same as a page of 5.
const RERANK_POOL_SIZE = 200;

// ---------------------------------------------------------------------------
// Types: the parts of an OpenAlex "work" (their word for a paper) that we use.
// The real records have far more fields. The `select` parameter in each request
// below asks for only these, which keeps responses small.
// ---------------------------------------------------------------------------

interface Location {
  is_oa: boolean;
  landing_page_url: string | null;
  pdf_url: string | null;
  license: string | null;
  version: string | null;
  source: { display_name: string } | null;
}

interface Work {
  id: string; // e.g. "https://openalex.org/W2057673348"
  doi: string | null; // e.g. "https://doi.org/10.1207/s15326985ep4102_4"
  title: string | null;
  publication_year: number | null;
  type: string | null;
  cited_by_count: number;
  authorships: { author: { display_name: string } }[];
  primary_location: Location | null;
  open_access: { is_oa: boolean; oa_status: string; oa_url: string | null };
  // Only requested by some calls, so these are optional.
  best_oa_location?: Location | null;
  locations?: Location[];
  biblio?: {
    volume: string | null;
    issue: string | null;
    first_page: string | null;
    last_page: string | null;
  };
  abstract_inverted_index?: Record<string, number[]> | null;
  referenced_works_count?: number;
}

// The fields every call needs in order to build a PaperSummary.
const SUMMARY_FIELDS =
  "id,doi,title,publication_year,type,cited_by_count,authorships,primary_location,open_access";

// ---------------------------------------------------------------------------
// The HTTP helper. All network access goes through this one function, so
// timeouts, auth and error handling only have to be written once.
// ---------------------------------------------------------------------------

async function openAlexGet<T>(
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const apiKey = process.env.OPENALEX_API_KEY;
  if (apiKey) url.searchParams.set("api_key", apiKey);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.ok) return (await response.json()) as T;

  // These messages go back to the AI model, so they say what happened and what
  // to do next. They deliberately never include `url`, because it can contain
  // the API key and tool output is visible to the user and the model.
  if (response.status === 404) {
    throw new Error("Paper not found. Check the ID, or use search_papers to find it.");
  }
  if (response.status === 429) {
    // A 429 can mean "slow down for a moment" or "today's budget is gone".
    // The Retry-After header says how long to wait, so we pass that along.
    const wait = response.headers.get("retry-after");
    throw new Error(
      "OpenAlex rate limit reached: either too many requests at once, or this server's daily " +
        `budget is used up (it resets at midnight UTC). ${wait ? `Retry after ${wait} seconds.` : ""}`.trim(),
    );
  }
  throw new Error(`OpenAlex returned an error (HTTP ${response.status}). Try again shortly.`);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Turns whatever ID the model gives us into the form OpenAlex's URLs expect.
 * Models pass IDs in many shapes, so being forgiving here prevents failed calls.
 *
 *   "W2057673348"                       -> "W2057673348"
 *   "https://openalex.org/W2057673348"  -> "W2057673348"
 *   "10.1207/s15326985ep4102_4"         -> "doi:10.1207%2Fs15326985ep4102_4"
 *   "https://doi.org/10.1207/..."       -> same DOI form
 *
 * This is also a safety check. The value ends up inside a URL path, so anything
 * that isn't clearly an ID is rejected, and DOIs are percent-encoded so
 * something like "10.1/../../authors" can't point the request somewhere else.
 */
function normalizeId(rawId: string): string {
  const id = rawId.trim();

  const openAlexMatch = id.match(/^(?:https?:\/\/openalex\.org\/)?(W\d+)$/i);
  if (openAlexMatch) return openAlexMatch[1].toUpperCase();

  const doi = id.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)/i, "");
  if (/^10\.\d{4,9}\/\S+$/.test(doi)) return `doi:${encodeURIComponent(doi)}`;

  throw new Error(
    `"${rawId}" isn't a valid paper ID. Use an OpenAlex ID like W2057673348 or a DOI like 10.1207/s15326985ep4102_4.`,
  );
}

/**
 * OpenAlex doesn't store abstracts as text. For copyright reasons it stores an
 * "inverted index" mapping each word to the positions where it appears:
 *
 *   { "Interest": [0], "develops": [1], "in": [2], "phases": [3] }
 *
 * To get the text back, we put every word in its position and join them.
 */
function rebuildAbstract(index: Record<string, number[]> | null | undefined): string | null {
  if (!index) return null;

  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words[position] = word;
  }
  return words.join(" ");
}

const authorNames = (work: Work) => work.authorships.map((a) => a.author.display_name);

/** "Suzanne E. Hidi" -> "Hidi, S. E." */
function apaName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  // We assume the last word is the surname. That's wrong for names like
  // "Ludwig van Beethoven", which is one reason the citation is only a draft.
  const surname = parts.pop();
  const initials = parts.map((part) => `${part[0].toUpperCase()}.`).join(" ");
  return initials ? `${surname}, ${initials}` : `${surname}`;
}

/** Builds a draft APA 7 citation from the fields OpenAlex gives us. */
function formatApaCitation(work: Work): string {
  const names = authorNames(work).map(apaName);

  // APA lists up to 20 authors. Beyond that: first 19, an ellipsis, then the last.
  let authors: string;
  if (names.length > 20) {
    authors = `${names.slice(0, 19).join(", ")}, ... ${names.at(-1)}`;
  } else if (names.length > 1) {
    authors = `${names.slice(0, -1).join(", ")}, & ${names.at(-1)}`;
  } else {
    authors = names[0] ?? "Unknown author";
  }

  const { volume, issue, first_page, last_page } = work.biblio ?? {};
  let journal = work.primary_location?.source?.display_name ?? "";
  if (journal && volume) journal += `, ${volume}${issue ? `(${issue})` : ""}`;
  if (journal && first_page) {
    journal += `, ${first_page}${last_page ? `–${last_page}` : ""}`;
  }

  // Titles ending in "?" or "!" don't take a period after them.
  const title = work.title ?? "Untitled";

  return [
    `${authors} (${work.publication_year ?? "n.d."}).`,
    /[.?!]$/.test(title) ? title : `${title}.`,
    journal ? `${journal}.` : "",
    work.doi ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The compact view of a paper used in every list of results.
 *
 * This is one of the most important decisions in an MCP server. Whatever a tool
 * returns goes straight into the model's context window, so a raw OpenAlex
 * record (often thousands of tokens each) would waste it. We return only what
 * the model needs to decide which paper to look at next, and leave abstracts to
 * get_paper.
 */
function toSummary(work: Work) {
  const authors = authorNames(work);
  return {
    id: work.id.replace("https://openalex.org/", ""),
    title: work.title,
    authors: authors.length > 3 ? [...authors.slice(0, 3), "et al."] : authors,
    year: work.publication_year,
    venue: work.primary_location?.source?.display_name ?? null,
    type: work.type,
    cited_by_count: work.cited_by_count,
    doi: work.doi,
    is_open_access: work.open_access.is_oa,
  };
}

// ---------------------------------------------------------------------------
// The four operations, one per MCP tool.
// ---------------------------------------------------------------------------

export interface SearchOptions {
  query: string;
  sort: "relevance" | "citations" | "newest";
  limit: number;
  fromYear?: number;
  toYear?: number;
  openAccessOnly?: boolean;
}

export async function searchPapers(options: SearchOptions) {
  const { query, sort, limit, fromYear, toYear, openAccessOnly } = options;

  // OpenAlex filters look like "field:value,field:value", so commas and pipes
  // in the user's query would be read as syntax. Double quotes stay, because
  // they're how you search for an exact phrase.
  const cleanQuery = query.replace(/[,|]/g, " ").trim();

  // We search titles and abstracts rather than OpenAlex's plain `search`
  // parameter, which also matches full text and returns far more noise.
  const filters = [`title_and_abstract.search:${cleanQuery}`];
  if (fromYear) filters.push(`from_publication_date:${fromYear}-01-01`);
  if (toYear) filters.push(`to_publication_date:${toYear}-12-31`);
  if (openAccessOnly) filters.push("open_access.is_oa:true");

  // Why not just ask OpenAlex to sort by citations? Because the search matches
  // loosely: a paper can match on a single word. When we tried sorting
  // "four phase interest development" by citations, the top results were liver
  // disease guidelines, since famous papers in any field beat relevant ones.
  //
  // So we always ask for the most *relevant* papers, then re-rank that pool
  // ourselves. The result is "the most cited of the relevant papers", which is
  // what a literature review actually wants.
  const data = await openAlexGet<{ meta: { count: number }; results: Work[] }>("/works", {
    filter: filters.join(","),
    sort: "relevance_score:desc",
    "per-page": String(sort === "relevance" ? limit : RERANK_POOL_SIZE),
    select: SUMMARY_FIELDS,
  });

  const works = [...data.results];
  if (sort === "citations") {
    works.sort((a, b) => b.cited_by_count - a.cited_by_count);
  } else if (sort === "newest") {
    works.sort((a, b) => (b.publication_year ?? 0) - (a.publication_year ?? 0));
  }

  return {
    total_matches: data.meta.count,
    results: works.slice(0, limit).map(toSummary),
  };
}

export async function getPaper(id: string) {
  const work = await openAlexGet<Work>(`/works/${normalizeId(id)}`, {
    select: `${SUMMARY_FIELDS},biblio,abstract_inverted_index,referenced_works_count`,
  });

  return {
    ...toSummary(work),
    authors: authorNames(work), // the full list here, not the shortened one
    abstract: rebuildAbstract(work.abstract_inverted_index),
    references_count: work.referenced_works_count ?? 0,
    citation_apa_draft: formatApaCitation(work),
  };
}

export interface CitationOptions {
  id: string;
  direction: "cited_by" | "references";
  limit: number;
  fromYear?: number;
}

export async function getCitations({ id, direction, limit, fromYear }: CitationOptions) {
  // Citation filters only accept OpenAlex IDs, and the caller may have given us
  // a DOI. So we look the paper up first, which is free.
  const paper = await openAlexGet<Pick<Work, "id" | "title">>(`/works/${normalizeId(id)}`, {
    select: "id,title",
  });
  const shortId = paper.id.replace("https://openalex.org/", "");

  // The two filter names are easy to mix up, and they read backwards:
  //   cites:W1     = "papers that cite W1"   (later work that built on it)
  //   cited_by:W1  = "papers W1 cites"       (its reference list)
  const filters = [direction === "cited_by" ? `cites:${shortId}` : `cited_by:${shortId}`];
  if (fromYear) filters.push(`from_publication_date:${fromYear}-01-01`);

  // Unlike in searchPapers, sorting by citations on the server is safe here:
  // every result is linked to this paper, so all of them are relevant.
  const data = await openAlexGet<{ meta: { count: number }; results: Work[] }>("/works", {
    filter: filters.join(","),
    sort: "cited_by_count:desc",
    "per-page": String(limit),
    select: SUMMARY_FIELDS,
  });

  return {
    paper: { id: shortId, title: paper.title },
    direction,
    total: data.meta.count,
    results: data.results.map(toSummary),
  };
}

export async function findOpenPdf(id: string) {
  const work = await openAlexGet<Work>(`/works/${normalizeId(id)}`, {
    select: "id,title,doi,open_access,best_oa_location,locations",
  });

  // A paper can live in several places: the publisher, a university repository,
  // a preprint server. The "best" location is often a web page with no direct
  // PDF, so if it has none we check the other open copies too.
  const best = work.best_oa_location ?? null;
  const withPdf = [best, ...(work.locations ?? [])].find((l) => l?.is_oa && l.pdf_url);
  const chosen = withPdf ?? best;

  return {
    id: work.id.replace("https://openalex.org/", ""),
    title: work.title,
    is_open_access: work.open_access.is_oa,
    oa_status: work.open_access.oa_status,
    pdf_url: withPdf?.pdf_url ?? null,
    read_online_url: work.open_access.oa_url ?? chosen?.landing_page_url ?? null,
    host: chosen?.source?.display_name ?? null,
    license: chosen?.license ?? null,
    version: chosen?.version ?? null,
    publisher_page: work.doi,
  };
}
