/**
 * Trace 事件耗时的唯一读法。
 *
 * 历史上有两套键名写进同一个 trace JSONL：renderer 的 `assistant_turn` 写 `metadata.duration`
 * （src/stores/turn/eventHandlers.ts），electron 的 `result` 写 `metadata.durationMs`
 * （electron/session/sessionProcess.ts）。两个键都是毫秒，只是键名分叉 —— 读取方各认一个，
 * 于是现网 491 个 completed `assistant_turn` 的耗时在 Trace 界面一处都不显示。
 * 写入侧已统一成 `durationMs`，这里保留 `duration` 回落，让磁盘上的历史文件继续可读。
 *
 * 另一个坑：trace 事件的 `timestamp` 是**落盘时刻**，而耗时事件都在回合结束时才发出，
 * 所以那个时间戳是回合的**结束**时间。实测 491 对 started/completed 事件，
 * `completedTimestamp - duration` 与 started 时间戳的误差 p50 = 2ms。
 * 因此耗时窗口是 `[timestamp - durationMs, timestamp]`，不是 `[timestamp, timestamp + durationMs]`。
 */

const CANONICAL_KEY = 'durationMs'
const LEGACY_KEY = 'duration'

export type TraceDurationEvent = {
  type: string
  timestamp?: string
  metadata?: Record<string, unknown>
}

export function readTraceEventDurationMs(metadata?: Record<string, unknown>): number | undefined {
  for (const key of [CANONICAL_KEY, LEGACY_KEY]) {
    const value = metadata?.[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  return undefined
}

/** 事件真实起止：已知耗时时把落盘时间戳当结束时间，反推开始时间。 */
export function traceEventTimeRange(
  timestamp: string | undefined,
  durationMs: number | undefined,
): { startedAt: string; completedAt?: string } {
  const stamp = timestamp ? new Date(timestamp).getTime() : NaN
  if (durationMs === undefined || !Number.isFinite(stamp)) {
    return { startedAt: timestamp && Number.isFinite(stamp) ? timestamp : new Date().toISOString() }
  }
  return {
    startedAt: new Date(stamp - durationMs).toISOString(),
    completedAt: timestamp,
  }
}

/**
 * 会话总执行时长 = 所有带耗时事件的 `[结束 - 耗时, 结束]` 窗口的并集长度。
 *
 * 直接相加会把同一段工作算两遍（一个回合既写 assistant_turn 又写 result，实测某会话
 * turn 164s、result 116s，机械合并报成 279s）；只取 turn 一族又会丢掉失败/中断回合 ——
 * 那些回合在旧版本里没写 metadata，只有 engine 的 result 留下时长（实测最差的会话因此
 * 从 74 分钟被算成 8.7 秒）。窗口并集两头都对上：重叠自动合并，不重叠的都算。
 */
export function mergeTraceDurationMs(events: TraceDurationEvent[]): number {
  const windows: Array<[number, number]> = []
  for (const event of events) {
    const durationMs = readTraceEventDurationMs(event.metadata)
    const end = event.timestamp ? new Date(event.timestamp).getTime() : NaN
    if (durationMs === undefined || !Number.isFinite(end)) continue
    windows.push([end - durationMs, end])
  }
  if (windows.length === 0) return 0

  windows.sort((a, b) => a[0] - b[0])
  let total = 0
  let [openStart, openEnd] = windows[0]
  for (let i = 1; i < windows.length; i++) {
    const [start, end] = windows[i]
    if (start <= openEnd) openEnd = Math.max(openEnd, end)
    else { total += openEnd - openStart; openStart = start; openEnd = end }
  }
  return total + (openEnd - openStart)
}
