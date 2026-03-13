#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadAllTranscripts } from './transcripts.js';
import { loadComposerMetadata } from './composer-meta.js';
import { SearchIndex } from './search-index.js';

const SERVER_NAME = 'cursor-chat-browser';
const SERVER_VERSION = '0.0.1';

async function main() {
  const startTime = Date.now();

  const index = await SearchIndex.create();
  const existingIds = index.getIndexedIds();
  const transcripts = loadAllTranscripts(existingIds);

  const indexed = index.indexConversations(transcripts);
  const stats = index.stats();
  const elapsed = Date.now() - startTime;

  // Enrich with composer metadata in the background (state.vscdb is large)
  if (transcripts.length > 0) {
    setImmediate(() => {
      try {
        const composerMeta = loadComposerMetadata();
        index.enrichMetadata(composerMeta);
      } catch { /* non-critical */ }
    });
  }

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: `Cursor Chat Browser — search and retrieve past Cursor AI conversations across all workspaces.

Index: ${stats.totalConversations} conversations, ${stats.totalMessages} messages across ${stats.workspaceCount} workspaces (indexed ${indexed} new in ${elapsed}ms).

Use search_conversations to find past discussions by keyword. Use get_conversation to retrieve full conversation content. Use list_workspaces to see all indexed workspaces.

Proactively search past conversations when working on complex tasks — previous discussions may contain relevant decisions, patterns, or context.`,
    }
  );

  server.registerTool(
    'search_conversations',
    {
      title: 'Search Past Conversations',
      description:
        'Search through past Cursor AI conversations across all workspaces using full-text search. Returns matching conversations ranked by relevance. Use this to find previous discussions about a topic, decisions made, or implementations discussed.',
      inputSchema: z.object({
        query: z.string().describe('Search query — keywords, function names, concepts, or phrases'),
        workspace: z
          .string()
          .optional()
          .describe('Filter to a specific workspace/project name (partial match)'),
        limit: z
          .number()
          .optional()
          .default(10)
          .describe('Maximum number of results to return (default: 10)'),
      }),
    },
    async ({ query, workspace, limit }) => {
      const results = index.search(query, { workspace, limit });

      if (results.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No conversations found for query: "${query}"${workspace ? ` in workspace "${workspace}"` : ''}`,
            },
          ],
        };
      }

      const lines = results.map((r) => {
        const date = r.createdAt ? new Date(r.createdAt).toISOString().split('T')[0] : 'unknown';
        return [
          `### ${r.rank}. ${r.title}`,
          `- **ID:** ${r.id}`,
          `- **Workspace:** ${r.workspace}`,
          `- **Date:** ${date} | **Mode:** ${r.mode ?? 'unknown'} | **Messages:** ${r.messageCount}`,
          `- **Preview:** ${r.snippet}`,
        ].join('\n');
      });

      return {
        content: [
          {
            type: 'text',
            text: `Found ${results.length} conversation(s) for "${query}":\n\n${lines.join('\n\n')}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    'get_conversation',
    {
      title: 'Get Conversation',
      description:
        'Retrieve the full content of a specific past conversation by its ID. Use after search_conversations to read the full discussion.',
      inputSchema: z.object({
        id: z.string().describe('Conversation UUID (from search_conversations results)'),
        max_length: z
          .number()
          .optional()
          .default(10000)
          .describe('Maximum character length of returned text (default: 10000). Truncates from the end.'),
      }),
    },
    async ({ id, max_length }) => {
      const conv = index.getConversation(id);

      if (!conv) {
        return { content: [{ type: 'text', text: `Conversation not found: ${id}` }] };
      }

      const date = conv.createdAt ? new Date(conv.createdAt).toISOString() : 'unknown';
      let text = conv.fullText;
      let truncated = false;
      if (text.length > max_length) {
        text = text.slice(0, max_length);
        truncated = true;
      }

      const header = [
        `# ${conv.title}`,
        `**Workspace:** ${conv.workspace} (${conv.workspacePath})`,
        `**Date:** ${date} | **Mode:** ${conv.mode ?? 'unknown'} | **Branch:** ${conv.branch ?? 'unknown'} | **Messages:** ${conv.messageCount}`,
        truncated ? `\n> Truncated to ${max_length} chars. Increase max_length to see more.\n` : '',
        '---',
      ].join('\n');

      return { content: [{ type: 'text', text: `${header}\n\n${text}` }] };
    }
  );

  server.registerTool(
    'list_workspaces',
    {
      title: 'List Workspaces',
      description:
        'List all workspaces that have indexed conversations, with conversation counts. Useful for discovering which projects have past discussions.',
      inputSchema: z.object({}),
    },
    async () => {
      const workspaces = index.listWorkspaces();
      const statsData = index.stats();

      const lines = workspaces.map(
        (w) => `- **${w.workspace}** — ${w.conversationCount} conversation(s) (${w.workspacePath})`
      );

      return {
        content: [
          {
            type: 'text',
            text: [
              `## Indexed Workspaces (${statsData.workspaceCount})`,
              `Total: ${statsData.totalConversations} conversations, ${statsData.totalMessages} messages`,
              '',
              ...lines,
            ].join('\n'),
          },
        ],
      };
    }
  );

  server.registerTool(
    'recent_conversations',
    {
      title: 'Recent Conversations',
      description:
        'Get the most recent conversations, optionally filtered by workspace. Useful for getting quick context on recent work.',
      inputSchema: z.object({
        workspace: z
          .string()
          .optional()
          .describe('Filter to a specific workspace/project name (partial match)'),
        limit: z
          .number()
          .optional()
          .default(10)
          .describe('Number of recent conversations to return (default: 10)'),
      }),
    },
    async ({ workspace, limit }) => {
      const results = index.search('', { workspace, limit });

      if (results.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: workspace
                ? `No conversations found in workspace "${workspace}"`
                : 'No conversations indexed yet.',
            },
          ],
        };
      }

      const lines = results.map((r) => {
        const date = r.createdAt ? new Date(r.createdAt).toISOString().split('T')[0] : 'unknown';
        return `- **[${date}]** ${r.title} — ${r.workspace} (${r.messageCount} msgs) [ID: ${r.id}]`;
      });

      return {
        content: [
          {
            type: 'text',
            text: `## Recent Conversations\n\n${lines.join('\n')}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    'reindex',
    {
      title: 'Reindex Conversations',
      description:
        'Re-scan all workspaces and index any new conversations that appeared since the server started.',
      inputSchema: z.object({}),
    },
    async () => {
      const fresh = loadAllTranscripts(index.getIndexedIds());
      const meta = loadComposerMetadata();

      for (const conv of fresh) {
        const m = meta.get(conv.id);
        if (m) {
          if (m.createdAt) conv.createdAt = m.createdAt;
          if (m.mode) conv.mode = m.mode;
          if (m.branch) conv.branch = m.branch;
        }
      }

      const newCount = index.indexConversations(fresh);
      const newStats = index.stats();

      return {
        content: [
          {
            type: 'text',
            text: `Reindexed: ${newCount} new conversations added. Total: ${newStats.totalConversations} conversations, ${newStats.totalMessages} messages across ${newStats.workspaceCount} workspaces.`,
          },
        ],
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('cursor-chat-browser error:', err);
  process.exit(1);
});
