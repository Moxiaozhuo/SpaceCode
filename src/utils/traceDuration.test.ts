import { describe, expect, it } from 'vitest'
import { mergeTraceDurationMs, readTraceEventDurationMs, traceEventTimeRange, type TraceDurationEvent } from './traceDuration'

// 实测依据（~/.claude/debug/traces 319 个真实文件）：renderer 的 assistant_turn 一律写
// metadata.duration，engine 的 result 一律写 metadata.durationMs，两者都是毫秒。
describe('readTraceEventDurationMs', () => {
  it('读规范键 durationMs', () => {
    expect(readTraceEventDurationMs({ durationMs: 15900 })).toBe(15900)
  })

  it('兼容历史键 duration（现网 491/491 个 assistant_turn 走这条路）', () => {
    expect(readTraceEventDurationMs({ duration: 15900 })).toBe(15900)
  })

  it('两个键同时存在时以 durationMs 为准', () => {
    expect(readTraceEventDurationMs({ durationMs: 15900, duration: 9999 })).toBe(15900)
  })

  it.each([undefined, {}, null])('缺失 metadata 或无耗时 → undefined: %o', (metadata) => {
    expect(readTraceEventDurationMs(metadata as Record<string, unknown> | undefined)).toBeUndefined()
  })

  it.each([-1, '15900', NaN, Infinity, null, undefined])('拒绝非法值 %p（不做单位猜测）', (bad) => {
    expect(readTraceEventDurationMs({ duration: bad })).toBeUndefined()
    expect(readTraceEventDurationMs({ durationMs: bad })).toBeUndefined()
  })

  it('接受 0 与小数（瞬时回合 / performance.now 类计时）', () => {
    expect(readTraceEventDurationMs({ durationMs: 0 })).toBe(0)
    expect(readTraceEventDurationMs({ duration: 1.5 })).toBe(1.5)
  })
})

const END = '2026-06-12T12:00:00.000Z'
const END_MS = Date.parse(END)
const shift = (ms: number) => new Date(END_MS + ms).toISOString()

function eventAt(timestamp: string, durationMs: number | undefined): TraceDurationEvent {
  return { type: 'assistant_turn', timestamp, metadata: durationMs === undefined ? {} : { durationMs } }
}

describe('traceEventTimeRange', () => {
  it('把落盘时间戳当结束时间，用耗时反推开始时间', () => {
    const range = traceEventTimeRange(END, 15900)

    expect(range.completedAt).toBe(END)
    expect(new Date(range.startedAt).getTime()).toBe(END_MS - 15900)
  })

  it('无耗时时只有 startedAt，且不编造 completedAt', () => {
    expect(traceEventTimeRange(END, undefined)).toEqual({ startedAt: END })
  })

  it('时间戳缺失/非法时退回当前时间，不产出 NaN', () => {
    const missing = traceEventTimeRange(undefined, 1000)

    expect(Number.isNaN(new Date(missing.startedAt).getTime())).toBe(false)
    expect(missing.completedAt).toBeUndefined()
  })
})

describe('mergeTraceDurationMs', () => {
  it('同一回合的 turn 与 result 窗口重叠，只算一次（实测会把 164s 报成 279s）', () => {
    const events: TraceDurationEvent[] = [
      eventAt(END, 141803),
      { type: 'result', timestamp: END, metadata: { durationMs: 102199 } },
      eventAt(shift(60_000), 22124),
      { type: 'result', timestamp: shift(60_000), metadata: { durationMs: 13300 } },
    ]

    expect(mergeTraceDurationMs(events)).toBe(141803 + 22124)
  })

  it('engine-only 会话的 result 窗口照算（旧口径会把这些会话报成 0）', () => {
    const events: TraceDurationEvent[] = [
      { type: 'result', timestamp: END, metadata: { durationMs: 500 } },
      { type: 'result', timestamp: shift(1000), metadata: { durationMs: 250 } },
    ]

    expect(mergeTraceDurationMs(events)).toBe(750)
  })

  it('窗口完全被包含时不增加总量', () => {
    const events: TraceDurationEvent[] = [
      eventAt(END, 60_000),
      { type: 'result', timestamp: shift(-30_000), metadata: { durationMs: 1000 } },
    ]

    expect(mergeTraceDurationMs(events)).toBe(60_000)
  })

  it('乱序输入结果一致（并集与顺序无关）', () => {
    const ordered = [eventAt(END, 1000), eventAt(shift(5000), 1000), eventAt(shift(2000), 1000)]
    const reversed = [...ordered].reverse()

    expect(mergeTraceDurationMs(reversed)).toBe(mergeTraceDurationMs(ordered))
  })

  it('相邻但不重叠的窗口分别计入', () => {
    const events: TraceDurationEvent[] = [
      eventAt(END, 1000),          // [END-1000, END]
      eventAt(shift(1000), 1000),  // [END, END+1000]
    ]

    expect(mergeTraceDurationMs(events)).toBe(2000)
  })

  it('legacy duration 键同样参与并集', () => {
    expect(mergeTraceDurationMs([
      { type: 'assistant_turn', timestamp: END, metadata: { duration: 15900 } },
    ])).toBe(15900)
  })

  it('缺时间戳或非法耗时的事件被跳过，总量不会是 NaN', () => {
    const events: TraceDurationEvent[] = [
      { type: 'assistant_turn', metadata: { durationMs: 1000 } },
      { type: 'assistant_turn', timestamp: END, metadata: { durationMs: -5 } },
      { type: 'assistant_turn', timestamp: 'not-a-date', metadata: { durationMs: 1000 } },
    ]

    expect(mergeTraceDurationMs(events)).toBe(0)
  })

  it('空事件 → 0', () => {
    expect(mergeTraceDurationMs([])).toBe(0)
  })
})
