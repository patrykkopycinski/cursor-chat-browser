import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import type { Conversation, ConversationMeta, SearchResult } from './types.js';

const INDEX_DIR = join(homedir(), '.cursor', 'chat-browser');
const INDEX_DB_PATH = join(INDEX_DIR, 'search-index.db');

export class SearchIndex {
  private db: SqlJsDatabase;
  private dirty = false;

  private constructor(db: SqlJsDatabase) {
    this.db = db;
  }

  static async create(): Promise<SearchIndex> {
    mkdirSync(INDEX_DIR, { recursive: true });

    const SQL = await initSqlJs();

    let db: SqlJsDatabase;
    if (existsSync(INDEX_DB_PATH)) {
      const buffer = readFileSync(INDEX_DB_PATH);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }

    const instance = new SearchIndex(db);
    instance.init();
    return instance;
  }

  private init() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        title TEXT NOT NULL,
        first_message TEXT NOT NULL,
        full_text TEXT NOT NULL,
        created_at INTEGER,
        mode TEXT,
        branch TEXT,
        message_count INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      )
    `);

    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts4(
        conv_id,
        title,
        full_text,
        workspace,
        tokenize=porter
      )
    `);
  }

  private save() {
    if (!this.dirty) return;
    const data = this.db.export();
    writeFileSync(INDEX_DB_PATH, Buffer.from(data));
    this.dirty = false;
  }

  private query<T>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(sql);
    if (params.length > 0) stmt.bind(params as (string | number | null)[]);

    const results: T[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return results;
  }

  getIndexedIds(): Set<string> {
    const rows = this.query<{ id: string }>('SELECT id FROM conversations');
    return new Set(rows.map((r) => r.id));
  }

  indexConversations(conversations: Conversation[]): number {
    const existing = this.getIndexedIds();
    const toInsert = conversations.filter((c) => !existing.has(c.id));

    if (toInsert.length === 0) return 0;

    this.db.run('BEGIN TRANSACTION');
    try {
      for (const c of toInsert) {
        const fullText = c.messages.map((m) => m.text).join('\n\n');
        this.db.run(
          `INSERT OR REPLACE INTO conversations
            (id, workspace, workspace_path, title, first_message, full_text, created_at, mode, branch, message_count, indexed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            c.id,
            c.workspace,
            c.workspacePath,
            c.title,
            c.firstMessage,
            fullText,
            c.createdAt ? Math.round(c.createdAt) : null,
            c.mode,
            c.branch,
            c.messageCount,
            Date.now(),
          ]
        );
        this.db.run(
          `INSERT INTO conversations_fts (conv_id, title, full_text, workspace) VALUES (?, ?, ?, ?)`,
          [c.id, c.title, fullText, c.workspace]
        );
      }
      this.db.run('COMMIT');
      this.dirty = true;
      this.save();
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }

    return toInsert.length;
  }

  search(queryStr: string, options?: { workspace?: string; limit?: number }): SearchResult[] {
    const limit = options?.limit ?? 20;

    let sql: string;
    const params: (string | number | null)[] = [];

    if (queryStr.trim()) {
      const ftsQuery = queryStr
        .replace(/['"]/g, '')
        .split(/\s+/)
        .filter(Boolean)
        .join(' ');

      if (options?.workspace) {
        sql = `
          SELECT c.id, c.workspace, c.workspace_path, c.title, c.first_message, c.message_count, c.created_at, c.mode
          FROM conversations_fts fts
          JOIN conversations c ON c.id = fts.conv_id
          WHERE conversations_fts MATCH ?
            AND c.workspace LIKE ?
          LIMIT ?
        `;
        params.push(ftsQuery, `%${options.workspace}%`, limit);
      } else {
        sql = `
          SELECT c.id, c.workspace, c.workspace_path, c.title, c.first_message, c.message_count, c.created_at, c.mode
          FROM conversations_fts fts
          JOIN conversations c ON c.id = fts.conv_id
          WHERE conversations_fts MATCH ?
          LIMIT ?
        `;
        params.push(ftsQuery, limit);
      }
    } else {
      if (options?.workspace) {
        sql = `SELECT id, workspace, workspace_path, title, first_message, message_count, created_at, mode
               FROM conversations WHERE workspace LIKE ? ORDER BY created_at DESC LIMIT ?`;
        params.push(`%${options.workspace}%`, limit);
      } else {
        sql = `SELECT id, workspace, workspace_path, title, first_message, message_count, created_at, mode
               FROM conversations ORDER BY created_at DESC LIMIT ?`;
        params.push(limit);
      }
    }

    const rows = this.query<{
      id: string;
      workspace: string;
      workspace_path: string;
      title: string;
      first_message: string;
      message_count: number;
      created_at: number | null;
      mode: string | null;
    }>(sql, params);

    return rows.map((r, i) => ({
      id: r.id,
      workspace: r.workspace,
      workspacePath: r.workspace_path,
      title: r.title,
      snippet: (r.first_message ?? '').slice(0, 300),
      rank: i + 1,
      createdAt: r.created_at,
      mode: r.mode,
      messageCount: r.message_count,
    }));
  }

  getConversation(id: string): {
    id: string;
    workspace: string;
    workspacePath: string;
    title: string;
    fullText: string;
    createdAt: number | null;
    mode: string | null;
    branch: string | null;
    messageCount: number;
  } | null {
    const rows = this.query<{
      id: string;
      workspace: string;
      workspace_path: string;
      title: string;
      full_text: string;
      created_at: number | null;
      mode: string | null;
      branch: string | null;
      message_count: number;
    }>(
      `SELECT id, workspace, workspace_path, title, full_text, created_at, mode, branch, message_count
       FROM conversations WHERE id = ?`,
      [id]
    );

    if (rows.length === 0) return null;
    const row = rows[0]!;

    return {
      id: row.id,
      workspace: row.workspace,
      workspacePath: row.workspace_path,
      title: row.title,
      fullText: row.full_text,
      createdAt: row.created_at,
      mode: row.mode,
      branch: row.branch,
      messageCount: row.message_count,
    };
  }

  listWorkspaces(): Array<{ workspace: string; workspacePath: string; conversationCount: number }> {
    const rows = this.query<{ workspace: string; workspace_path: string; count: number }>(
      `SELECT workspace, workspace_path, COUNT(*) as count
       FROM conversations
       GROUP BY workspace
       ORDER BY count DESC`
    );

    return rows.map((r) => ({
      workspace: r.workspace,
      workspacePath: r.workspace_path,
      conversationCount: r.count,
    }));
  }

  stats(): { totalConversations: number; totalMessages: number; workspaceCount: number } {
    const rows = this.query<{ total: number; msgs: number; ws: number }>(
      `SELECT COUNT(*) as total, SUM(message_count) as msgs, COUNT(DISTINCT workspace) as ws
       FROM conversations`
    );

    const row = rows[0] ?? { total: 0, msgs: 0, ws: 0 };
    return {
      totalConversations: row.total,
      totalMessages: row.msgs ?? 0,
      workspaceCount: row.ws,
    };
  }

  enrichMetadata(metaMap: Map<string, ConversationMeta>) {
    this.db.run('BEGIN TRANSACTION');
    try {
      for (const [id, meta] of metaMap) {
        if (meta.createdAt || meta.mode || meta.branch) {
          this.db.run(
            `UPDATE conversations SET created_at = ?, mode = ?, branch = ? WHERE id = ? AND (created_at IS NULL OR mode IS NULL)`,
            [meta.createdAt ?? null, meta.mode ?? null, meta.branch ?? null, id]
          );
        }
      }
      this.db.run('COMMIT');
      this.dirty = true;
      this.save();
    } catch {
      this.db.run('ROLLBACK');
    }
  }

  close() {
    this.save();
    this.db.close();
  }
}
