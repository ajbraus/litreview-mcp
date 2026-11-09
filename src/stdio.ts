// stdio.ts: runs the server locally.
//
// A "transport" is how messages travel between client and server. With stdio,
// the client (Claude Code, say) launches this file as a child process and they
// exchange JSON messages over stdin and stdout, so no network is involved.
//
// One rule to remember: never console.log() in a stdio server. stdout is the
// message channel, so a stray log corrupts the protocol and the connection
// fails. Use console.error() for debugging, because stderr is left alone.

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.js";

serveStdio(createServer);
