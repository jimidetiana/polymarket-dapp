/**
 * Polymarket 的代理钱包（proxy wallet）。
 *
 * ## 为什么必须处理它
 *
 * Polymarket 不把用户资金放在 EOA 上，而是放在一个**代理合约**里。
 * 你用 MetaMask 连上来的地址（EOA）只负责签名，钱在代理地址上。
 *
 * 所以直接读 EOA 的 USDC.e 余额会显示 $0 —— 即使账户里有钱。
 * 这不是 bug，是 Polymarket 的账户模型。实测就踩到了：钱包面板一片 0。
 *
 * 下单时同样要区分两个地址（见原型 src/api/clob.ts 的注释）：
 *   - signer  = EOA，负责 EIP-712 签名
 *   - funder  = 代理地址，L2 认证头里的 POLY_ADDRESS 必须是它
 *   - signatureType = POLY_1271（合约签名），不是 EOA 的 0
 * 三者对不上，CLOB 会拒单或返回令人费解的错误。
 *
 * ## 代理地址怎么拿
 *
 * 只能问 Polymarket：`GET /public-profile?address=<EOA>` → `proxyWallet`。
 * **不能本地推导** —— 它是工厂合约按 CREATE2 部署的，salt 规则不公开且可能变。
 * 原型里也是这么做的（src/api/clob-v2.ts 的 getFunderAddress）。
 *
 * 没有 profile（返回 404）说明这个地址还没在 Polymarket 上开过户，
 * 此时没有代理地址，也就无法交易 —— 要先去 polymarket.com 存一次款。
 * 这种情况要明确告诉用户，而不是显示 $0 让人以为是余额问题。
 */

const GAMMA_BASE = 'https://gamma-api.polymarket.com'

export type PolyProfile = {
  /** 代理钱包地址。资金与持仓都在这里 */
  proxyWallet: string
  /** 用户名，可能为空 */
  name?: string | null
  /** 头像 */
  profileImage?: string | null
}

export type ProxyLookup =
  | { status: 'ok'; proxyWallet: `0x${string}`; profile: PolyProfile }
  /** 地址没在 Polymarket 开过户，需要先去官网存款 */
  | { status: 'no-account' }
  | { status: 'error'; message: string }

/**
 * 查代理钱包地址。
 *
 * 浏览器直连 Gamma API（无需后端）。CORS 是放开的 —— 这是公开只读接口。
 */
export async function lookupProxyWallet(eoa: string): Promise<ProxyLookup> {
  try {
    const url = `${GAMMA_BASE}/public-profile?address=${encodeURIComponent(eoa)}`
    const res = await fetch(url)
    if (res.status === 404) return { status: 'no-account' }
    if (!res.ok) return { status: 'error', message: `HTTP ${res.status}` }
    const data = (await res.json()) as PolyProfile | null
    const pw = data?.proxyWallet
    if (!pw || !/^0x[0-9a-fA-F]{40}$/.test(pw)) return { status: 'no-account' }
    return { status: 'ok', proxyWallet: pw as `0x${string}`, profile: data as PolyProfile }
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Polygon 上的 USDC.e（bridged）。Polymarket 用的是这个，不是原生 USDC。
 * 读错代币会显示 0 余额，看起来像没充钱。
 */
export const USDC_E_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as const

/** 原生 USDC，仅用于「钱可能存错代币了」这种提示，不参与下单 */
export const USDC_NATIVE_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' as const
