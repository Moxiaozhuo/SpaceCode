/**
 * Trace API IPC handlers — list/get trace sessions and calls.
 *
 * Converts internal AgentTraceEvents to the trace session/call format
 * expected by the renderer's trace inspector UI.
 */
import { ipcMain } from 'electron'
import {
  listTraceSessions,
  readTraceEvents,
  getTraceDir,
} from '../infra/logger'
import { mergeTraceDurationMs, readTraceEventDurationMs, traceEventTimeRange } from '@/utils/traceDuration'

type AgentTraceEventForTrace = {
  id?: string
  sessionId: string
  timestamp?: string
  source?: string
  actor?: string
  type: string
  status?: string
  title?: string
  input?: unknown
  output?: unknown
  error?: { message: string; stack?: string }
  metadata?: Record<string, unknown>
}

function isLlmCallEvent(e: AgentTraceEventForTrace): boolean {
  return e.actor === 'assistant' || e.type === 'assistant_text' || e.type === 'assistant_turn' || e.type === 'assistant_reasoning'
}

function isToolCallEvent(e: AgentTraceEventForTrace): boolean {
  return e.actor === 'tool' || e.type === 'tool_call'
}

function eventToCallRecord(e: AgentTraceEventForTrace): Record<string, unknown> {
  const usage = e.metadata?.usage as Record<string, unknown> | undefined
  const inputTokens = (usage?.inputTokens as number) || 0
  const outputTokens = (usage?.outputTokens as number) || 0
  const durationMs = readTraceEventDurationMs(e.metadata)
  const model = (e.metadata?.model as string) || e.metadata?.modelId as string | undefined
  // 耗时事件都在回合结束时落盘，所以 e.timestamp 是结束时间，开始时间用耗时反推。
  const { startedAt, completedAt } = traceEventTimeRange(e.timestamp, durationMs)
  const callStatus = e.status === 'failed' ? 'error' : e.status === 'running' || e.status === 'started' ? 'pending' : 'ok'
  const inputPreview = typeof e.input === 'string' ? e.input : JSON.stringify(e.input ?? '')
  const outputPreview = typeof e.output === 'string' ? e.output : JSON.stringify(e.output ?? '')
  return {
    id: e.id || `call-${e.type}-${e.timestamp}`,
    sessionId: e.sessionId,
    source: e.source === 'engine' ? 'proxy' : 'anthropic',
    model,
    status: callStatus,
    startedAt,
    completedAt,
    durationMs,
    usage: { inputTokens, outputTokens },
    metadata: e.metadata,
    request: {
      method: 'POST',
      url: '',
      headers: {},
      body: { contentType: 'json', bytes: inputPreview.length, sha256: '', preview: inputPreview.slice(0, 1024), truncated: inputPreview.length > 1024 },
    },
    response: e.output ? {
      status: 200,
      headers: {},
      body: { contentType: 'json', bytes: outputPreview.length, sha256: '', preview: outputPreview.slice(0, 1024), truncated: outputPreview.length > 1024 },
    } : undefined,
    error: e.error ? { name: 'TraceError', message: e.error.message, stack: e.error.stack } : undefined,
  }
}

function eventToEventRecord(e: AgentTraceEventForTrace): Record<string, unknown> {
  const severity: string = e.status === 'failed' ? 'error' : e.status === 'running' || e.status === 'started' ? 'info' : 'info'
  return {
    id: e.id || `event-${e.type}-${e.timestamp}`,
    sessionId: e.sessionId,
    timestamp: e.timestamp || new Date().toISOString(),
    phase: e.type,
    severity,
    callId: e.id,
    source: e.source === 'engine' ? 'proxy' : 'anthropic',
    model: (e.metadata?.model as string) || (e.metadata?.modelId as string),
    title: e.title || e.type,
    message: e.error?.message,
    metadata: e.metadata,
  }
}

