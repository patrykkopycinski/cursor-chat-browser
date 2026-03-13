export interface Conversation {
  id: string;
  workspace: string;
  workspacePath: string;
  title: string;
  firstMessage: string;
  messages: Message[];
  createdAt: number | null;
  mode: string | null;
  branch: string | null;
  messageCount: number;
}

export interface Message {
  role: 'user' | 'assistant' | 'tool';
  text: string;
}

export interface ConversationMeta {
  composerId: string;
  createdAt: number | null;
  mode: string | null;
  branch: string | null;
  status: string | null;
  isAgentic: boolean;
  text: string;
}

export interface SearchResult {
  id: string;
  workspace: string;
  workspacePath: string;
  title: string;
  snippet: string;
  rank: number;
  createdAt: number | null;
  mode: string | null;
  messageCount: number;
}
