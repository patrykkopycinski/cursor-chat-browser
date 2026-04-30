import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Conversation, Message } from './types.js';
import { stripContextTags } from './utils.js';

const CLAUDE_DIR = join(homedir(), '.claude');
const CLAUDE_PROJECTS_DIR = join(CLAUDE_DIR, 'projects');
const CLAUDE_HISTORY_PATH = join(CLAUDE_DIR, 'history.jsonl');

function loadHistoryTitles(): Map<string, string> {
  const titles = new Map<string, string>();
  if (!existsSync(CLAUDE_HISTORY_PATH)) return titles;

  try {
    const content = readFileSync(CLAUDE_HISTORY_PATH, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { display?: string; sessionId?: string };
        // First entry for each sessionId = first user prompt = best title
        if (entry.sessionId && entry.display && !titles.has(entry.sessionId)) {
          titles.set(entry.sessionId, entry.display);
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  return titles;
}

interface ParsedTranscript {
  messages: Message[];
  cwd: string | null;
  sessionId: string | null;
  createdAt: number | null;
  branch: string | null;
}

function parseClaudeTranscriptFile(filePath: string): ParsedTranscript {
  const messages: Message[] = [];
  let cwd: string | null = null;
  let sessionId: string | null = null;
  let createdAt: number | null = null;
  let branch: string | null = null;

  try {
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as {
          type?: string;
          message?: { content?: Array<{ type: string; text?: string }> };
          timestamp?: string;
          cwd?: string;
          sessionId?: string;
          gitBranch?: string;
        };

        if (entry.type !== 'user' && entry.type !== 'assistant') continue;

        if (entry.type === 'user') {
          if (!cwd && entry.cwd) cwd = entry.cwd;
          if (!sessionId && entry.sessionId) sessionId = entry.sessionId;
          if (!branch && entry.gitBranch) branch = entry.gitBranch;
          if (!createdAt && entry.timestamp) {
            const ts = new Date(entry.timestamp).getTime();
            if (!isNaN(ts)) createdAt = ts;
          }
        }

        let text = '';
        if (entry.message?.content) {
          for (const block of entry.message.content) {
            if (block.type === 'text' && block.text) {
              text += block.text + '\n';
            }
          }
        }

        if (text.trim()) {
          messages.push({ role: entry.type as 'user' | 'assistant', text: text.trim() });
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* skip unreadable files */ }

  return { messages, cwd, sessionId, createdAt, branch };
}

function extractTitle(messages: Message[], historyTitle: string | undefined): string {
  const raw = historyTitle ?? stripContextTags(messages.find((m) => m.role === 'user')?.text ?? '');
  const title = raw.replace(/\s+/g, ' ').trim();
  if (!title) return '(no title)';
  return title.length > 120 ? title.slice(0, 117) + '...' : title;
}

function workspaceNameFromPath(cwd: string): string {
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function loadClaudeTranscripts(skipIds?: Set<string>): Conversation[] {
  const conversations: Conversation[] = [];
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return conversations;

  const historyTitles = loadHistoryTitles();

  for (const projectDir of readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue;

    const projectPath = join(CLAUDE_PROJECTS_DIR, projectDir.name);

    for (const entry of readdirSync(projectPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;

      // Claude names the file after the session id, so filename stem === sessionId in practice.
      const fileSessionId = entry.name.replace(/\.jsonl$/, '');
      const id = `claude:${fileSessionId}`;
      if (skipIds?.has(id)) continue;

      const jsonlPath = join(projectPath, entry.name);
      const { messages, cwd, sessionId: parsedSessionId, createdAt, branch } =
        parseClaudeTranscriptFile(jsonlPath);

      if (messages.length === 0) continue;

      const workspacePath = cwd ?? '';
      const workspace = workspacePath ? workspaceNameFromPath(workspacePath) : projectDir.name;
      // Use unprefixed id for history.jsonl lookup (it stores bare session ids).
      const actualSessionId = parsedSessionId ?? fileSessionId;
      const title = extractTitle(messages, historyTitles.get(actualSessionId));

      let fileCreatedAt = createdAt;
      if (!fileCreatedAt) {
        try { fileCreatedAt = statSync(jsonlPath).mtimeMs; } catch { /* ignore */ }
      }

      conversations.push({
        id,
        workspace,
        workspacePath,
        title,
        firstMessage: stripContextTags(messages[0]?.text ?? ''),
        messages,
        createdAt: fileCreatedAt,
        mode: null,
        branch,
        messageCount: messages.length,
        source: 'claude',
      });
    }
  }

  return conversations;
}
