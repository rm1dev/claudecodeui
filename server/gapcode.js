/**
 * GapCode CLI Integration
 * =======================
 *
 * GapCode is an independent AI coding agent. This module spawns the `gapcode`
 * binary directly and streams JSONL events over WebSocket.
 */

import { spawn } from 'child_process';
import readline from 'readline';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { createNormalizedMessage } from './shared/utils.js';

const activeGapcodeSessions = new Map();

function buildSandboxArgs(permissionMode) {
  switch (permissionMode) {
    case 'acceptEdits':
      return ['--sandbox', 'workspace-write', '--full-auto'];
    case 'bypassPermissions':
      return ['--dangerously-bypass-approvals-and-sandbox'];
    default:
      return ['--sandbox', 'workspace-write'];
  }
}

function transformEvent(event) {
  switch (event.type) {
    case 'item.completed': {
      const item = event.item;
      if (!item) return null;
      switch (item.type) {
        case 'agent_message':
          return { type: 'item', itemType: 'agent_message', message: { role: 'assistant', content: item.text } };
        case 'reasoning':
          return { type: 'item', itemType: 'reasoning', message: { role: 'assistant', content: item.text, isReasoning: true } };
        case 'command_execution':
          return { type: 'item', itemType: 'command_execution', command: item.command, output: item.aggregated_output, exitCode: item.exit_code, status: item.status };
        case 'file_change':
          return { type: 'item', itemType: 'file_change', changes: item.changes, status: item.status };
        case 'mcp_tool_call':
          return { type: 'item', itemType: 'mcp_tool_call', server: item.server, tool: item.tool, arguments: item.arguments, result: item.result, error: item.error, status: item.status };
        case 'web_search':
          return { type: 'item', itemType: 'web_search', query: item.query };
        case 'todo_list':
          return { type: 'item', itemType: 'todo_list', items: item.items };
        default:
          return { type: 'item', itemType: item.type, item };
      }
    }
    default:
      return null;
  }
}

