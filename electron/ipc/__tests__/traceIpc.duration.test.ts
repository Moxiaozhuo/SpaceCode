// @vitest-environment node
/**
 * Trace IPC 的耗时字段转换（#41 拆分票 16）。
 *
 * 现网 `~/.claude/debug/traces/*.jsonl` 里 491 个 completed `assistant_turn` 事件全部写
 * `metadata.duration`，而转换器只读 `metadata.durationMs` —— 于是 `call.durationMs` 恒为
 * undefined，renderer 侧累计的 37,931,643 ms 在总时长里被整条丢掉；engine 没发 `result`
 * 的会话总时长直接是 0。这里钉住三件事：
 *  1. 历史 duration 键读得出来
 *  2. timestamp 是落盘（回合结束）时刻 → completedAt = timestamp，startedAt 用耗时反推
 *  3. 总时长取时间窗并集：既不把同一回合的 turn/result 双计，也不丢 result-only 区间
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type TraceEventFixture = {
  sessionId: string
  timestamp: string
  source: string
  actor: string
  type: string
  status: string
  title?: string
  metadata?: Record<string, unknown>
}
type IpcHandler = (...args: unknown[]) => Promise<unknown>
type CallRecord = { durationMs?: number; startedAt?: string; completedAt?: string }
type Summary = { totalDurationMs: number; apiCalls: number }
type GetTraceResult = { success: boolean; data?: { calls: CallRecord[]; summary: Summary } }
type ListResult = { traces: Array<{ summary: Summary }> }

const probe = vi.hoisted(() => ({
  handlers: {} as Record<string, IpcHandler>,
  events: [] as TraceEventFixture[],
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      probe.handlers[channel] = handler
    }),
    on: vi.fn(),
  },
}))

vi.mock('../../infra/logger', () => ({
  listTraceSessions: vi.fn(async () => [{
    sessionId: 'sess-1', path: '/tmp/sess-1.jsonl', size: 1, modifiedAt: 1, eventCount: probe.events.length,
  }]),
  readTraceEvents: vi.fn(async () => ({ success: true, events: probe.events })),
  getTraceDir: vi.fn(() => '/tmp/traces'),
}))

import { registerTraceIPCHandlers } from '../traceIpc'

const TS = '2026-06-12T20:44:57.259+08:00'
const at = (ms: number) => new Date(new Date(TS).getTime() + ms).toISOString()

function turnEvent(duration: Record<string, unknown> | undefined, timestamp = TS): TraceEventFixture {
  return {
    sessionId: 'sess-1',
    timestamp,
    source: 'renderer',
    actor: 'assistant',
    type: 'assistant_turn',
    status: 'completed',
    title: 'Assistant turn completed',
    metadata: duration ? { model: 'test-model', ...duration } : { model: 'test-model' },
  }
}

function resultEvent(durationMs: number, timestamp = TS): TraceEventFixture {
  return {
    sessionId: 'sess-1',
    timestamp,
    source: 'electron',
    actor: 'assistant',
    type: 'result',
    status: 'completed',
    title: 'Agent response completed',
    metadata: { costUsd: 0.01, durationMs, numTurns: 1 },
  }
}

async function getTrace(): Promise<{ calls: CallRecord[]; summary: Summary }> {
  const res = (await probe.handlers['trace:getTrace']({}, 'sess-1')) as GetTraceResult
  if (!res.data) throw new Error('trace:getTrace 返回了空数据')
  return res.data
}

beforeEach(() => {
  probe.handlers = {}
  probe.events = []
  registerTraceIPCHandlers()
})

describe('traceIpc 耗时转换', () => {
  it('assistant_turn 的 legacy metadata.duration 转成 call.durationMs', async () => {
    probe.events = [turnEvent({ duration: 15900 })]
    const { calls, summary } = await getTrace()

    expect(calls[0].durationMs).toBe(15900)
    expect(summary.totalDurationMs).toBe(15900)
  })

  it('时间戳是落盘（回合结束）时刻：completedAt 用它，startedAt 用耗时反推', async () => {
    probe.events = [turnEvent({ duration: 15900 })]
    const [call] = (await getTrace()).calls

    expect(call.completedAt).toBe(TS)
    expect(new Date(call.startedAt ?? '').getTime()).toBe(new Date(TS).getTime() - 15900)
  })

  it('规范键 durationMs 照常工作', async () => {
    probe.events = [turnEvent({ durationMs: 15900 })]
    expect((await getTrace()).calls[0].durationMs).toBe(15900)
  })

  it('无耗时事件不编造 completedAt', async () => {
    probe.events = [{ ...turnEvent(undefined), status: 'started' }]
    const [call] = (await getTrace()).calls

    expect(call.durationMs).toBeUndefined()
    expect(call.completedAt).toBeUndefined()
    expect(call.startedAt).toBe(TS)
  })

  it('同一回合的 turn 与 result 窗口重叠，总时长不双计', async () => {
    probe.events = [
      turnEvent({ duration: 141803 }),
      resultEvent(102199),
      turnEvent({ duration: 22124 }, at(200_000)),
      resultEvent(13300, at(200_000)),
    ]
    const { summary } = await getTrace()

    expect(summary.totalDurationMs).toBe(163927)
    // 每个事件仍如实带回自己的原始耗时，供详情逐行显示
    expect(summary.apiCalls).toBe(4)
  })

  it('失败/中断回合没有耗时时，engine result 的区间仍然计入', async () => {
    probe.events = [
      { ...turnEvent(undefined), status: 'failed' },
      resultEvent(400_000, at(5_000)),
      resultEvent(300_000, at(500_000)),
    ]

    expect((await getTrace()).summary.totalDurationMs).toBe(700_000)
  })

  it('回合无耗时时总时长为 0 而不是 NaN', async () => {
    probe.events = [turnEvent(undefined)]
    expect((await getTrace()).summary.totalDurationMs).toBe(0)
  })

  it('trace:list 与 trace:getTrace 用同一套聚合，两者总时长一致', async () => {
    probe.events = [turnEvent({ duration: 15900 }), resultEvent(12000)]
    const list = (await probe.handlers['trace:list']({ limit: 50, offset: 0 })) as ListResult
    const detail = await getTrace()

    expect(list.traces[0].summary.totalDurationMs).toBe(detail.summary.totalDurationMs)
    expect(list.traces[0].summary.totalDurationMs).toBe(15900)
  })
})
