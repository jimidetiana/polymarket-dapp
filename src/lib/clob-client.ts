/**
 * 浏览器内的 CLOB V2 下单客户端（`@polymarket/client`）。
 *
 * ## 门户模型：非托管 + 免 gas 部署 + builder 归因
 *
 * 用户用自己的 MetaMask 在浏览器里签名，我们**永远看不到私钥**。下单走 Polymarket
 * 现在的 **CLOB V2**（2026-04 升级，抵押代币 **pUSD**，账户走 **Deposit Wallet**）。
 *
 * 两个关键点（都由 v2 SDK 完成）：
 *  1. **Deposit Wallet flow**：createSecureClient 时**不传 wallet**，SDK 用签名者的
 *     确定性 Deposit Wallet 当账户（signatureType=POLY_1271）。这正是交易所要求的
 *     「deposit wallet flow」。
 *  2. **免 gas 部署 + 归因**：给 createSecureClient 传 `apiKey: remoteBuilderSigning({url})`
 *     打开 supportsGasless —— SDK 会免 gas 地部署 Deposit Wallet、设置授权；builder
 *     密钥留在后端（url 指向 /api/polymarket/sign 的 HMAC 端点），不进前端包。
 *     下单再挂 `builderCode` 做归因，门户靠它抽成。
 *
 * POLY_ADDRESS（L2 认证头）恒为**签名地址**，账户/Deposit Wallet 只作为订单 maker。
 * 搞反会 401。SDK 内部已处理，别改回去。
 */
import { createPublicClient, createSecureClient, OrderSide, remoteBuilderSigning, type SecureClient } from '@polymarket/client'
import { fetchBuilderFeeRates } from '@polymarket/client/actions'
import { signerFrom } from '@polymarket/client/viem'
import { createPublicClient as createViemPublicClient, erc1155Abi, erc20Abi, http, type WalletClient } from 'viem'
import { polygon } from 'viem/chains'
import { builderCode } from './builder'
import { resolveSigningUrl, resetSigningUrl } from './polymarket-config'
import { PUSD_POLYGON } from './proxy-wallet'

export type OrderSideName = 'BUY' | 'SELL'
export type OrderKind = 'market' | 'limit'

type OrderResponseLike = Awaited<ReturnType<SecureClient['placeLimitOrder']>>

