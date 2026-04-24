import { getGapcodeSessionMessages } from '@/projects.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord } from '@/shared/utils.js';

const PROVIDER = 'gapcode';

type GapcodeHistoryResult =
  | AnyRecord[]
  | {
      messages?: AnyRecord[];
      total?: number;
      hasMore?: boolean;
      tokenUsage?: unknown;
    };

const loadGapcodeSessionMessages = getGapcodeSessionMessages as unknown as (
  sessionId: string,
  limit: number | null,
  offset: number,
) => Promise<GapcodeHistoryResult>;

export class GapcodeSessionsProvider implements IProviderSessions {
  private normalizeHistoryEntry(raw: AnyRecord, sessionId: string | null): NormalizedMessage[] {
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId(PROVIDER);

    if (raw.message?.role === 'user') {
      const content = typeof raw.message.content === 'string'
        ? raw.message.content
        : Array.isArray(raw.message.content)
          ? raw.message.content
              .map((part: string | AnyRecord) => typeof part === 'string' ? part : part?.text || '')
              .filter(Boolean)
              .join('\n')
          : String(raw.message.content || '');
      if (!content.trim()) return [];
      return [createNormalizedMessage({ id: baseId, sessionId, timestamp: ts, provider: PROVIDER, kind: 'text', role: 'user', content })];
    }

    if (raw.message?.role === 'assistant') {
      const content = typeof raw.message.content === 'string'
        ? raw.message.content
        : Array.isArray(raw.message.content)
          ? raw.message.content
              .map((part: string | AnyRecord) => typeof part === 'string' ? part : part?.text || '')
              .filter(Boolean)
              .join('\n')
          : '';
      if (!content.trim()) return [];
      return [createNormalizedMessage({ id: baseId, sessionId, timestamp: ts, provider: PROVIDER, kind: 'text', role: 'assistant', content })];
    }

    if (raw.type === 'thinking' || raw.isReasoning) {
      return [createNormalizedMessage({ id: baseId, sessionId, timestamp: ts, provider: PROVIDER, kind: 'thinking', content: raw.message?.content || '' })];
    }

    if (raw.type === 'tool_use' || raw.toolName) {
      return [createNormalizedMessage({ id: baseId, sessionId, timestamp: ts, provider: PROVIDER, kind: 'tool_use', toolName: raw.toolName || 'Unknown', toolInput: raw.toolInput, toolId: raw.toolCallId || baseId })];
    }

    if (raw.type === 'tool_result') {
      return [createNormalizedMessage({ id: baseId, sessionId, timestamp: ts, provider: PROVIDER, kind: 'tool_result', toolId: raw.toolCallId || '', content: raw.output || '', isError: Boolean(raw.isError) })];
    }

    return [];
  }

  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) return [];

    if (raw.message?.role) {
      return this.normalizeHistoryEntry(raw, sessionId);
    }

    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId(PROVIDER);

    if (raw.type === 'item') {
      switch (raw.itemType) {
        case 'agent_message':
          return [createNormalizedMessage({ id: baseId, sessionId, timestamp: ts, provider: PROVIDER, kind: 'text', role: 'assistant', content: raw.message?.content || '' })];
        case 'reasoning':
          return [createNormalizedMessage({ id: baseId, sessionId, timestamp: ts, provider: PROVIDER, kind: 'thinking', content: raw.message?.content || '' })];
        case 'command_execution':
          return [createNormalizedMessage({ id: baseId, sessionId, timestamp: ts, provider: PROVIDER, kind: 'tool_use', toolName: 'Bash', toolInput: { command: raw.command }, toolId: baseId, output: raw.output, exitCode: raw.exitCode, status: raw.status })];
        case 'file_change':
          return [createNormalizedMessage({ id: baseId, sessionId, timestamp: ts, provider: PROVIDER, kind: 'tool_use', toolName: 'FileChanges', toolInput: raw.changes, toolId: baseId, status: raw.status })];
        case 'mcp_tool_call':
          return [createNormalizedMessage({ id: baseId, sessionId, timestamp: ts, provider: PROVIDER, kind: 'tool_use', toolName: raw.tool || 'MCP', toolInput: raw.arguments, toolId: baseId, server: raw.server, result: raw.result, error: raw.error, status: raw.status })];
        case 'web_search':
          return [createNormalizedMessage({ id: baseId, sessionId, timestamp: ts, provider: PROVIDER, kind: 'tool_use', toolName: 'WebSearch', toolInput: { query: raw.query }, toolId: baseId })];
        case 'todo_list':
          return [createNormalizedMessage({ id: baseId, sessionId, timestamp: ts, provider: PROVIDER, kind: 'tool_use', toolName: 'TodoList', toolInput: { items: raw.items }, toolId: baseId })];
        case 'error':
          return [createNormalizedMessage({ id: baseId, sessionId, timestamp: ts, provider: PROVIDER, kind: 'error', content: raw.message?.content || 'Unknown error' })];
        default:
          return [createNormalizedMessage({ id: baseId, sessionId, timestamp: ts, provider: PROVIDER, kind: 'tool_use', toolName: raw.itemType || 'Unknown', toolInput: raw.item || raw, toolId: baseId })];
      }
    }

    if (raw.type === 'turn_complete') {
      return [createNormalizedMessage({ id: baseId, sessionId, timestamp: ts, provider: PROVIDER, kind: 'complete' })];
    }
    if (raw.type === 'turn_failed') {
      return [createNormalizedMessage({ id: baseId, sessionId, timestamp: ts, provider: PROVIDER, kind: 'error', content: raw.error?.message || 'Turn failed' })];
    }

    return [];
  }

  async fetchHistory(sessionId: string, options: FetchHistoryOptions = {}): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;

    let result: GapcodeHistoryResult;
    try {
      result = await loadGapcodeSessionMessages(sessionId, limit, offset);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[GapcodeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const rawMessages = Array.isArray(result) ? result : (result.messages || []);
    const total = Array.isArray(result) ? rawMessages.length : (result.total || 0);
    const hasMore = Array.isArray(result) ? false : Boolean(result.hasMore);
    const tokenUsage = Array.isArray(result) ? undefined : result.tokenUsage;

    const normalized: NormalizedMessage[] = [];
    for (const raw of rawMessages) {
      normalized.push(...this.normalizeHistoryEntry(raw, sessionId));
    }

    const toolResultMap = new Map<string, NormalizedMessage>();
    for (const msg of normalized) {
      if (msg.kind === 'tool_result' && msg.toolId) {
        toolResultMap.set(msg.toolId, msg);
      }
    }
    for (const msg of normalized) {
      if (msg.kind === 'tool_use' && msg.toolId && toolResultMap.has(msg.toolId)) {
        const toolResult = toolResultMap.get(msg.toolId);
        if (toolResult) {
          msg.toolResult = { content: toolResult.content, isError: toolResult.isError };
        }
      }
    }

    return { messages: normalized, total, hasMore, offset, limit, tokenUsage };
  }
}