function buildTraceSummary(calls: Record<string, unknown>[], events: AgentTraceEventForTrace[]): Record<string, unknown> {
  // apiCalls 与 token 数是 turn 级事件推算出来的，不是真实请求级计数：一次回合可能含多次
  // API 请求，且没有任何写入方给 trace 事件写 metadata.usage，所以 token 恒为 0。
  // 需要精确计数得先补请求级 trace 事件（#41 拆分票 16 明确划到票外）。
  const apiCalls = calls.length
  const failedCalls = calls.filter(c => c.status === 'error').length
  const totalDurationMs = mergeTraceDurationMs(events)
  let totalInputTokens = 0
  let totalOutputTokens = 0
  const modelCounts = new Map<string, number>()
  for (const call of calls) {
    const usage = call.usage as { inputTokens?: number; outputTokens?: number } | undefined
    if (usage) {
      totalInputTokens += usage.inputTokens || 0
      totalOutputTokens += usage.outputTokens || 0
    }
    const model = call.model as string | undefined
    if (model) modelCounts.set(model, (modelCounts.get(model) || 0) + 1)
  }
  const models = Array.from(modelCounts.entries()).map(([model, calls]) => ({ model, calls }))
  const updatedAt = events.length > 0 ? events[events.length - 1].timestamp || null : null
  return { apiCalls, failedCalls, totalDurationMs, totalInputTokens, totalOutputTokens, models, updatedAt }
}

export function registerTraceIPCHandlers(): void {
  ipcMain.handle('trace:list', async (_event, params?: { limit?: number; offset?: number; query?: string }) => {
    const sessions = await listTraceSessions()
    const query = params?.query?.toLowerCase() || ''
    let filtered = sessions
    if (query) {
      filtered = sessions.filter(s => s.sessionId.toLowerCase().includes(query))
    }
    const offset = params?.offset || 0
    const limit = params?.limit || 50
    const paged = filtered.slice(offset, offset + limit)
    return {
      traces: await Promise.all(paged.map(async s => {
        const evtResult = await readTraceEvents(s.sessionId, 5000)
        const evts = evtResult.success ? (evtResult.events || []) as unknown as AgentTraceEventForTrace[] : []
        const calls = evts.filter(isLlmCallEvent).map(eventToCallRecord)
        const summary = buildTraceSummary(calls, evts)
        return {
          sessionId: s.sessionId,
          session: null,
          summary,
          fileSize: s.size,
          fileUpdatedAt: new Date(s.modifiedAt).toISOString(),
        }
      })),
      total: filtered.length,
      storageDir: getTraceDir() || '',
      settings: { enabled: true, storageDir: getTraceDir() || '' },
    }
  })

  ipcMain.handle('trace:getTrace', async (_event, sessionId: string) => {
    try {
      const result = await readTraceEvents(sessionId, 5000)
      if (!result.success) return { success: false, error: result.error }
      const events = (result.events || []) as unknown as AgentTraceEventForTrace[]
      const calls = events.filter(isLlmCallEvent).map(eventToCallRecord)
      const traceEvents = events.map(eventToEventRecord)
      const summary = buildTraceSummary(calls, events)
      return {
        success: true,
        data: {
          sessionId,
          session: null,
          summary,
          calls,
          events: traceEvents,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('trace:getTraceCall', async (_event, sessionId: string, callId: string) => {
    try {
      const result = await readTraceEvents(sessionId, 5000)
      if (!result.success) return null
      const events = (result.events || []) as unknown as AgentTraceEventForTrace[]
      const callEvent = events.find(e => (e.id && e.id === callId) || (isLlmCallEvent(e) && `call-${e.type}-${e.timestamp}` === callId))
        || events.find(e => isToolCallEvent(e) && (e.id === callId || `call-${e.type}-${e.timestamp}` === callId))
      if (!callEvent) return null
      const call = eventToCallRecord(callEvent)
      return { call }
    } catch {
      return null
    }
  })

  ipcMain.handle('trace:getSettings', async () => {
    return { enabled: true, storageDir: getTraceDir() || '' }
  })

  ipcMain.handle('trace:updateSettings', async (_event, _settings: { enabled: boolean }) => {
    return { success: true }
  })

  ipcMain.on('trace:openWindow', (_event, _sessionId: string) => {
    // TODO: 实现独立 BrowserWindow 打开 trace 详情
  })
}
