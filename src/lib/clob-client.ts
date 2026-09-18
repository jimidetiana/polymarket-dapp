/**
 * 浏览器内的 CLOB 下单客户端。
 *
 * ## 为什么不走后端
 *
 * dapp 是**独立项目**，没有服务端。原项目（polymarket-trader）的下单链路是
 * `前端 → POST /api/soccer/orders → 后端 placeOrder()`，私钥与 CLOB 凭据都在
 * 服务端。这里整条搬进浏览器：签名由用户钱包完成，dapp 只拿到「签名能力」，
 * **永远看不到私钥**——这是钱包扩展的安全边界，不是我们代码的选择。
 *
 * ## 为什么用官方 @polymarket/client 而不是自己签
 *
 * 这个账户是 Deposit Wallet（signatureType=3），Exchange 的 Order 结构
 * **不能直接签**，要再套一层 ERC-7739 的 TypedDataSign 外壳，域名是
 * {name:'DepositWallet', version:'1', chainId:137, verifyingContract:<账户钱包>}。
 *
 * 自己写这一层，等于**重造一个已经存在的、且我们无力验证的签名实现**。
 * 2026-09 那次供应链投毒的教训正是「别在够不着的地方自己造」，所以调官方
 * SDK，包装层在它内部完成。
 *
 * 选包时按事故后的流程核过 @polymarket/client 0.10.0：editDistance 0、
 * 无安装脚本、仓库 github.com/Polymarket/ts-sdk、lock 里 240 条全部来自
 * registry.npmjs.org，deep-scan 的 6 条命中逐条有解释（base64url 解 L2 签名、
 * 分页游标、JSDoc 里的 process.env）。它还**没有 node 内建依赖**：
 * 默认入口 dist/index.js 只 import zod/ox/ky/viem/@msgpack/it-pushable，
 * 所以 Vite 打得出浏览器包（`process` 只在单独的 `./node` 子路径里，我们不碰）。
 *
 * ## POLY_ADDRESS 是签名地址，不是账户地址
 *
 * 项目里踩过一次：L2 认证头的 POLY_ADDRESS 必须是**签名者（EOA）**，
 * 账户/代理钱包只作为订单的 `maker` 出现。搞反会 401，而且看起来很像
 * 「配置错了」。SDK 内部已经处理，这条注释是防止以后有人「顺手改回去」。
 */
import { createPublicClient, createSecureClient, OrderSide, type SecureClient } from '@polymarket/client'
import { signerFrom } from '@polymarket/client/viem'
import type { WalletClient } from 'viem'

export type OrderSideName = 'BUY' | 'SELL'
export type OrderKind = 'market' | 'limit'

/**
 * SDK 的响应形状。
 *
 * 不 import `OrderResponse` 这个名字：它由 `export * from '@polymarket/bindings/clob'`
 * 转发，能不能从根导出取决于 `export *` 的冲突消解规则，靠推导拿更稳。
 *
 * 记住它的语义：**交易所拒单是返回值，不是异常**。签名/网络/入参错才抛。
 * 所以 `ok === false` 这条分支必须写，漏了就会把拒单当成功。
 */
type OrderResponseLike = Awaited<ReturnType<SecureClient['placeLimitOrder']>>

export type PlacedOrder = {
  orderId: string
  /** 交易所给的原值：matched / live / delayed / unmatched。不翻译，翻译会丢信息 */
  status: string
  /** 本方付出 / 收到。市价买单通常 making=USDC、taking=份额 */
  makingAmount: string
  takingAmount: string
  tradeIds: string[]
}

export type PlaceOutcome =
  | { ok: true; order: PlacedOrder }
  | { ok: false; code: string; message: string }

export type OpenOrderRow = {
  id: string
  assetId: string
  side: string
  price: string
  originalSize: string
  sizeMatched: string
  orderType: string
  status: string
  createdAt: string
}

/**
 * 无鉴权的公共客户端，只用来读盘口深度。
 *
 * 模块级建一次：`createPublicClient()` 是同步的、无状态的，每次渲染建一个
 * 只是白扔对象。深度不订阅 WS——盘口深度用 WS 要维护增量 diff，
 * 而这里只需要「此刻大概什么价能成交」，轮询足够且不会错。
 */
