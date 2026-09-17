#!/usr/bin/env node
/**
 * local-memory-mcp — Persistent local memory for any MCP client.
 *
 * Works with Claude Desktop, Claude Code, Cursor, Codex, Continue, and any
 * other MCP-compatible client. Talks stdio, stores everything in a single
 * SQLite file on your machine. No cloud, no API keys.
 *
 * CRITICAL: we use the low-level MCP Server with setRequestHandler, NOT the
 * high-level McpServer.registerTool — because the high-level path has known
 * issues with JSON Schema in HTTP/OAuth modes.
 *
 * CRITICAL: all logging goes to stderr. stdout is reserved for JSON-RPC.
 */

// Very first: announce we're alive on stderr, BEFORE any other import.
process.stderr.write('[local-memory] boot: node ' + process.version + '\n');

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { logger } from './lib/logger.js';
import { closeDb, getDb } from './db/client.js';
import { backfillEmbeddings } from './db/vector.js';
import { getHandler, toMcpToolList, TOOLS } from './tools/registry.js';
import { INSTRUCTIONS } from './instructions.js';

const SERVER_NAME = 'local-memory-mcp';
// Read from package.json instead of a hardcoded literal — the literal sat at
// 2.3.0 through the 2.4.0 release, so the MCP handshake advertised a stale
// version to every client.
//
// The lookup probes TWO locations because the module ships in two layouts:
// npm tarball / repo have package.json one level above dist|src, the MCPB
// bundle has the code under server/ with package.json at the bundle root
// (copied there by build-mcpb.sh) — same '../package.json', but a first
// 2.4.1 iteration of this read crashed the bundle at import time because the
// file was not copied. A version string must never be able to kill the boot:
// on total failure we advertise 0.0.0 and log, instead of throwing.
const SERVER_VERSION: string = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, '../package.json'), join(here, 'package.json')]) {
    try {
      const version = JSON.parse(readFileSync(candidate, 'utf-8')).version;
      if (typeof version === 'string' && version.length > 0) return version;
    } catch {
      // try the next location
    }
  }
  process.stderr.write('[local-memory] warn: package.json not found next to the module — advertising 0.0.0\n');
  return '0.0.0';
})();

process.stderr.write('[local-memory] imports loaded, bootstrapping db…\n');

async function main(): Promise<void> {
  // F6 fix (Critic R1): if the embedding pipeline is in mock mode in
  // production, make it loud. The mock returns deterministic FNV-1a token
  // hashes — structurally valid 384-dim vectors, semantically nonsense. A
  // user who accidentally exported MEMORY_EMBED_MOCK=1 (e.g. from a stale
  // .bashrc after debugging) would otherwise build up a corpus of garbage
  // embeddings without ever seeing an error. The warning is loud and
  // explicit so it surfaces on every startup until the env var is removed.
  if (process.env.MEMORY_EMBED_MOCK === '1') {
    process.stderr.write(
      '[local-memory] WARNING: MEMORY_EMBED_MOCK=1 is active — embeddings are deterministic token hashes, NOT semantic vectors. Do not use this in production. Unset the variable to enable the real model.\n'
    );
  }

  // Bootstrap the DB early so any schema errors surface before we announce ready.
  try {
    getDb();
    logger.info('Database ready');
    process.stderr.write('[local-memory] database ready\n');
  } catch (err) {
    logger.logError('Database init failed', err);
    process.stderr.write('[local-memory] database init failed: ' + (err instanceof Error ? err.stack ?? err.message : String(err)) + '\n');
    process.exit(1);
  }

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toMcpToolList(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = getHandler(name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown tool: ${name}` }, null, 2) }],
        isError: true,
      };
    }

    // Zod validation
    const parsed = tool.schema.safeParse(args ?? {});
    if (!parsed.success) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: 'Validation failed',
            details: parsed.error.flatten(),
          }, null, 2),
        }],
        isError: true,
      };
    }

    try {
      const result = await tool.handler(parsed.data);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !result.success,
      };
    } catch (err) {
      logger.logError(`Tool ${name} threw`, err);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: err instanceof Error ? err.message : String(err),
            code: 'HANDLER_THREW',
          }, null, 2),
        }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info(`${TOOLS.length} tools registered (stdio)`);
  process.stderr.write('[local-memory] ready — ' + TOOLS.length + ' tools on stdio\n');

  // Re-embedding a whole store takes minutes, so it runs after the handshake; until then vector search lacks those entries.
  backfillEmbeddings(getDb()).then(
    (n) => {
      if (n > 0) process.stderr.write(`[local-memory] embedded ${n} entries in the background\n`);
    },
    (err) => logger.logError('Background embedding failed; the next boot retries it', err)
  );
}

// Catch ANY unhandled error that could silently kill us — Claude Desktop
// reports "Server transport closed unexpectedly" when we die without logging.
process.on('uncaughtException', (err) => {
  process.stderr.write('[local-memory] uncaughtException: ' + (err.stack ?? err.message) + '\n');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write('[local-memory] unhandledRejection: ' + String(reason) + '\n');
  process.exit(1);
});

// Graceful shutdown
const gracefulExit = (): void => {
  try { closeDb(); } catch { /* ignore */ }
  process.exit(0);
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, gracefulExit);
}
process.stdin.on('end', gracefulExit);
process.stdin.on('close', gracefulExit);

main().catch((err) => {
  process.stderr.write('[local-memory] main() rejected: ' + (err instanceof Error ? err.stack ?? err.message : String(err)) + '\n');
  logger.logError('Fatal', err);
  process.exit(1);
});
