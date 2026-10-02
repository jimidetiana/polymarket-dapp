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
import { fetchBuilderFeeRates, fetchMarketInfo } from '@polymarket/client/actions'
import { signerFrom } from '@polymarket/client/viem'
import { createPublicClient as createViemPublicClient, erc1155Abi, erc20Abi, http, type WalletClient } from 'viem'
import { polygon } from 'viem/chains'
import { builderCode } from './builder'
import { tr } from './i18n'
import { resolveSigningUrl, resetSigningUrl } from './polymarket-config'
import { PUSD_POLYGON } from './proxy-wallet'
import type { MarketFee } from './fee'

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

/** 与 V2 下单使用同一份盘口元数据，免鉴权；零费率也原样保留。 */
export async function fetchPolymarketFee(conditionId: string): Promise<MarketFee> {
  const { feeInfo } = await fetchMarketInfo(publicClient, { conditionId })
  if (!Number.isFinite(feeInfo.rate) || feeInfo.rate < 0 ||
      !Number.isFinite(feeInfo.exponent) || feeInfo.exponent < 0) {
    throw new Error('Invalid Polymarket market fee')
  }
  return feeInfo
}

// ── 已认证客户端（每个签名地址一个，缓存 Promise）──────────
const CLIENTS = new Map<string, Promise<SecureClient>>()
/** 查挂单 / 撤单专用的那一份，见 getReadClient */
const READ_CLIENTS = new Map<string, Promise<SecureClient>>()

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
  READ_CLIENTS.clear()
}

/**
 * 查挂单 / 撤单专用的已认证客户端：和 getSecureClient **同一套 L2 凭据、同一个账户
 * 钱包**，唯一的区别是**不带 builder 头**。
 *
 * 为什么要第二个：createSecureClient 传了 `apiKey: remoteBuilderSigning` 之后，SDK 给
 * 发往 CLOB 的**每一个**请求都挂 POLY_BUILDER_* 头（它的 resolveClobHeaders 不分请求
 * 方法），连 GET /data/orders 也挂（经典 clob-client 的 getOpenOrders 也特意这么挂，
 * 注释管它叫 builders flow —— 带不带这组头，CLOB 走的不是同一条路）。实测那样查：
 * 鉴权通过、正常返回，但恒为 0 条，而同一笔单在官网上挂着。我们的请求比官网多出来的
 * 就是这组头，所以查挂单改走不带它的常规路径。撤单同理（经典 clob-client 撤单本来就不挂）。
 *
 * ⚠️ 这一条是按上面的差异推出来的，换过之后要看一次实测：官网挂着单、这里仍是 0，
 * 就不是 builder 头的问题，见 listOpenOrders 里那行诊断日志。
 *
 * 传已有凭据建，SDK 只发一次 GET /auth/api-keys 校验，**不会再弹签名**。
 * 下单 / 授权仍走 getSecureClient：builder 归因和免 gas 都靠那边的 apiKey。
 */
export function getReadClient(req: SecureClientRequest): Promise<SecureClient> {
  const key = req.eoa.toLowerCase()
  const hit = READ_CLIENTS.get(key)
  if (hit) return hit
  const p = getSecureClient(req)
    .then((main) =>
      createSecureClient({
        signer: signerFrom(req.walletClient),
        credentials: main.credentials,
        wallet: main.account.wallet,
      }),
    )
    .catch((e: unknown) => {
      READ_CLIENTS.delete(key) // 失败不留坏缓存
      throw e
    })
  READ_CLIENTS.set(key, p)
  return p
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

/** `client` 传 getReadClient 那一份（不带 builder 头），理由见那边。 */
export async function listOpenOrders(client: SecureClient): Promise<OpenOrderRow[]> {
  // 翻**所有页**，不再只取 firstPage —— 挂单多于一页时 firstPage 会漏后面几页。
  // Paginated 是 async-iterable，for await 会自动跟着 nextCursor 走到没有下一页。
  const items: Array<Record<string, unknown>> = []
  for await (const page of client.listOpenOrders({})) {
    if (Array.isArray(page?.items)) items.push(...(page.items as Array<Record<string, unknown>>))
  }

  // 诊断，别删。官网上挂着单、这里却是 0 时先看这一行：已经走不带 builder 头的
  // 客户端还是 0，就不是 builder 头的问题，要往「这把 API key 按什么地址过滤订单」
  // 上查 —— account.wallet 是我们下单用的 maker，owners / makers 是 CLOB 记的归属。
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

/**
 * 撤单的结果。
 *
 * ⚠️ **不要退回成一个字符串。** 原来这个函数返回 `string`，调用方拿不到「成没成」这个
 * 事实，只能把它当提示显示 —— 于是交易所回报「没撤掉（这笔已经成交了）」时，界面照样
 * 显示成绿色的成功提示，还把那行从列表里删掉。用户以为没买到，又买一次，**重复买入**。
 * 所以成败必须是**结构化的字段**，由调用方按它分别处理。
 *
 * `confirmed` 三态，别合并成 boolean：
 *  - `'cancelled'` 交易所明确说撤掉了（id 在 canceled 里）
 *  - `'rejected'`  交易所明确说撤不掉（id 在 notCanceled 里，原因在 reason）——
 *                  最常见的原因就是**它已经成交了**
 *  - `'unknown'`   两个名单里都没有它。按「不确定」处理：既不能报成功，也不能断言失败，
 *                  要去重查一遍挂单列表才知道（见 use-clob 的 cancel）。
 */
export type CancelOutcome = {
  confirmed: 'cancelled' | 'rejected' | 'unknown'
  /** 交易所给的拒绝原因，`rejected` 时才有 */
  reason: string | null
  /** 给人看的一句话 */
  message: string
}

/** 同 listOpenOrders，`client` 传 getReadClient 那一份。 */
export async function cancelOrderById(client: SecureClient, orderId: string): Promise<CancelOutcome> {
  const r = await client.cancelOrder({ orderId })
  const canceled = Array.isArray((r as { canceled?: unknown }).canceled)
    ? (r as { canceled: unknown[] }).canceled.map(String)
    : []
  const notCanceled = (r as { notCanceled?: Record<string, string> }).notCanceled ?? {}

  if (Object.prototype.hasOwnProperty.call(notCanceled, orderId)) {
    const reason = String(notCanceled[orderId] ?? '')
    return {
      confirmed: 'rejected',
      reason,
      message: tr(
        `交易所没有撤销这笔挂单${reason ? `：${reason}` : ''}。它很可能已经成交 —— 请核对下面的「持仓 / 成交」，不要再下一单。`,
        `The exchange did not cancel this order${reason ? `: ${reason}` : ''}. It has most likely already filled — check "Positions / Trades" below and do not place another order.`,
      ),
    }
  }
  if (canceled.includes(orderId)) {
    return { confirmed: 'cancelled', reason: null, message: tr('已撤销', 'Cancelled') }
  }
  // 两个名单里都没有它。**不报成功** —— 原来这里返回「已提交撤销请求」，读起来
  // 跟成功没区别，而这正是「显示撤销成功、其实已经买入」的那一半成因。
  return {
    confirmed: 'unknown',
    reason: null,
    message: tr(
      '交易所没有确认这笔撤单（回执里既没说撤掉、也没说失败）。',
      "The exchange didn't confirm this cancellation (the receipt lists it as neither cancelled nor failed).",
    ),
  }
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
    const base = tr('你在钱包里拒绝了这次签名。', 'You rejected the signature in your wallet.')
    return innermost ? tr(`${base}（钱包回报：${innermost}）`, `${base} (wallet said: ${innermost})`) : base
  }
  return innermost || String(e)
}
