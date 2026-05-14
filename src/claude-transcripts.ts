import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Conversation, Message } from './types.js';
import { stripContextTags } from './utils.js';

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// Subagent transcripts (spawned by the Task tool) live alongside interactive
// sessions but are not user conversations. Filename pattern: agent-<hex>.jsonl
const SUBAGENT_FILE_PATTERN = /^agent-[a-f0-9]+\.jsonl$/;

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
          message?: { content?: Array<{ type: string; text?: string }> | string };
          timestamp?: string;
          cwd?: string;
          sessionId?: string;
          gitBranch?: string;
        };

        // Metadata can appear on any entry type (system, summary, user, assistant).
        // Sessions resumed with --continue may have an assistant entry first.
        if (!cwd && entry.cwd) cwd = entry.cwd;
        if (!sessionId && entry.sessionId) sessionId = entry.sessionId;
        if (!branch && entry.gitBranch) branch = entry.gitBranch;
        if (!createdAt && entry.timestamp) {
          const ts = new Date(entry.timestamp).getTime();
          if (!isNaN(ts)) createdAt = ts;
        }

        if (entry.type !== 'user' && entry.type !== 'assistant') continue;

        let text = '';
        const messageContent = entry.message?.content;
        if (typeof messageContent === 'string') {
          text = messageContent;
        } else if (Array.isArray(messageContent)) {
          for (const block of messageContent) {
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

function extractTitle(messages: Message[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  const raw = stripContextTags(firstUser?.text ?? '');
  const title = raw.replace(/\s+/g, ' ').trim();
  if (!title) return '(no title)';
  return title.length > 120 ? title.slice(0, 117) + '...' : title;
}

// Claude encodes workspace paths as `-Users-foo-Projects-some-repo`. Dashes
// inside real path segments (e.g. `agent-builder-server`) are indistinguishable
// from path separators, so we greedy-match against the filesystem to recover
// the actual path.
function resolveClaudeWorkspaceKey(key: string): { name: string; path: string } {
  const segments = key.replace(/^-/, '').split('-');
  const resolvedParts: string[] = [];
  let i = 0;

  while (i < segments.length) {
    let matched = false;
    for (let j = segments.length; j > i; j--) {
      const candidate = segments.slice(i, j).join('-');
      const testPath = '/' + [...resolvedParts, candidate].join('/');
      if (existsSync(testPath)) {
        resolvedParts.push(candidate);
        i = j;
        matched = true;
        break;
      }
    }
    if (!matched) {
      resolvedParts.push(segments[i]!);
      i++;
    }
  }

  const resolvedPath = '/' + resolvedParts.join('/');
  const projectsIdx = resolvedParts.indexOf('Projects');
  const name =
    projectsIdx >= 0 && projectsIdx + 1 < resolvedParts.length
      ? resolvedParts.slice(projectsIdx + 1).join('/')
      : resolvedParts[resolvedParts.length - 1] ?? key;

  return { name, path: resolvedPath };
}

function workspaceFromCwd(cwd: string): { name: string; path: string } {
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  const projectsIdx = parts.indexOf('Projects');
  const name =
    projectsIdx >= 0 && projectsIdx + 1 < parts.length
      ? parts.slice(projectsIdx + 1).join('/')
      : parts[parts.length - 1] ?? cwd;
  return { name, path: cwd };
}

export function loadClaudeTranscripts(skipIds?: Set<string>): Conversation[] {
  const conversations: Conversation[] = [];
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return conversations;

  for (const projectDir of readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue;

    const projectPath = join(CLAUDE_PROJECTS_DIR, projectDir.name);

    for (const entry of readdirSync(projectPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;

      // Skip subagent transcripts -- they pollute search results with
      // sub-task chatter that was never part of a human conversation.
      if (SUBAGENT_FILE_PATTERN.test(entry.name)) continue;

      // Claude names the file after the session id, so filename stem === sessionId.
      const fileSessionId = entry.name.replace(/\.jsonl$/, '');
      const id = `claude:${fileSessionId}`;
      if (skipIds?.has(id)) continue;

      const jsonlPath = join(projectPath, entry.name);
      const { messages, cwd, createdAt, branch } = parseClaudeTranscriptFile(jsonlPath);

      if (messages.length === 0) continue;

      // Prefer the cwd recorded in the transcript; fall back to greedy
      // resolution of the encoded directory name when missing.
      const { name: workspace, path: workspacePath } = cwd
        ? workspaceFromCwd(cwd)
        : resolveClaudeWorkspaceKey(projectDir.name);

      const title = extractTitle(messages);

      let fileCreatedAt = createdAt;
      if (!fileCreatedAt) {
        // birthtimeMs reflects when the conversation started, not its last
        // append -- which matches what the "Date" column means everywhere else.
        try { fileCreatedAt = statSync(jsonlPath).birthtimeMs; } catch { /* ignore */ }
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