const publicClient = createPublicClient()

export async function fetchBook(assetId: string) {
  return publicClient.fetchOrderBook({ assetId })
}

// ── 已认证客户端（每个 签名地址+账户钱包 组合一个）────────────

/**
 * 缓存的是 **Promise 而不是 client**：createSecureClient 是异步的
 * （要派生/创建 L2 凭据，中间会让用户签一次名），React 严格模式下
 * effect 会跑两遍，缓存 Promise 才能保证只弹一次签名。
 */
const CLIENTS = new Map<string, Promise<SecureClient>>()

export type SecureClientRequest = {
  /** 签名者地址（EOA）。POLY_ADDRESS 用的就是它 */
  eoa: string
  /** 账户/资金钱包（Deposit Wallet / 代理钱包）。订单的 maker 用它 */
  accountWallet: string
  walletClient: WalletClient
}

export function getSecureClient(req: SecureClientRequest): Promise<SecureClient> {
  // 地址大小写不敏感，但 Map 的键敏感 —— 不归一化会缓存出两份来
  const key = `${req.eoa.toLowerCase()}:${req.accountWallet.toLowerCase()}`
  const hit = CLIENTS.get(key)
  if (hit) return hit

  const p = createClient(req).catch((e: unknown) => {
    // 失败**不能**把坏 Promise 留在缓存里：否则用户换了网络/重试也永远
    // 拿到同一个错误，而界面上看不出是缓存。删掉，下次重建。
    CLIENTS.delete(key)
    throw e
  })
  CLIENTS.set(key, p)
  return p
}

/** 丢弃缓存。换钱包、切链、或用户明确要求重连时调用 */
export function resetSecureClients(): void {
  CLIENTS.clear()
}

async function createClient({ eoa, accountWallet, walletClient }: SecureClientRequest): Promise<SecureClient> {
  const signer = signerFrom(walletClient)
  // 不传 credentials → SDK 用 nonce=0 派生（必要时创建）一套 L2 凭据。
  // 这一步要用户签一次名（L1 消息，不上链、不花 gas），是**每会话一次**，
  // 不是每单一次 —— 凭据缓存到 CLIENTS 里。
  const client = await createSecureClient({ wallet: accountWallet, signer })

  // ── 自检 ──────────────────────────────────────────────
  //
  // 这两条不是把入参读回来做断言（那是回声，等于没查）：
  // SDK 会在传入的 wallet 不是受支持的 Poly 钱包时**回落到签名者的确定性
  // Deposit Wallet**，所以 account 是它按自己的规则算出来的结果。对不上
  // 就说明它会拿一个我们没打算用的地址当 maker —— 那种单必须拒签。
  // signer 那一条另有意义：钱包扩展可能在弹窗期间被切了账号。
  const acct = client.account
  const gotSigner = String(acct?.signer ?? '').toLowerCase()
  const gotWallet = String(acct?.wallet ?? '').toLowerCase()
  if (gotSigner !== eoa.toLowerCase()) {
    throw new Error(`账户自检失败：签名地址解析成 ${gotSigner}，期望 ${eoa.toLowerCase()}`)
  }
  if (gotWallet !== accountWallet.toLowerCase()) {
    throw new Error(
      `账户自检失败：SDK 把账户钱包解析成 ${gotWallet}，期望 ${accountWallet.toLowerCase()}。` +
        `这个地址可能不是 Deposit Wallet / Safe / Proxy，已拒绝签名。`,
    )
  }
  return client
}

// ── 下单 ────────────────────────────────────────────────

export type PlaceRequest = {
  assetId: string
  side: OrderSideName
  kind: OrderKind
  /**
   * 单价（0~1）。
   *  - 限价：挂单价
   *  - 市价买：**最差可接受价**（传当前卖一，见下）
   *  - 市价卖：**最差可接受价**（传当前买一）
   */
  price: number
  /** 份额。市价买由它乘 price 得到美元名义额 */
  size: number
}

