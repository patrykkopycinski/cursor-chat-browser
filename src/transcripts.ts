import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Conversation, Message } from './types.js';

const PROJECTS_DIR = join(homedir(), '.cursor', 'projects');

function resolveWorkspaceKey(key: string): { name: string; path: string } {
  // Keys like "Users-patrykkopycinski-Projects-agent-skills-sandbox"
  // represent path: /Users/patrykkopycinski/Projects/agent-skills-sandbox
  // The separator is `-` but folder names can also contain `-`.
  // Strategy: reconstruct by greedily matching longest existing path segments.
  const segments = key.split('-');
  const resolvedParts: string[] = [];
  let i = 0;

  while (i < segments.length) {
    // Try longest possible segment first (greedy)
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

  const fullPath = '/' + resolvedParts.join('/');

  // Extract a human-friendly name (last meaningful directory components)
  const projectsIdx = resolvedParts.indexOf('Projects');
  const name =
    projectsIdx >= 0 && projectsIdx + 1 < resolvedParts.length
      ? resolvedParts.slice(projectsIdx + 1).join('/')
      : resolvedParts.slice(-1)[0] ?? key;

  return { name, path: fullPath };
}

function parseTranscriptFile(filePath: string): Message[] {
  const messages: Message[] = [];
  try {
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const role = entry.role as string;
        if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue;

        let text = '';
        if (entry.message?.content) {
          for (const block of entry.message.content) {
            if (block.type === 'text' && block.text) {
              text += block.text + '\n';
            }
          }
        }
        if (text.trim()) {
          messages.push({ role: role as Message['role'], text: text.trim() });
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // skip unreadable files
  }
  return messages;
}

function extractTitle(messages: Message[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return '(no title)';

  let text = firstUser.text;

  // Strip Cursor wrapper tags
  const userQueryMatch = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  if (userQueryMatch) {
    text = userQueryMatch[1]!;
  }
  text = text.replace(/<(?:system_reminder|user_info|git_status|open_and_recently_viewed_files|rules|agent_skills|agent_transcripts)[^>]*>[\s\S]*?<\/[^>]+>/g, '');

  const title = text.replace(/\s+/g, ' ').trim();
  if (!title) return '(no title)';
  return title.length > 120 ? title.slice(0, 117) + '...' : title;
}

export function loadAllTranscripts(skipIds?: Set<string>): Conversation[] {
  const conversations: Conversation[] = [];

  if (!existsSync(PROJECTS_DIR)) return conversations;

  for (const wsDir of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!wsDir.isDirectory()) continue;

    const transcriptsDir = join(PROJECTS_DIR, wsDir.name, 'agent-transcripts');
    if (!existsSync(transcriptsDir)) continue;

    const workspaceKey = wsDir.name;
    const { name: workspace, path: workspacePath } = resolveWorkspaceKey(workspaceKey);

    for (const agentDir of readdirSync(transcriptsDir, { withFileTypes: true })) {
      if (!agentDir.isDirectory()) continue;

      const agentId = agentDir.name;
      if (skipIds?.has(agentId)) continue;

      const jsonlPath = join(transcriptsDir, agentId, `${agentId}.jsonl`);
      if (!existsSync(jsonlPath)) continue;

      const messages = parseTranscriptFile(jsonlPath);
      if (messages.length === 0) continue;

      const title = extractTitle(messages);

      let createdAt: number | null = null;
      try {
        createdAt = statSync(jsonlPath).mtimeMs;
      } catch { /* ignore */ }

      conversations.push({
        id: agentId,
        workspace,
        workspacePath,
        title,
        firstMessage: messages[0]?.text ?? '',
        messages,
        createdAt,
        mode: null,
        branch: null,
        messageCount: messages.length,
      });
    }
  }

  return conversations;
}
