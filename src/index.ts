#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadAllTranscripts } from './transcripts.js';
import { loadComposerMetadata } from './composer-meta.js';
import { SearchIndex } from './search-index.js';

const SERVER_NAME = 'cursor-chat-browser';
const SERVER_VERSION = '0.0.2';

async function main() {
  const startTime = Date.now();

  const index = await SearchIndex.create();
  const existingIds = index.getIndexedIds();
  const transcripts = loadAllTranscripts(existingIds);

  const indexed = index.indexConversations(transcripts);
  const stats = index.stats();
  const elapsed = Date.now() - startTime;

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

Use search_messages to find specific messages by keyword (returns the exact matching messages with surrounding context). Use search_conversations to find conversations by title. Use get_conversation to retrieve full conversation content, optionally filtered to matching messages.

Proactively search past conversations when working on complex tasks — previous discussions may contain relevant decisions, patterns, or context.`,
    }
  );

  server.registerTool(
    'search_messages',
    {
      title: 'Search Messages',
      description:
        'Search through individual messages across all past conversations. Returns the exact matching messages with surrounding context — much more precise than conversation-level search. Use this as the primary search tool to find specific discussions, fixes, decisions, or code changes.',
      inputSchema: z.object({
        query: z.string().describe('Search query — keywords, function names, error messages, concepts'),
        workspace: z
          .string()
          .optional()
          .describe('Filter to a specific workspace/project name (partial match)'),
        limit: z
          .number()
          .optional()
          .default(10)
          .describe('Maximum number of matching messages to return (default: 10)'),
        context_messages: z
          .number()
          .optional()
          .default(2)
          .describe('Number of surrounding messages to include for context (default: 2)'),
      }),
    },
    async ({ query, workspace, limit, context_messages }) => {
      const results = index.searchMessages(query, { workspace, limit, contextMessages: context_messages });

      if (results.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No messages found for query: "${query}"${workspace ? ` in workspace "${workspace}"` : ''}`,
            },
          ],
        };
      }

      const lines = results.map((r, i) => {
        const date = r.createdAt ? new Date(r.createdAt).toISOString().split('T')[0] : 'unknown';
        const contextBefore = r.context
          .filter((c) => c.index < r.messageIndex)
          .map((c) => `  > [${c.role}] ${c.snippet}`)
          .join('\n');
        const contextAfter = r.context
          .filter((c) => c.index > r.messageIndex)
          .map((c) => `  > [${c.role}] ${c.snippet}`)
          .join('\n');

        return [
          `### ${i + 1}. Match in "${r.conversationTitle}"`,
          `- **Conversation:** ${r.conversationId}`,
          `- **Workspace:** ${r.workspace} | **Date:** ${date} | **Message #${r.messageIndex}** (${r.role})`,
          '',
          contextBefore ? `${contextBefore}\n` : '',
          `  **>>> [${r.role}] ${r.matchSnippet}**`,
          '',
          contextAfter || '',
        ]
          .filter(Boolean)
          .join('\n');
      });

      return {
        content: [
          {
            type: 'text',
            text: `Found ${results.length} matching message(s) for "${query}":\n\n${lines.join('\n\n---\n\n')}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    'search_conversations',
    {
      title: 'Search Conversations by Title',
      description:
        'Search conversations by title/topic. Returns conversation-level results. For finding specific messages or content within conversations, use search_messages instead.',
      inputSchema: z.object({
        query: z.string().describe('Search query — keywords or phrases to match against conversation titles'),
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
        'Retrieve a conversation by ID. Optionally search within it to get only matching messages instead of the full transcript.',
      inputSchema: z.object({
        id: z.string().describe('Conversation UUID (from search results)'),
        search: z
          .string()
          .optional()
          .describe('Optional search query to filter to matching messages within this conversation. When provided, returns only relevant messages with context instead of the full transcript.'),
        max_messages: z
          .number()
          .optional()
          .default(50)
          .describe('Maximum number of messages to return (default: 50). Applies to both full retrieval and search-filtered results.'),
      }),
    },
    async ({ id, search, max_messages }) => {
      const conv = index.getConversation(id);

      if (!conv) {
        return { content: [{ type: 'text', text: `Conversation not found: ${id}` }] };
      }

      const date = conv.createdAt ? new Date(conv.createdAt).toISOString() : 'unknown';
      const header = [
        `# ${conv.title}`,
        `**Workspace:** ${conv.workspace} (${conv.workspacePath})`,
        `**Date:** ${date} | **Mode:** ${conv.mode ?? 'unknown'} | **Branch:** ${conv.branch ?? 'unknown'} | **Messages:** ${conv.messageCount}`,
        '---',
      ].join('\n');

      if (search?.trim()) {
        const matches = index.searchInConversation(id, search, { limit: max_messages, contextMessages: 2 });

        if (matches.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `${header}\n\nNo messages matching "${search}" found in this conversation.`,
              },
            ],
          };
        }

        const matchLines = matches.map((m) => {
          const contextBefore = m.context
            .filter((c) => c.index < m.index)
            .map((c) => `  > [msg #${c.index} - ${c.role}] ${c.snippet}`)
            .join('\n');
          const contextAfter = m.context
            .filter((c) => c.index > m.index)
            .map((c) => `  > [msg #${c.index} - ${c.role}] ${c.snippet}`)
            .join('\n');

          return [
            contextBefore || '',
            `  **>>> [msg #${m.index} - ${m.role}] ${m.matchSnippet}**`,
            contextAfter || '',
          ]
            .filter(Boolean)
            .join('\n');
        });

        return {
          content: [
            {
              type: 'text',
              text: `${header}\n\nFound ${matches.length} message(s) matching "${search}":\n\n${matchLines.join('\n\n---\n\n')}`,
            },
          ],
        };
      }

      // Full conversation retrieval
      const messages = conv.messages.slice(0, max_messages);
      const truncated = conv.messages.length > max_messages;

      const messageLines = messages.map(
        (m) => `[msg #${m.index} - ${m.role}]\n${m.text}`
      );

      const body = messageLines.join('\n\n');
      const truncNote = truncated
        ? `\n> Showing ${max_messages} of ${conv.messages.length} messages. Increase max_messages to see more.\n`
        : '';

      return { content: [{ type: 'text', text: `${header}${truncNote}\n\n${body}` }] };
    }
  );

  server.registerTool(
    'list_workspaces',
    {
      title: 'List Workspaces',
      description:
        'List all workspaces that have indexed conversations, with conversation counts.',
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
        'Get the most recent conversations, optionally filtered by workspace.',
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
        'Re-scan all workspaces and index any new conversations. Also rebuilds the message-level search index.',
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
