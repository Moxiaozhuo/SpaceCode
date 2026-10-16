import type { UnifiedEngineEvent } from './types'

export interface PiAgentEvent {
  type: string
  [key: string]: any
}

export function mapPiEvent(sessionId: string, event: PiAgentEvent): UnifiedEngineEvent | null {
  switch (event.type) {
    case 'agent_start':
      return { sessionId, type: 'system', data: { subtype: 'agent_start' } }

    case 'agent_end': {
      // Pi 的上游拒绝（403/429 等）只写在最后一条 assistant 消息的 stopReason/errorMessage
      // 上，agent_end 帧本身不标错 —— 不读它就等于报"成功的空结果"，真原因被兜底文案取代。
      const last = findLastAssistant(event.messages)
      return {
        sessionId,
        type: 'result',
        data: last?.stopReason === 'error'
          ? { result: last?.errorMessage || '', is_error: true, stop_reason: 'error', messages: event.messages }
          : { result: extractFinalText(event.messages), stop_reason: 'end_turn', messages: event.messages },
      }
    }

    case 'turn_start':
      return null

    case 'turn_end':
      return null

    case 'message_start': {
      const msg = event.message
      if (msg?.role === 'assistant') {
        return {
          sessionId,
          type: 'assistant',
          data: { message: mapAssistantMessage(msg) },
        }
      }
      if (msg?.role === 'user') {
        return {
          sessionId,
          type: 'user',
          data: { message: msg },
        }
      }
      return null
    }

    case 'message_update': {
      const delta = event.assistantMessageEvent
      if (!delta) return null

      const mappedDelta = mapStreamDelta(delta)
      return {
        sessionId,
        type: 'stream_event',
        data: { event: mappedDelta },
      }
    }

    case 'message_end': {
      const msg = event.message
      if (msg?.role === 'assistant') {
        return {
          sessionId,
          type: 'assistant',
          data: { message: mapAssistantMessage(msg) },
        }
      }
      return null
    }

    case 'tool_execution_start':
      return {
        sessionId,
        type: 'tool_use',
        data: {
          id: event.toolCallId,
          name: event.toolName,
          input: event.args,
        },
      }

    case 'tool_execution_update':
      return {
        sessionId,
        type: 'stream_event',
        data: {
          event: {
            type: 'content_block_delta',
            delta: {
              type: 'tool_execution_delta',
              toolCallId: event.toolCallId,
              partialResult: event.partialResult,
            },
          },
        },
      }

    case 'tool_execution_end':
      return {
        sessionId,
        type: 'tool_result',
        data: {
          tool_use_id: event.toolCallId,
          output: formatToolResult(event.result),
          is_error: event.isError,
        },
      }

    case 'compaction_start':
      return {
        sessionId,
        type: 'system',
        data: { subtype: 'compaction_start', reason: event.reason },
      }

    case 'compaction_end':
      return {
        sessionId,
        type: 'system',
        data: { subtype: 'compaction_end', reason: event.reason, aborted: event.aborted },
      }

    case 'thinking_level_changed':
      return {
        sessionId,
        type: 'system',
        data: { subtype: 'thinking_level_changed', level: event.level },
      }

    case 'auto_retry_start':
      return {
        sessionId,
        type: 'system',
        data: { subtype: 'auto_retry_start', attempt: event.attempt, maxAttempts: event.maxAttempts },
      }

    case 'auto_retry_end':
      return {
        sessionId,
        type: 'system',
        data: { subtype: 'auto_retry_end', success: event.success, attempt: event.attempt },
      }

    case 'suspended':
      return {
        sessionId,
        type: 'suspended',
        data: { reason: event.reason || 'unknown' },
      }

    case 'exit':
      return {
        sessionId,
        type: 'exit',
        data: { code: event.code, signal: event.signal, stderr: event.stderr },
      }

    case 'error':
      return {
        sessionId,
        type: 'error',
        data: { message: event.message, code: event.code },
      }

    case 'queue_update':
      return null

    case 'session_info_changed':
      return null

    default:
      return null
  }
}

function mapAssistantMessage(msg: any): any {
  return {
    role: 'assistant',
    content: msg.content,
    model: msg.model,
    usage: msg.usage,
  }
}

interface PiAssistantMessage {
  role?: string
  content?: string | Array<{ type?: string; text?: string }>
  stopReason?: string
  errorMessage?: string
}

function findLastAssistant(messages: unknown): PiAssistantMessage | undefined {
  if (!Array.isArray(messages)) return undefined
  return [...messages].reverse().find((m: PiAssistantMessage) => m?.role === 'assistant')
}

function extractFinalText(messages: unknown): string {
  const content = findLastAssistant(messages)?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const textBlock = content.find((c) => c?.type === 'text')
    return textBlock?.text || ''
  }
  return ''
}

function formatToolResult(result: any): string {
  if (result === undefined || result === null) return ''
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

function mapStreamDelta(delta: any): any {
  switch (delta.type) {
    case 'thinking_start':
      return {
        type: 'content_block_start',
        content_block: { type: 'thinking' },
        partial: delta.partial
      }
    case 'thinking_delta':
      return {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: delta.delta || delta.thinking },
        partial: delta.partial
      }
    case 'thinking_end':
      return {
        type: 'content_block_stop',
        content_block: { type: 'thinking' },
        partial: delta.partial
      }
    case 'text_start':
      return {
        type: 'content_block_start',
        content_block: { type: 'text' },
        partial: delta.partial
      }
    case 'text_delta':
      return {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: delta.delta || delta.text },
        partial: delta.partial
      }
    case 'text_end':
      return {
        type: 'content_block_stop',
        content_block: { type: 'text' },
        partial: delta.partial
      }
    case 'toolcall_start':
      return {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: delta.toolCallId, name: delta.toolName },
        partial: delta.partial
      }
    case 'toolcall_delta':
      return {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: delta.delta },
        partial: delta.partial
      }
    case 'toolcall_end':
      return {
        type: 'content_block_stop',
        content_block: { type: 'tool_use' },
        partial: delta.partial
      }
    default:
      return delta
  }
}