export async function placeOrder(client: SecureClient, req: PlaceRequest): Promise<PlaceOutcome> {
  const side = req.side === 'BUY' ? OrderSide.BUY : OrderSide.SELL

  if (req.kind === 'limit') {
    return normalize(
      await client.placeLimitOrder({
        assetId: req.assetId,
        price: req.price,
        size: req.size,
        side,
      }),
    )
  }

  if (side === OrderSide.BUY) {
    return normalize(
      await client.placeMarketOrder({
        assetId: req.assetId,
        side: OrderSide.BUY,
        // 市价买单收的是**美元名义额**，不是份额。表单里那一栏是份额，
        // 所以在这里换算。传的就是界面「预估总额」显示的那个数——
        // 两边不一致等于界面在骗人。
        amount: usdOf(req.size, req.price),
        maxPrice: req.price,
      }),
    )
  }

  return normalize(
    await client.placeMarketOrder({
      assetId: req.assetId,
      side: OrderSide.SELL,
      shares: req.size,
      minPrice: req.price,
    }),
  )
}

/**
 * 份额 × 单价 → 美元，保留两位。
 *
 * 只用于市价买单的 amount。走 Math.round 而不是直接乘：0.07×3 在浮点下是
 * 0.21000000000000002，传给 API 虽不至于错，但日志和界面会显示一串尾巴。
 * 与 lib/tick.ts 是同一原则——钱的数不裸浮点。
 */
function usdOf(size: number, price: number): number {
  return Math.round(size * price * 100) / 100
}

function normalize(r: OrderResponseLike): PlaceOutcome {
  if (r.ok) {
    return {
      ok: true,
      order: {
        orderId: String(r.orderId),
        status: String(r.status),
        makingAmount: String(r.makingAmount),
        takingAmount: String(r.takingAmount),
        tradeIds: Array.isArray(r.tradeIds) ? r.tradeIds.map(String) : [],
      },
    }
  }
  return { ok: false, code: String(r.code), message: String(r.message) }
}

/**
 * 把 SDK 抛出来的异常翻译成人能看懂的话。
 *
 * 钱包里点「拒绝」是最常见的一种，而它抛出来的原文（CancelledSigningError）
 * 对用户毫无意义——不说清楚会让人以为是程序坏了，然后反复重试。
 */
export function explainError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const name = e instanceof Error ? e.name : ''
  if (/cancel|reject|denied|user refused/i.test(name) || /user (rejected|denied|cancell?ed)/i.test(raw)) {
    return '你在钱包里拒绝了这次签名。'
  }
  return raw
}

// ── 挂单与撤单 ───────────────────────────────────────────

/**
 * 我的挂单。
 *
 * 不传过滤条件 = 全部市场。原来只显示本盘口的，但跨市场看才看得出
 * 「还有几笔没成交」，而且撤单按钮在同一个列表里更顺手。
 */
export async function listOpenOrders(client: SecureClient): Promise<OpenOrderRow[]> {
  const page = await client.listOpenOrders({}).firstPage()
  const items = Array.isArray(page?.items) ? page.items : []
  return items.map((o) => ({
    id: String(o.id),
    assetId: String(o.assetId),
    side: String(o.side),
    price: String(o.price),
    originalSize: String(o.originalSize),
    sizeMatched: String(o.sizeMatched),
    orderType: String(o.orderType),
    status: String(o.status),
    createdAt: String(o.createdAt),
  }))
}

/** 撤单。返回是否全部撤销成功 */
export async function cancelOrderById(client: SecureClient, orderId: string): Promise<string> {
  const r = await client.cancelOrder({ orderId })
  // 响应里带 canceled 与 notCanceled 两组，部分失败是可能的 —— 不能只看
  // 「没抛异常」就当成功。
  const canceled = Array.isArray((r as { canceled?: unknown }).canceled)
    ? ((r as { canceled: unknown[] }).canceled.map(String))
    : []
  const notCanceled = (r as { notCanceled?: Record<string, string> }).notCanceled ?? {}
  const failed = Object.keys(notCanceled)
  if (failed.length) return `部分未撤销：${failed.map((id) => `${id}（${notCanceled[id]}）`).join('、')}`
  if (canceled.includes(orderId)) return '已撤销'
  return '已提交撤销请求'
}
