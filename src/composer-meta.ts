import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { ConversationMeta } from './types.js';

function getStateDbPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  if (process.platform === 'win32') {
    return join(homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  return join(homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

function findSqlite3(): string | null {
  const candidates = ['sqlite3', '/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3'];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return bin;
    } catch { /* not found */ }
  }
  return null;
}

export function loadComposerMetadata(): Map<string, ConversationMeta> {
  const metaMap = new Map<string, ConversationMeta>();
  const dbPath = getStateDbPath();

  if (!existsSync(dbPath)) return metaMap;

  const sqlite3 = findSqlite3();
  if (!sqlite3) {
    console.error('[cursor-chat-browser] sqlite3 CLI not found — skipping composer metadata enrichment');
    return metaMap;
  }

  try {
    const sql = `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND length(value) > 100;`;
    const output = execFileSync(sqlite3, ['-json', dbPath, sql], {
      maxBuffer: 200 * 1024 * 1024,
      timeout: 60000,
      encoding: 'utf-8',
    });

    let rows: Array<{ key: string; value: string }>;
    try {
      rows = JSON.parse(output);
    } catch {
      return metaMap;
    }

    for (const row of rows) {
      try {
        const data = JSON.parse(row.value);
        const composerId = data.composerId as string;
        if (!composerId) continue;

        let userText = (data.text as string) ?? '';
        if (!userText && data.richText) {
          try {
            const rich = JSON.parse(data.richText);
            userText = extractTextFromLexical(rich);
          } catch { /* ignore */ }
        }

        metaMap.set(composerId, {
          composerId,
          createdAt: (data.createdAt as number) ?? null,
          mode: (data.unifiedMode as string) ?? (data.forceMode as string) ?? null,
          branch: (data.createdOnBranch as string) ?? null,
          status: (data.status as string) ?? null,
          isAgentic: Boolean(data.isAgentic),
          text: userText,
        });
      } catch {
        // skip unparseable entries
      }
    }
  } catch (err) {
    console.error(`[cursor-chat-browser] Failed to read state.vscdb via sqlite3 CLI: ${err}`);
  }

  return metaMap;
}

function extractTextFromLexical(root: unknown): string {
  if (!root || typeof root !== 'object') return '';
  const node = root as Record<string, unknown>;

  if (node.type === 'text' && typeof node.text === 'string') {
    return node.text;
  }

  if (Array.isArray(node.children)) {
    return node.children.map(extractTextFromLexical).join('');
  }

  if (node.root) {
    return extractTextFromLexical(node.root);
  }

  return '';
}
