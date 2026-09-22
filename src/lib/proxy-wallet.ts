/**
 * Polymarket 的代理钱包（proxy wallet）。
 *
 * ## 为什么必须处理它
 *
 * Polymarket 不把用户资金放在 EOA 上，而是放在一个**代理合约**里。
 * 你用 MetaMask 连上来的地址（EOA）只负责签名，钱在代理地址上。
 *
 * 所以直接读 EOA 的 pUSD 余额会显示 $0 —— 即使账户里有钱。
 * 这不是 bug，是 Polymarket 的账户模型。实测就踩到了：钱包面板一片 0。
 *
 * 下单时同样要区分两个地址：
 *   - signer  = EOA，负责 EIP-712 签名，**也是 L2 认证头 POLY_ADDRESS 的值**
 *   - funder  = 代理地址（订单里的 maker / SDK 的 account wallet），资金在那
 *   - signatureType = 3（DEPOSIT_WALLET），不是 EOA 的 0
 *
 * ⚠️ 早先这里写的是「POLY_ADDRESS 必须是代理地址」，**那是错的**，已订正。
 * POLY_ADDRESS 恒为**签名地址**，账户钱包只作为订单的 maker 出现。搞反会
 * 得到 401，而且报错看起来很像「配置错了」，很容易往凭据过期那条路上查。
 * 这一条在交易端项目里也踩过一次（见 src/api/clob-v2.ts 的表头注释）。
 *
 * 另外 signatureType 的口径：3 的官方名是 DEPOSIT_WALLET，社区叫 POLY_1271
 * （因为 Deposit Wallet 走 ERC-1271 验签）。两者指同一个值，别当成两个类型。
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
 * Polymarket 的抵押代币：**pUSD（Polymarket USD）**。
 *
 * 下单能动用的钱、入金到账的钱，都是它。
 *
 * ## 这个地址是怎么定下来的
 *
 * 两条独立证据对上了，不是猜的：
 *
 *  1. **SDK 说的**：`@polymarket/client` 0.10.0 的生产环境（`dist/index.js` 里
 *     唯一一个环境定义，`name:"production", chainId:137`）写着
 *     `contracts.collateralToken = 0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`。
 *     同一份 env 的 `conditionalTokens` 是 `0x4D97DCd9…`（Gnosis CTF，确实是
 *     Polymarket 在用的那个），可排除是笔误。
 *  2. **链上对上了**：一个真实账户入金 4.80 之后，Polygonscan 上显示代理钱包收到
 *     4.80 的 `Polymarket U… (pUSD)` —— 就是这个地址。
 *
 * ## 之前写的 USDC.e 是**上一代**的抵押品
 *
 * `0x2791Bca1…`（USDC.e）是老协议的抵押代币，从这个仓库的早期项目带过来的。
 * 它在整个 `@polymarket/*` 里**一次都没出现过**。
 *
 * 写错的后果特别隐蔽：钱真的到账了，但读的是另一个代币，于是面板恒显示 $0.00，
 * 看起来像入金失败 —— 实测就踩了这个坑，排查了一整轮。
 *
 * ## pUSD 不是「转一笔 ERC-20 过去就有」
 *
 * 链上那笔存款是 **mint**（From 是 `0x000…000`），交易方法是 `handleOps` ——
 * 也就是 ERC-4337 的 UserOp。说明 pUSD 由 Polymarket 的流程铸造，而不是随便
 * 转一笔 ERC-20 到代理钱包就能得到。**这条直接决定了站内存款做不了**，
 * 详见 lib/money.ts 顶部。
 */
export const PUSD_POLYGON = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB' as const

/**
 * Polygon 上的 USDC.e（bridged）。**上一代协议的抵押品，不是现在的。**
 *
 * 读它拿不到「可交易余额」—— 那是 pUSD。留着这个常量是因为面板还要**显示**
 * 签名地址上的 USDC.e（那正是「还没存款时钱在哪」的答案），但站内那条
 * 「自己转一笔过去」的路径已经拆掉了，见 lib/money.ts。
 */
export const USDC_E_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as const

/**
 * 原生 USDC。**不参与下单**，只用来区分签名地址上那笔美元是哪一种 ——
 * 官方的存款流程两种都收，所以有它并不意味着用户做错了什么。
 */
export const USDC_NATIVE_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' as const
