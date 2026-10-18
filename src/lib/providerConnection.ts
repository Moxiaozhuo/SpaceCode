import type { AuthMethod, ProviderConfig } from '@/stores/settings'
import { normalizeApiUrl } from '@/utils/apiUrl'
import { api } from '@/services/electronAPI'

export type ProviderTarget = 'anthropic' | 'openai' | 'gemini'

/** claudeai / console 走 CLI 自身登录，应用内没有可直接探测的凭据。 */
export const OAUTH_METHODS: ReadonlySet<AuthMethod> = new Set(['claudeai', 'console'])

const TARGET_BY_METHOD: Record<AuthMethod, ProviderTarget> = {
  anthropic_compatible: 'anthropic',
  claudeai: 'anthropic',
  console: 'anthropic',
  openai_compatible: 'openai',
  gemini_api: 'gemini'
}

const DEFAULT_BASE_URL: Record<ProviderTarget, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta'
}

export interface ProviderEndpoint {
  target: ProviderTarget
  baseUrl: string
  apiKey: string
}

export function defaultBaseUrlOf(method: AuthMethod): string {
  return DEFAULT_BASE_URL[TARGET_BY_METHOD[method]]
}

/** 解析出某接入方式实际要打的地址与密钥；OAuth 方式返回 null。 */
export function resolveEndpoint(
  method: AuthMethod,
  configs: Record<'anthropic' | 'openai' | 'gemini', ProviderConfig>
): ProviderEndpoint | null {
  if (OAUTH_METHODS.has(method)) return null
  const target = TARGET_BY_METHOD[method]
  const config = configs[target]
  return {
    target,
    baseUrl: config.baseUrl || DEFAULT_BASE_URL[target],
    apiKey: config.apiKey
  }
}

export type ProbeFailure = 'no-key' | 'proxy' | 'http' | 'network'

export type ProbeOutcome =
  | { status: 'ok'; modelIds: string[] }
  | { status: 'failed'; reason: ProbeFailure; httpStatus?: number }

/** 打一次 GET {baseUrl}/models 验证连通性，顺带取回可用模型 id。 */
export async function probeEndpoint(endpoint: ProviderEndpoint): Promise<ProbeOutcome> {
  if (!endpoint.apiKey) return { status: 'failed', reason: 'no-key' }

  const url = `${normalizeApiUrl(endpoint.baseUrl, endpoint.target)}/models`
  let result: Awaited<ReturnType<typeof api.httpFetch>>
  try {
    result = await api.httpFetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${endpoint.apiKey}`,
        'Content-Type': 'application/json'
      }
    })
  } catch {
    return { status: 'failed', reason: 'network' }
  }

  if (!result) return { status: 'failed', reason: 'proxy' }
  if (!result.ok) return { status: 'failed', reason: 'http', httpStatus: result.status }

  let data: unknown
  try {
    data = JSON.parse(result.data)
  } catch {
    return { status: 'failed', reason: 'network' }
  }

  const payload = data as { data?: unknown; models?: unknown }
  const list = Array.isArray(data)
    ? data
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : []

  const modelIds = list
    .map((m: unknown) => {
      if (typeof m === 'string') return m
      const item = m as { id?: string; name?: string }
      return item?.id || item?.name || ''
    })
    .filter(Boolean)

  return { status: 'ok', modelIds }
}