export async function queryGapcode(command, options = {}, ws) {
  const { sessionId, sessionSummary, cwd, projectPath, model, permissionMode = 'default' } = options;
  const workingDirectory = cwd || projectPath || process.cwd();
  let currentSessionId = sessionId || null;
  let terminalFailure = null;
  const abortController = new AbortController();

  // Build args:
  //   New session:    gapcode exec --json [flags] -
  //   Resume session: gapcode exec --json [flags] resume <id> -
  const flags = ['--json', '--skip-git-repo-check'];
  if (model) flags.push('--model', model);
  flags.push(...buildSandboxArgs(permissionMode));

  const args = sessionId
    ? ['exec', ...flags, 'resume', sessionId, '-']
    : ['exec', ...flags, '-'];

  try {
    const child = spawn('gapcode', args, {
      cwd: workingDirectory,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const tempId = currentSessionId || `gapcode-${Date.now()}`;
    activeGapcodeSessions.set(tempId, { process: child, status: 'running', abortController, startedAt: new Date().toISOString() });
    currentSessionId = tempId;

    abortController.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });

    // Write prompt to stdin
    child.stdin.write(command || '');
    child.stdin.end();

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    for await (const line of rl) {
      const session = activeGapcodeSessions.get(currentSessionId);
      if (!session || session.status === 'aborted') break;
      if (!line.trim()) continue;

      let event;
      try { event = JSON.parse(line); } catch { continue; }

      // thread.started → extract real session ID
      if (event.type === 'thread.started' && event.thread_id) {
        const realId = event.thread_id;
        if (realId !== currentSessionId) {
          activeGapcodeSessions.set(realId, activeGapcodeSessions.get(currentSessionId));
          activeGapcodeSessions.delete(currentSessionId);
          currentSessionId = realId;
        }
        sendMessage(ws, createNormalizedMessage({ kind: 'session_created', newSessionId: currentSessionId, sessionId: currentSessionId, provider: 'gapcode' }));
        continue;
      }

      // error event (e.g. quota exceeded) — this is the primary error message
      if (event.type === 'error') {
        sendMessage(ws, createNormalizedMessage({ kind: 'error', content: event.message || 'Unknown error', sessionId: currentSessionId, provider: 'gapcode' }));
        continue;
      }

      // turn.failed — just set the flag, error already sent via 'error' event above
      if (event.type === 'turn.failed') {
        terminalFailure = new Error(event.error?.message || 'Turn failed');
        notifyRunFailed({ userId: ws?.userId || null, provider: 'gapcode', sessionId: currentSessionId, sessionName: sessionSummary, error: terminalFailure });
        continue;
      }

      // turn.completed → token usage
      if (event.type === 'turn.completed') {
        if (event.usage) {
          const totalTokens = (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0);
          sendMessage(ws, createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: { used: totalTokens, total: 200000 }, sessionId: currentSessionId, provider: 'gapcode' }));
        }
        continue;
      }

      // skip item.started / item.updated
      if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'turn.started') continue;

      // item.completed → normalize and send
      const transformed = transformEvent(event);
      if (!transformed) continue;

      const normalizedMsgs = sessionsService.normalizeMessage('gapcode', transformed, currentSessionId);
      for (const msg of normalizedMsgs) sendMessage(ws, msg);
    }

    await new Promise((resolve) => child.once('close', resolve));

    // Always send complete so UI exits loading state
    sendMessage(ws, createNormalizedMessage({ kind: 'complete', sessionId: currentSessionId, provider: 'gapcode' }));

    if (!terminalFailure) {
      notifyRunStopped({ userId: ws?.userId || null, provider: 'gapcode', sessionId: currentSessionId, sessionName: sessionSummary, stopReason: 'completed' });
    }

  } catch (error) {
    const session = currentSessionId ? activeGapcodeSessions.get(currentSessionId) : null;
    const wasAborted = session?.status === 'aborted' || error?.name === 'AbortError' || String(error?.message || '').toLowerCase().includes('aborted');

    if (!wasAborted) {
      console.error('[GapCode] Error:', error);
      const installed = await providerAuthService.isProviderInstalled('gapcode');
      sendMessage(ws, createNormalizedMessage({
        kind: 'error',
        content: !installed ? 'GapCode CLI is not installed or not configured.' : error.message,
        sessionId: currentSessionId,
        provider: 'gapcode',
      }));
      sendMessage(ws, createNormalizedMessage({ kind: 'complete', sessionId: currentSessionId, provider: 'gapcode' }));
      if (!terminalFailure) {
        notifyRunFailed({ userId: ws?.userId || null, provider: 'gapcode', sessionId: currentSessionId, sessionName: sessionSummary, error });
      }
    }
  } finally {
    if (currentSessionId) {
      const session = activeGapcodeSessions.get(currentSessionId);
      if (session) session.status = session.status === 'aborted' ? 'aborted' : 'completed';
    }
  }
}

export function abortGapcodeSession(sessionId) {
  const session = activeGapcodeSessions.get(sessionId);
  if (!session) return false;
  session.status = 'aborted';
  try { session.abortController?.abort(); session.process?.kill('SIGTERM'); } catch (e) {
    console.warn(`[GapCode] Failed to abort session ${sessionId}:`, e);
  }
  return true;
}

export function isGapcodeSessionActive(sessionId) {
  return activeGapcodeSessions.get(sessionId)?.status === 'running';
}

export function getActiveGapcodeSessions() {
  const sessions = [];
  for (const [id, session] of activeGapcodeSessions.entries()) {
    if (session.status === 'running') sessions.push({ id, status: session.status, startedAt: session.startedAt });
  }
  return sessions;
}

function sendMessage(ws, data) {
  try {
    if (ws && (ws.isSSEStreamWriter || ws.isWebSocketWriter)) {
      ws.send(data);
    } else if (ws && typeof ws.send === 'function') {
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error('[GapCode] Error sending message:', error);
  }
}