export type PlacedOrder = {
  orderId: string
  status: string
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

export type ApprovalState = {
  isFullyApproved: boolean
  missingCount: number
}

const publicClient = createPublicClient()

/**
 * 经典 **NegRiskAdapter**（neg-risk 市场的抵押包装合约，链上确定性地址）。
 *
 * ⚠️ 这是「余额够却下不了单」的根因所在。V2 SDK 的 `setupTradingApprovals` 会给 pUSD
 * 授权 7 个花费者（standardExchange / negRiskExchange / collateralAdapter /
 * **negRiskCollateralAdapter** / protocolV2Router / exchangeV3 / perpsDepositContract），
 * 但**唯独漏了这个经典 negRiskAdapter**（清单里 neg-risk 侧只有 pUSD 时代的
 * negRiskCollateralAdapter，不是它）。
 *
 * 而**遗留的 neg-risk 市场**（体育多选盘最常见）下单时，CLOB 仍按「pUSD 对
 * negRiskAdapter 的 allowance」校验，缺了就拒单——报文正是：
 *   `not enough balance / allowance: the allowance is not enough ->`
 *   `spender: 0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296, allowance: 0`
 * 余额其实是够的（拒的是 allowance，不是 balance）。所以 createClient 里在 SDK 那套
 * 授权之外，**单独补这一把**。地址取自 SDK production env 的 `contracts.negRiskAdapter`。
 */
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296' as const

/**
 * Gnosis **ConditionalTokens（CTF）**——所有结果代币（Yes/No 份额）的 ERC-1155 合约。
 * 地址取自 SDK production env 的 `contracts.conditionalTokens`。
 *
 * ⚠️ **卖出**的对偶缺口（和上面 negRiskAdapter 的 pUSD 缺口一模一样，只是换到 ERC-1155
 * 这一侧）。买入花的是 pUSD（ERC-20），补的是 pUSD→negRiskAdapter 的 allowance；卖出
 * 交割的是**结果代币本身**（ERC-1155），交易所要 maker 把 negRiskAdapter 设成
 * `setApprovalForAll` 的算子才能拉走代币。SDK 的 setupTradingApprovals 同样漏了经典
 * negRiskAdapter 这一把，于是遗留 neg-risk 市场**卖出**时被拒，报文里的 `allowance: 0` +
 * `spender: 0xd91E80…` 其实是「CTF 对 negRiskAdapter 未授权算子」，且 `order amount` 等于
 * **份额**（5 份 = 5000000），不是 pUSD 收款额——正说明校验的是结果代币这一侧。
 */
const CONDITIONAL_TOKENS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as const

/** 只读一次 allowance 用的轻量 viem 客户端（Polygon，用 SDK 同款 RPC）。 */
const readClient = createViemPublicClient({ chain: polygon, transport: http('https://polygon.drpc.org') })

export async function fetchBook(assetId: string) {
  return publicClient.fetchOrderBook({ assetId })
}

/** 查本 builder code 的实际费率。SDK 已把 bps ÷10000，这里乘回来。拿不到返回 null。 */
export async function fetchFeeRates(): Promise<{ makerBps: number; takerBps: number } | null> {
  const code = builderCode()
  if (!code) return null
  const r = await fetchBuilderFeeRates(publicClient, { builderCode: code })
  return { makerBps: Number(r.maker) * 10_000, takerBps: Number(r.taker) * 10_000 }
}

// ── 已认证客户端（每个签名地址一个，缓存 Promise）──────────
const CLIENTS = new Map<string, Promise<SecureClient>>()

export type SecureClientRequest = {
  /** 签名者地址（EOA）。POLY_ADDRESS 用它 */
  eoa: string
  walletClient: WalletClient
}

export function getSecureClient(req: SecureClientRequest): Promise<SecureClient> {
  const key = req.eoa.toLowerCase()
  const hit = CLIENTS.get(key)
  if (hit) return hit
  const p = createClient(req).catch((e: unknown) => {
    CLIENTS.delete(key) // 失败不留坏缓存
    resetSigningUrl() // 也清端点选择：下次重新探活（主端点可能中途宕机）
    throw e
  })
  CLIENTS.set(key, p)
  return p
}

export function resetSecureClients(): void {
  CLIENTS.clear()
}

async function createClient({ eoa, walletClient }: SecureClientRequest): Promise<SecureClient> {
  const signer = signerFrom(walletClient)
  // 不传 wallet → SDK 用签名者的确定性 Deposit Wallet（POLY_1271）当账户/funder。
  // apiKey: remoteBuilderSigning 打开 supportsGasless —— SDK 就能**免 gas 部署 Deposit
  // Wallet、设置 pUSD 授权**（builder 密钥在后端 url，不进前端）。这一步会让用户签一次名
  // 派生 L2 凭据（每会话一次）；部署/授权按需进行。
  // 探活择一签名端点（PRIMARY->FALLBACK->同源），见 polymarket-config.resolveSigningUrl
  const signingUrl = await resolveSigningUrl()
  const client = await createSecureClient({
    signer,
    apiKey: remoteBuilderSigning({ url: signingUrl }),
  })

  const acct = client.account
  const gotSigner = String(acct?.signer ?? '').toLowerCase()
  // signer 对不上要拒签：钱包扩展可能在弹窗期间被切了账号。
  if (gotSigner !== eoa.toLowerCase()) {
    throw new Error(`账户自检失败：签名地址解析成 ${gotSigner}，期望 ${eoa.toLowerCase()}`)
  }
  // walletType 应为 DEPOSIT_WALLET、下单弹窗 SignatureType 应为 3（POLY_1271）。
  // 若下单报余额不足，看这里的 wallet 是不是那个有钱的地址。别删。
  console.info('[clob] 账户身份：', {
    signer: acct?.signer,
    signerType: acct?.signerType,
    wallet: acct?.wallet,
    walletType: acct?.walletType,
  })

  // V2 首次交易必须先给账户在新交易所/pUSD 抵押适配器上做**交易授权**（免 gas，靠
  // apiKey 的 supportsGasless）。**没授权时，钱在账户里但交易所看到的"可用余额"是 0**
  // —— 实测就是那条 `not enough balance/allowance ... balance: 0` 拒单（账户 0x171c
  // 链上有 $4.80 pUSD，却因未授权而被判 0）。幂等：已授权就跳过。授权由 SDK 处理
  // 具体 adapter 地址（CtfCollateralAdapter / NegRiskCtfCollateralAdapter）。
  const wallet = String(acct?.wallet ?? '')
  if (wallet) {
    try {
      const st = await publicClient.fetchTradingApprovalsState({ user: wallet })
      if (!st.isFullyApproved) {
        console.info('[clob] 交易授权未就绪，正在免 gas 补齐…')
        await client.setupTradingApprovals()
      }
    } catch (e) {
      console.warn('[clob] 交易授权检查/设置失败（继续；下单可能仍报余额/授权不足）：', e)
    }

    // 补 SDK 漏掉的那把：pUSD → 经典 negRiskAdapter（见 NEG_RISK_ADAPTER 注释）。
    // 上面 fetchTradingApprovalsState 的 isFullyApproved **不含**这个 adapter，所以
    // 即便它返回「已全部授权」，neg-risk 市场仍会因这把缺失而被拒。单独查/补，与 SDK
    // 那套解耦。幂等：先读链上 allowance，为 0 才免 gas 授 max —— 一次会话最多一次。
    try {
      const allowance = (await readClient.readContract({
        address: PUSD_POLYGON,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [wallet as `0x${string}`, NEG_RISK_ADAPTER],
      })) as bigint
      if (allowance === 0n) {
        console.info('[clob] pUSD 对 negRiskAdapter 未授权，正在免 gas 补齐…')
        const handle = await client.approveErc20({
          tokenAddress: PUSD_POLYGON,
          spenderAddress: NEG_RISK_ADAPTER,
          amount: 'max',
        })
        await handle.wait()
      }
    } catch (e) {
      console.warn('[clob] negRiskAdapter 授权检查/设置失败（继续；neg-risk 市场下单可能仍报授权不足）：', e)
    }

    // 卖出对偶：补 CTF（结果代币，ERC-1155）→ 经典 negRiskAdapter 的算子授权（见
    // CONDITIONAL_TOKENS 注释）。上面那把是 pUSD（买入侧），这把是结果代币（卖出侧）——
    // 缺了它，遗留 neg-risk 市场**卖出**会被拒：`allowance: 0 ... spender: 0xd91E80…`。
    // 与 SDK 那套解耦、单独查/补。幂等：先读链上 isApprovedForAll，未授权才免 gas 授权。
    try {
      const approved = (await readClient.readContract({
        address: CONDITIONAL_TOKENS,
        abi: erc1155Abi,
        functionName: 'isApprovedForAll',
        args: [wallet as `0x${string}`, NEG_RISK_ADAPTER],
      })) as boolean
      if (!approved) {
        console.info('[clob] CTF 对 negRiskAdapter 未授权算子（卖出会被拒），正在免 gas 补齐…')
        const handle = await client.approveErc1155ForAll({
          tokenAddress: CONDITIONAL_TOKENS,
          operatorAddress: NEG_RISK_ADAPTER,
        })
        await handle.wait()
      }
    } catch (e) {
      console.warn('[clob] CTF→negRiskAdapter 算子授权检查/设置失败（继续；neg-risk 市场卖出可能仍报授权不足）：', e)
    }
  }
  return client
}

// ── 下单 ────────────────────────────────────────────────

export type PlaceRequest = {
  assetId: string
  side: OrderSideName
  kind: OrderKind
  /** 单价 0~1。限价=挂单价；市价买=最差可接受价（当前卖一）；市价卖=最差可接受价（当前买一） */
  price: number
  /** 份额。市价买由它 × price 得美元名义额 */
  size: number
}

function usdOf(size: number, price: number): number {
  return Math.round(size * price * 100) / 100
}

/** 每个分支都挂 builderCode（门户归因）。三种请求字段不同，不强行合并。 */
export async function placeOrder(client: SecureClient, req: PlaceRequest): Promise<PlaceOutcome> {
  const side = req.side === 'BUY' ? OrderSide.BUY : OrderSide.SELL
  const builder = builderCode()

  if (req.kind === 'limit') {
    return normalize(
      await client.placeLimitOrder({ assetId: req.assetId, price: req.price, size: req.size, side, builderCode: builder }),
    )
  }
  if (side === OrderSide.BUY) {
    return normalize(
      await client.placeMarketOrder({
        assetId: req.assetId,
        side: OrderSide.BUY,
        amount: usdOf(req.size, req.price),
        maxPrice: req.price,
        builderCode: builder,
      }),
    )
  }
  return normalize(
    await client.placeMarketOrder({
      assetId: req.assetId,
      side: OrderSide.SELL,
      shares: req.size,
      minPrice: req.price,
      builderCode: builder,
    }),
  )
}

/** 交易所拒单是返回值 ok:false，不抛；签名/网络错才抛。 */
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

// ── 授权 / 挂单 / 撤单 ───────────────────────────────────

/** 查授权状态（只读、不弹签名，走公共客户端）。 */
export async function fetchApprovalState(wallet: string): Promise<ApprovalState> {
  const s = await publicClient.fetchTradingApprovalsState({ user: wallet })
  const erc20 = s.missing?.erc20?.length ?? 0
  const erc1155 = s.missing?.erc1155?.length ?? 0
  return { isFullyApproved: s.isFullyApproved, missingCount: erc20 + erc1155 }
}

/** 补齐交易授权（V2 的 pUSD 抵押适配器由 SDK 内部处理；免 gas，需 supportsGasless）。 */
export async function setupApprovals(client: SecureClient): Promise<void> {
  await client.setupTradingApprovals()
}

export async function listOpenOrders(client: SecureClient): Promise<OpenOrderRow[]> {
  // 翻**所有页**，不再只取 firstPage —— 挂单多于一页时 firstPage 会漏后面几页。
  // Paginated 是 async-iterable，for await 会自动跟着 nextCursor 走到没有下一页。
  const items: Array<Record<string, unknown>> = []
  for await (const page of client.listOpenOrders({})) {
    if (Array.isArray(page?.items)) items.push(...(page.items as Array<Record<string, unknown>>))
  }

  // 诊断：查不到挂单时，先分清是「这个账户名下确实没有 resting 单」还是「订单挂在
  // 另一个地址上」。account.wallet 是我们查询/下单用的 maker；order.owner / makerAddress
  // 是 CLOB 记的订单归属。两者对不上 = 身份问题；对得上却为 0 = 真的没有 resting 单
  // （多半是那笔限价单其实成交了）。别删——这是「下单成功却查不到」唯一的现场线索。
  const acct = client.account
  console.info('[clob] listOpenOrders：', {
    authWallet: acct?.wallet,
    authSigner: acct?.signer,
    count: items.length,
    owners: Array.from(new Set(items.map((o) => String(o.owner ?? '')))).filter(Boolean),
    makers: Array.from(new Set(items.map((o) => String(o.makerAddress ?? '')))).filter(Boolean),
  })

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

export async function cancelOrderById(client: SecureClient, orderId: string): Promise<string> {
  const r = await client.cancelOrder({ orderId })
  const canceled = Array.isArray((r as { canceled?: unknown }).canceled)
    ? (r as { canceled: unknown[] }).canceled.map(String)
    : []
  const notCanceled = (r as { notCanceled?: Record<string, string> }).notCanceled ?? {}
  const failed = Object.keys(notCanceled)
  if (failed.length) return `部分未撤销：${failed.map((id) => `${id}（${notCanceled[id]}）`).join('、')}`
  if (canceled.includes(orderId)) return '已撤销'
  return '已提交撤销请求'
}

// ── 错误翻译 ─────────────────────────────────────────────

/** 沿 cause 链取类名与报文（按字段取而非 instanceof —— 跨 realm 的 Error instanceof 会失灵）。 */
function errorChain(e: unknown): { name: string; msgs: string[] } {
  let name = ''
  const msgs: string[] = []
  let cur: unknown = e
  for (let i = 0; cur != null && i < 6; i++) {
    if (typeof cur === 'string') { msgs.push(cur); break }
    if (typeof cur !== 'object') { msgs.push(String(cur)); break }
    const o = cur as Record<string, unknown>
    if (!name && typeof o.name === 'string') name = o.name
    for (const k of ['shortMessage', 'message']) {
      const v = o[k]
      if (typeof v === 'string' && v) msgs.push(v)
    }
    cur = o.cause
  }
  return { name, msgs }
}

/**
 * 把异常翻成人话。只把「签名被取消 / 用户主动拒绝」翻成"你拒绝了签名"，
 * 别把服务端拒单（RequestRejectedError 名字里带 Rejected）也吞成那样。
 */
export function explainError(e: unknown): string {
  const { name, msgs } = errorChain(e)
  const innermost = msgs[msgs.length - 1] ?? ''
  const all = [name, ...msgs].join(' | ')
  console.error('[clob] 原始错误：', e)

  const isCancel = /CancelledSigning/i.test(name) ||
    /UserRejectedRequest/i.test(name) ||
    /user (rejected|denied|cancell?ed)/i.test(all) ||
    /\b4001\b/.test(all)
  if (isCancel) {
    return innermost ? `你在钱包里拒绝了这次签名。（钱包回报：${innermost}）` : '你在钱包里拒绝了这次签名。'
  }
  return innermost || String(e)
}
