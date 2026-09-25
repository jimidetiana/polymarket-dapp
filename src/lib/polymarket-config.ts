/**
 * CLOB V2 栈的少量前端配置。
 *
 * 抵押代币等合约地址不在这里硬编码 —— v2 SDK（`@polymarket/client`）内部按 production
 * 环境自带（当前抵押品是 **pUSD**），下单/授权都由它处理。这里只放前端要用到的东西。
 */

export const POLYGON_CHAIN_ID = 137

/**
 * builder 归因 / 免 gas 部署的远程签名端点：薄后端 `/api/polymarket/sign`（HMAC，密钥
 * 在后端）。传给 v2 SDK 的 `remoteBuilderSigning({ url })`。
 *
 * 三种形态：
 *   - 开发：两个 VITE_SIGN_URL_* 都留空 -> 同源 `/api/polymarket/sign`，vite proxy 转本地 sign-server。
 *   - 生产双活：把 Cloudflare Workers / Deno Deploy 两个绝对地址分别填进 PRIMARY / FALLBACK。
 *     两端**完全对等、无状态**（同一份 secret 各配一遍），不是主从 —— 只是探活后择一。
 *   - 只填 PRIMARY：就用它，无 fallback。
 */
const PRIMARY = (import.meta.env.VITE_SIGN_URL_PRIMARY ?? '').trim()
const FALLBACK = (import.meta.env.VITE_SIGN_URL_FALLBACK ?? '').trim()

function sameOriginUrl(): string {
  return typeof window !== 'undefined'
    ? `${window.location.origin}/api/polymarket/sign`
    : '/api/polymarket/sign'
}

/** 同步默认值（向后兼容旧调用）：首选 PRIMARY，否则同源。不做探活。*/
export function remoteSigningUrl(): string {
  return PRIMARY || sameOriginUrl()
}

let cachedUrl: string | null = null

/**
 * 探活：对候选端点发 OPTIONS（就是 CORS 预检，core 会回 204），2.5s 超时。
 * 不消耗签名、不需要凭据，纯粹判端点是否在线。
 */
async function probe(url: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    const res = await fetch(url, { method: 'OPTIONS', signal: ctl.signal })
    clearTimeout(t)
    return res.ok || res.status === 204
  } catch {
    return false
  }
}

/**
 * 择一可用的签名端点：依次探 PRIMARY -> FALLBACK，取第一个活的，本会话缓存。
 * 都没配（开发）就用同源、不探活。都探测失败也返回 PRIMARY —— 让真实请求抛出真实
 * 错误，而不是无声吞掉。
 *
 * 局限（诚实说明）：探活发生在建 client 时；主端点在会话中途宕机，本次不会自动切
 * （SDK 只吃一个 url、无 per-call 故障转移钩子）。建 client 失败时 use-clob/getSecureClient
 * 会清缓存并重探（见 resetSigningUrl）。
 */
export async function resolveSigningUrl(): Promise<string> {
  if (cachedUrl) return cachedUrl
  const candidates = [PRIMARY, FALLBACK].filter(Boolean)
  if (candidates.length === 0) {
    cachedUrl = sameOriginUrl()
    return cachedUrl
  }
  if (candidates.length === 1) {
    // 只有一个端点：探活无意义（探成功用它、探失败也用它），直接用，省掉一次 OPTIONS 等待。
    const only = candidates[0]!
    cachedUrl = only
    return only
  }
  for (const url of candidates) {
    if (await probe(url)) {
      cachedUrl = url
      return url
    }
  }
  const chosen = candidates[0]! // 非空：上面已 return 掉 length===0 的情况
  cachedUrl = chosen
  return chosen
}

/** 清掉本会话缓存的端点选择，下次 resolveSigningUrl 会重新探活。*/
export function resetSigningUrl(): void {
  cachedUrl = null
}
