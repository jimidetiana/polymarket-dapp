/**
 * Builder code —— 订单归因标签。
 *
 * ## 这是什么，不是什么
 *
 * 一个 32 字节的**公开标识符**，写在订单结构体的 `builder` 字段里，跟用户的
 * 钱包签名一起上链。它标记「这笔成交归谁」，平台按归到我们名下的成交量抽费。
 *
 * 它**不是密钥**：
 *  - 链上每一笔归因订单都带着它，本来就公开可查
 *  - 它不证明身份、不解锁权限、里面也不编码费率
 *  - 所以硬编码进前端包不泄露任何东西
 *
 * 官方原话：「Builder codes are public identifiers — they appear onchain in the
 * builder field of every order you attribute.」
 *
 * ## 为什么不需要后端签名服务
 *
 * 曾经考虑过 `remoteBuilderSigning`（把 secret 放服务端、前端调签名端点）。
 * **当前功能范围内那是多余的**：追过 @polymarket/client 0.10.0 的实现，
 * `builder` 就是订单数据的一个字段（`builder: e.builderCode ?? <32字节零值>`），
 * 签名时直接写进去，跟 HMAC 认证头无关。官方文档也明说
 * 「Attach it to every order you submit — **no additional authentication is
 * required**」。
 *
 * Builder **API key** 是另一回事（那个是真凭据，官方警告 never expose）。
 * 它在 SDK 里的作用是把客户端的 `supportsGasless` 打开
 * （`context.apiKey?.supportGasless`），凡是**走 relayer 的免 gas 操作**都要它：
 *  1. **部署 Deposit Wallet**（`Ex()` 开头就 `invariant(supportsGasless, ...)`）
 *  2. 免 gas 的交易授权 setup（同一条 relayer 通道）
 *  3. Combo RFQ（`requestComboQuote` / `openRfqSession`）
 *  4. Session-key authorization
 *
 * ⚠️ **踩到过（2026-09-25）**：本以为「本项目不做 combo，就用不上这个 key」——错。
 * 一旦账户走 Deposit Wallet flow 且那个 Deposit Wallet **尚未部署**，
 * `createSecureClient` 会先去部署它，于是撞上第 1 条：没配 `apiKey` 授权就抛
 * `Deposit Wallet deployment requires a Relayer API Key or Builder API Key`。
 * 浏览器端能配的是 `relayerApiKey({key,address})`（`@polymarket/client` 根导出），
 * 但**把这个密钥打进前端包等于对每个访客公开它**（与本注释开头的 never expose
 * 冲突）——安全的做法是后端 `remoteBuilderSigning`，而本 dapp 无后端。详见
 * WALLET-HANDOFF.md 的「更新 2」。
 *
 * ## 为什么是编译期常量而不是运行时配置
 *
 * 一度打算从 `/builder-config.json` 运行时读，好处是同一份构建能投多个环境。
 * 放弃了，因为它多开一个攻击面：改那个 JSON 不需要碰 bundle、不走代码审查。
 * 攻击者换掉 code 能同时做两件事 —— 把费用导给自己，**并且**把费率拉到上限
 * （官方范围 0~50 bps），而界面还显示着 0.05%。第二件是真伤害：用户按 5 bps
 * 的显示下单、实际被扣 50 bps，是我们的站在骗人。
 *
 * 编译进包里，篡改它的门槛就跟篡改其余代码一样 —— 同一个信任边界，不额外开口。
 * 真要多环境，用构建时注入（`VITE_BUILDER_CODE`）而不是运行时 fetch。
 *
 * ## 用户自己改掉它？防不住，也不值得防
 *
 * 订单由**用户的钱包**签名，`builder` 在被签的数据里 —— 你无法让用户签一个
 * 他们不想签的东西。这跟前端后端无关：就算架后端只接受带我们 code 的订单，
 * 用户拿到签好的订单直接 POST 给 CLOB 就绕过去了（L2 凭据是从他们自己的
 * 签名派生的）。
 *
 * 而且想躲这笔费的人根本不需要篡改 —— 直接开 polymarket.com 更省事。5 bps
 * 在 $100 的单上是 5 分钱，愿意为此动手的人早就在用 API 了。
 *
 * **归因是商业安排，不是安全边界。** 我们能收到这笔钱，唯一原因是用户选择了
 * 用我们的界面。
 */

/**
 * 我们的 builder code。
 *
 * 来自 polymarket.com/settings?tab=builder。费率**不在这里面** —— 那个单独
 * 配在同一个设置页，按 code 查（见 lib/fee.ts）。只挂 code 不配费率的话，
 * 成交量照样统计，但抽不到钱。
 */
const BUILDER_CODE = '0xaee29306e8f6a655eb52b16862809c91a64c3c4cba2a9efdc63c5285496e4af3'

/**
 * bytes32 的十六进制写法：`0x` + 64 个十六进制字符。
 *
 * 「32」说的是**字节**不是字符 —— 每 2 个十六进制字符表示 1 字节，
 * 所以 32 字节写出来是 64 个字符。数错位数会以为 code 不合法。
 *
 * SDK 内部有同一条规则（zod：`/^0x[0-9a-fA-F]{64}$/`），这里先校验一遍是为了
 * 错误信息说得清 —— 让它烂在 SDK 里只会得到一个泛化的入参错误。
 */
const BYTES32_HEX = /^0x[0-9a-fA-F]{64}$/

/**
 * 下单时挂的 builder code；格式不合法时返回 undefined。
 *
 * ## 为什么格式错不抛异常
 *
 * 归因失败只是少赚一笔，**拦住用户下单是更大的损失**。所以这里返回
 * undefined 让 SDK 走默认的零值 builder（等于不归因），下单照常进行。
 *
 * 但要在控制台留个响 —— 静默地不归因意味着我们会在毫无征兆的情况下
 * 一直收不到钱，而界面上看不出任何异常。
 */
export function builderCode(): string | undefined {
  if (BYTES32_HEX.test(BUILDER_CODE)) return BUILDER_CODE
  console.error(
    `[builder] builder code 格式不合法，本次下单不会归因：${BUILDER_CODE}。` +
      `应为 0x + 64 个十六进制字符（32 字节）。`,
  )
  return undefined
}
