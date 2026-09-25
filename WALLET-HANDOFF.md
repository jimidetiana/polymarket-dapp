# 钱包与下单链路 · 交接报告

**日期**：2026-09-24
**范围**：`src/components/connect-wallet.tsx`、`src/lib/use-wallet.ts`、`src/lib/use-clob.ts`、`src/lib/clob-client.ts`、`src/lib/proxy-wallet.ts`、`src/lib/fee.ts`
**一句话现状**：下单链路已经能走到「订单签名成功、提交给交易所」，**唯一的阻塞点是 CLOB 拒单：`maker address not allowed, please use the deposit wallet flow`**。

> ⚠️ **接手前必读**：本仓库的下单路径**从未成功下过一笔单**。代码注释里也是这么写给用户看的。下面所有「已确认」都基于控制台输出与 SDK 源码，**没有一次成功的端到端验证**。

---

## 更新（2026-09-24，后一轮会话）：walletType 已定死 = 2，阻塞点重新定性

**原来在等的那个数（`walletType` 是 2 还是 3）已经不用等控制台了 —— 从 SDK 源码直接定死是 `2`（GNOSIS_SAFE）。**

证据（两条独立来源对上）：

1. MetaMask 签名弹窗里 `SignatureType = 2`（= `POLY_GNOSIS_SAFE`，见 `@polymarket/bindings` 的枚举 `POLY_PROXY=1 / POLY_GNOSIS_SAFE=2 / POLY_1271=3`）。
2. SDK 解析账户身份的函数 `Eh(config, signer, wallet)` → 内部 `Nc()`（`dist/chunk-LGU5PMHE.js`）把传入的 wallet 逐一比对四种确定性派生：
   - `Nn`/`Hn`（`depositWalletFactory` 的 CREATE2）→ DEPOSIT_WALLET
   - **`Ac`（`safeFactory` + `safeInitCodeHash` 的 CREATE2）→ GNOSIS_SAFE**
   - `kc`（`proxyFactory`）→ POLY_PROXY

   **只有 `wallet === Ac(signer)` 才判成 GNOSIS_SAFE。** gamma `public-profile` 返回的那个 `proxyWallet`（钱在里面的那个，$4.80）命中的正是 `Ac(signer)` —— 也就是说它**本身就是这个 EOA 的确定性 Gnosis Safe**。

**结论：这不是「地址被 SDK 错误分类」，而是资金确实躺在一个 Gnosis Safe 里；而现在的交易所流程要求 maker 是 Deposit Wallet（类型 3）。** 所以阻塞点从「代码/分类 bug」重新定性为**资金位置问题**：

- Deposit Wallet 是 `Nn(signer)` 那个**另一个地址**，可能与旧 Safe 分开。
- 「不传 `wallet`」这条修法**能让 maker 被接受（签成类型 3）**；若 Deposit Wallet 上没钱，则会改踩「余额不足」。

**用户澄清（后续补充）**：钱在 Polymarket 上，第三方钱包登录后绑定的 Polymarket 账户、下单从 Polymarket 直接扣。也就是说不该在钱包间"搬钱",而应直接对**绑定的账户（Deposit Wallet）**下单 —— 这与交易所要求的 deposit wallet flow 一致。

**据此已落地代码改动（本轮）**：`clob-client.ts:createClient` **不再传 `wallet`**，改由 SDK 推签名者的确定性 Deposit Wallet 当 maker（signatureType 会从 2→3）。地址自检里 `gotWallet !== accountWallet` 那条从**抛错**放宽成 **`console.warn`**（同时打印「SDK 推的 Deposit Wallet」与「gamma proxyWallet(旧 Safe)」两个地址做对比）。`SecureClientRequest.accountWallet` 现在只用于余额显示与这条对比日志，不再当 maker。`npm run` typecheck（`tsc -b`）**EXIT 0**。

**仍需用户在浏览器实测确认**（我这边跑不了钱包/控制台）：
1. 下单弹窗里的 `SignatureType` 是否变成 **3**（此前是 2）。
2. `[clob] 账户身份：` 展开后的 `walletType` 应为 `DEPOSIT_WALLET`，`wallet` 是 SDK 推出来的那个 Deposit Wallet 地址。
3. 是否还报 `maker address not allowed` —— 若不再报、能提交，说明 maker 问题已解；若改报「余额不足」，说明绑定账户的钱其实不在这个 Deposit Wallet 地址上，那时再看是存款还是迁移。

**建议实测用远离市场的限价**（如单价 0.10、5 份 = $0.50），验证整条链路而不押上全部本金。

---

## 更新 2（2026-09-25，实测反馈）：maker 拒单已消除，撞上新墙 = Deposit Wallet 尚未部署

用户实测（限价 No、单价 0.61、5 份、$3.05；截图 + 控制台）：

- **旧的 `maker address not allowed` 不再出现** —— 切 Deposit Wallet flow 生效了。
- 新报错（`createSecureClient({signer})` 内部抛，栈 `createClient (clob-client.ts:208) ← submit (use-clob.ts:277) ← doPlace (order-dialog.tsx:147)`）：

  ```
  InvariantError: Deposit Wallet deployment requires a Relayer API Key or Builder API Key in the client configuration.
  ```

### 根因（SDK 源码定死）

- SDK 要**先在链上部署这个 EOA 的 Deposit Wallet**（`Ex()`），因为它**还没被部署过**。
- `Ex()` 开头即 `invariant(e.supportsGasless, "...Relayer API Key or Builder API Key...")`；而 `supportsGasless = context.apiKey?.supportGasless ?? false`（`index.js`）—— 只有给 `createSecureClient` 配了 `apiKey` 授权（浏览器端是 `relayerApiKey({key,address})`，Node 端是 builder API key）才为真。**我们只有公开的 builder _code_，没有这个 _API key_。**

### 这条错误顺带证明了一件关键事实

**这个 EOA 的 Deposit Wallet 从没被部署过 → 账户的钱不在那里。** 钱（$4.80）在已部署的 **Gnosis Safe**（gamma proxyWallet）里。所以 Deposit Wallet flow 要真正下成单，需要**两样都有**：(1) 一个 relayer/builder API key 来免 gas 部署 Deposit Wallet；(2) 那个 Deposit Wallet 里有钱（Safe 的钱不会自己过去）。

### 于是两条路都堵着

- **Safe 当 maker**（signatureType 2）→ 交易所拒 `use the deposit wallet flow`。
- **Deposit Wallet flow** → 钱包未部署，无 API key 无法部署；即便部署了也是空地址。

### 安全红线

把 relayer/builder API key 打进**纯前端包 = 对每个访客公开它**（builder.ts 开头就写着这类 key never expose）。安全用法是后端 `remoteBuilderSigning`，而本 dapp **无后端**。所以「前端直接配 key」不是一个能接受的修法。

### 诚实的结论 + 待用户决策

**本账户（持 $4.80 的旧 Gnosis Safe）用「纯前端 dapp + @polymarket/client 0.10.0」现状下下不了单。** 交易所要 Deposit Wallet；而部署/使用 Deposit Wallet 需要一个不能安全放进浏览器的密钥、且需要往 Deposit Wallet 注资。可选路线（要用户拍板，多数动作在代码之外）：

1. **在 polymarket.com 侧把账户变成「已部署 + 已注资 + 已授权」的 Deposit Wallet**（若官方支持从 Safe 迁移/新建）。一旦它在链上就绪，本 dapp 只做「下单」这一步，**不需要我们自己的 relayer key**（部署/授权是官方那边完成的）。最贴合「钱在 Polymarket、别在钱包间搬」。
2. **加后端 + relayer/builder API key**，让免 gas 部署走 `remoteBuilderSigning`，不把 key 暴露在浏览器。范围大，且与本项目「无后端」的既定设计相反。
3. **接受限制**：明确本 dapp 只能交易「已就绪 Deposit Wallet」的账户，此旧 Safe 账户不迁移就无法在此下单。

### 本轮代码改动

- `clob-client.ts` 保留 Deposit Wallet flow（不传 `wallet`）—— 它是交易所指定的正确路径，报错也更贴近真实要求；未擅自加 relayer key 明文（安全 + 避免过度设计）。
- 订正 `builder.ts` 里「builder API key 只有 combo/session-key 两处用得上」的说法：**免 gas 部署 Deposit Wallet 也需要它**（这正是本轮撞上的）。
- typecheck `tsc -b` 仍 **EXIT 0**。

---

## 更新 3（2026-09-25，方向纠正）：Deposit Wallet flow 是错的方向，已回退到 Safe maker

**「更新 2」把 `please use the deposit wallet flow` 当成了「必须去用 Deposit Wallet」——错。** 查了官方文档 + Polymarket 自己的开源 issue 后纠正：

### 官方文档口径

- 钱包类型：EOA=0 / POLY_PROXY=1 / GNOSIS_SAFE=2 / DEPOSIT_WALLET=3。
- Deposit Wallet 是 **2026-05-04 起新账户**的默认钱包。**Proxy = Magic/Google 建的 legacy 智能钱包；Safe = 外部签名者（MetaMask/Rabby）建的 legacy 智能钱包。**
- 关键：**「Existing Safe and Proxy users are unaffected and can continue using their current wallet setup.」** legacy Safe/Proxy 用户可继续用现有钱包；「For Safe or Proxy Wallet flows, use an SDK that handles the wallet-specific payloads.」
- 部署 Deposit Wallet 才需要 Relayer/Builder API key；EOA 路径无需。

### 用户账户的真相（回应「余额明明从 Polymarket 读的，怎么会没激活」）

用户说得对。可用余额 $4.80 是对 **gamma proxyWallet（= 这个 EOA 的 Gnosis Safe）** 的 `pUSD.balanceOf` **链上真实读数**；这个 Safe 已部署、有钱，**就是用户在 Polymarket 上的实际账户，是激活的**。

「更新 2」说的「没激活」指的是**另一个地址**——SDK 在「不传 wallet」时推的那个 Deposit Wallet（`Nn(signer)`），它从没部署过。**那句话把「账户」和「Deposit Wallet」混为一谈了，是误导。** 本 dapp 上一轮的改动（切 Deposit Wallet flow）等于让下单去用一个**没有用户的钱**的新地址，是走错了。

### 「maker not allowed」的真身：Polymarket v2 的已知未修问题

这个报错不是本仓库 bug，是 Polymarket **v2 CLOB** 对 legacy Safe 账户的已知问题。开源 issue 里有一模一样的复现：

- `py-clob-client-v2` **#90**：Safe 钱包 `signature_type=2` → `maker address not allowed, please use the deposit wallet flow`；`signature_type=3` → `order signer address has to be the address of the API KEY`。**两个都撞，跟我们完全一致。**
- `py-clob-client-v2` **#77 / #64**：CLOB 强制 `order.signer == api_key.address`；API key 绑在 EOA 上，而 Deposit Wallet 单的 signer 是 Deposit Wallet，于是被拒。

也就是说：**Safe maker（sigType 2）走 v2 接口目前被上游挡着，而 Deposit Wallet flow（sigType 3）又因 api-key 绑定 + 未部署而走不通。** 两条 v2 路径对这个 legacy Safe 账户都堵。

### 本轮代码改动（回退 + 纠正）

- `clob-client.ts:createClient` **回退到传 `accountWallet`（Safe）当 maker**（signatureType 2）—— 这才是这个账户的正确配置，用的是有钱的那个钱包。
- `explainError` 把 `maker address not allowed / use the deposit wallet flow` 翻成中文实话：「新版接口暂不接受用你的旧版 Safe 直接下单，是官方 v2 已知问题，账户和余额都正常」——不再显示误导性的「Deposit Wallet 没激活，去 polymarket.com 存款」。
- 订正了 `proxy-wallet.ts` 里「改走 Deposit Wallet flow」的注释。
- typecheck `tsc -b` **EXIT 0**。

### 下一步（需要的事实 + 可能的真正修法）

1. **决定性事实**：在 polymarket.com 用这个钱包**现在能不能真的下一单**？能，就说明这个 Safe 账户存在可用的交易通道（多半是 v1 CLOB），值得照着做；不能，那这个账户在现状下任何客户端都下不了单。
2. **可能的真正修法**：仓库里**同时装了旧版 `@polymarket/clob-client`（v5.8.1，v1 客户端）**。v1 CLOB 一直支持 Safe（sigType 2）。也许把「下单」这一步从 v2 的 `@polymarket/client` 换成 v1 的 `@polymarket/clob-client`，Safe 单就能被接受。**这是下一步要验证的方向，尚未动手**（要先确认第 1 点，且这是个不小的改动，需用户点头）。

---

## 更新 4（2026-09-25，目标澄清 → 方向再纠正）：这是个「builder 费门户」，不是单账户下单工具

用户澄清真实目标：**做多用户门户,让用户从这里进来交易,我们靠 builder code 抽成获利**。「只是下单」用户另有项目已解决。**所以 builder 归因是产品核心,不是可选项。**

据此,「更新 3」推的「换 v1 clob-client」方向对门户目标**是错的,已收回**：

- **v2 `@polymarket/client` 才是门户的正确底座**：它的 builder 归因是**写进订单的公开 `builder` 字段**(bytes32 code),**无需密钥、无需后端、无需逐单 HMAC**。用户用自己钱包签单、订单自带我们的 code、我们就抽到成 —— 天然适配「多用户 + 非托管 + 无服务器」。本 dapp 建在 v2 上就是为此。
- **v1 clob-client 的订单结构没有 builder 字段**,归因只能靠 HMAC 头 + **保密 builder API key** → 多用户门户就得有后端持密钥、替每个用户的单签头(即 `poly` 参考案例 `/api/polymarket/sign`)。对门户是更差的架构。

**门户主力用户 = Deposit Wallet 账户**(2026-05 起默认;这类用户的 Deposit Wallet 由他们自己在官网部署好、充过值)。对他们:v2 + builder code 归因没问题,唯一的坎是 **v2 的 POLY_1271 `order.signer` 绑定 bug**(CLOB 要 `order.signer == api_key.address`,而 SDK 把 sigType=3 的 signer 填成 deposit wallet、api key 却绑在 EOA → py-clob-client-v2 #77)。

用户提的 **sigType=3 + EOA 派生 API key** 正冲这个 bug,方向对。已核实两点：

1. **升级修不了**:拉了最新 **0.11.0(2026-09-23)** 看,POLY_1271 仍是 `signer: r===POLY_1271 ? e.wallet : e.signer`,还是把 signer 填成 deposit wallet。所以**必须手动补丁**(强制 POLY_1271 的 `order.signer` = EOA + 用 EOA 派生 creds),与用户判断一致;可在客户端做,**不破坏无服务器**。
2. **当前 Safe 测试账户不适合验证 sigType=3**(其 Deposit Wallet 空且未部署)。验证补丁需要一个**已部署 + 已充值的 Deposit Wallet 账户**。

**下一步**:留在 v2 + builder code → 客户端补丁 POLY_1271 signer=EOA + EOA 派生 creds → 用真正的 Deposit Wallet 账户实测。legacy Safe/Proxy 用户次要,以后再议。**补丁基于用户转述的"Rust SDK 已验证"报告,CLOB 确切校验语义我尚未独立验证,需实测。**

---

## 更新 5（2026-09-25，方向定案 + 已实现）：照官方 safe-wallet-integration 重构下单层，已构建通过

用户指出账号是 **MetaMask 登录**（→ Gnosis Safe），并让参考官方 `Polymarket/safe-wallet-integration`。据此**放弃 sigType=3/v2 那条**（那是给 Deposit Wallet 账户的），改用官方给集成方的经典栈。**已完成实现，`npm run build`（tsc + vite）通过、后端冒烟通过。**

### 已落地的架构
- **依赖**：降到官方代次 —— `@polymarket/clob-client@4.22.8`、`@polymarket/builder-relayer-client@0.0.6`、`@polymarket/builder-signing-sdk@0.0.8`、`ethers@5.8.0`；新增 `vite-plugin-node-polyfills`（v4 栈用到 crypto/buffer 等 node 内建，必须 polyfill，否则运行时 `crypto` undefined）。`@polymarket/client`(v2) 已无代码引用（仅注释里提到，可选删）。
- **薄后端** `server/sign-server.mjs`：零依赖 Node http，`POST /api/polymarket/sign` 用 `buildHmacSignature` + env 里的 builder 密钥算 HMAC，**secret 不下发**。`npm run server` 启动（默认 8787），vite dev 用 `server.proxy` 把 `/api` 转过去。
- **前端**（都在 lazy 弹窗链路，主包不碰 SDK）：
  - `src/lib/polymarket-config.ts`：URL / 合约地址 / `deriveSafeAddress`（viem CREATE2，与 relayer-client 的 deriveSafe 同式，主包可用）。
  - `src/lib/ethers-signer.ts`：viem walletClient → ethers v5 JsonRpcSigner（clob-client v4 只吃 ethers signer）。
  - `src/lib/approvals.ts`：USDC.e allowance + CTF setApprovalForAll 的检查与 relayer 批量授权。
  - `src/lib/clob-client.ts`：**整体重写**。`getSession({eoa,signer})` 惰性建会话（deriveSafe → 未部署则 `relayClient.deploy()` → 派生/创建 L2 凭据 → 未授权则 relayer 批量授权 → 建带 BuilderConfig 的 ClobClient，sigType=2、funder=Safe）；`placeOrder`（限价 GTC / 市价 FAK）、`listOpenOrders`、`cancelOrderById`、`fetchApprovalState`、`setupApprovals`、`explainError`。对 UI 的类型/hook 边界保持不变。
  - `use-clob.ts` / `use-wallet.ts` / `proxy-wallet(via config)`：readiness 改为「连上+137+walletClient」；`proxyAddr` 改为本地 deriveSafe；余额读 **USDC.e**（非 pUSD）。
  - `connect-wallet.tsx`：删掉旧 gamma「没开户/查询失败」死分支；余额行标签改中性。

### ⚠️ 只做了到"构建通过"，运行时未验证 —— 需用户在浏览器实测（且要 builder 密钥）
1. **抵押代币 pUSD vs USDC.e**：官方经典栈用 **USDC.e**（`0x2791…`），但本仓库之前读到用户 Safe 上是 **pUSD**（`0xC011…`）$4.80。若实测「可交易余额」显示 $0 或下单报余额不足，说明资金是 pUSD、与经典 CTF 交易所的 USDC.e 对不上 —— 这是**头号要核对**的点。
2. **deriveSafe 是否 = 有钱的那个 Safe**：本地 CREATE2 派生的 Safe 地址应与之前 $4.80 所在的地址一致（大概率，但要核对）。
3. v4 下单/挂单响应字段名（我按常见 snake_case 防御性映射，未实跑校验）。
4. node polyfill 后的 `crypto` 在浏览器里能否正确算 L2 HMAC。

### 怎么跑
1. 后端 env 设 `POLYMARKET_BUILDER_API_KEY/SECRET/PASSPHRASE`（polymarket.com 设置页 builder 标签），`npm run server`。
2. `npm run dev`，连 MetaMask（同一 Safe 账户）→ 首次下单会依次弹签名（部署/凭据/授权/下单）→ 用远离市场的限价单（如 0.10 × 5 = $0.50）验证。

---





## 一、唯一的阻塞点

### 现象

点「确认下单」→ 钱包签名成功 → 提交 → 交易所返回：

```
RequestRejectedError: maker address not allowed, please use the deposit wallet flow
(https://clob.polymarket.com/order)
```

调用栈：`placeOrder (src/lib/clob-client.ts:249)` ← `doPlace (src/components/order-dialog.tsx:147)`

### 决定性证据：钱包里看到的待签订单

MetaMask 签名弹窗里展开的字段（用户截图，2026-09-24）：

| 字段 | 值 | 说明 |
|---|---|---|
| 主要类型 | `Order` | |
| Builder | `0xaee29306e8f6a655eb52b16862809c91a64c3c4cba2a9efdc63c5285496e4af3` | 我们的 builder code，正确 |
| Maker | `0x171cD...429E2` | **就是它被拒**。这是 gamma `public-profile` 返回的 `proxyWallet` |
| MakerAmount | `3050000` | $3.05 ✓ 与确认面板一致 |
| TakerAmount | `5000000` | 5 份 ✓ |
| Side | `0` | BUY ✓ |
| **SignatureType** | **`2`** | **← 根因所在** |
| Signer | Account 1 | 签名地址，正确 |

SDK 的钱包类型枚举（`@polymarket/bindings/dist/gamma/index.d.ts:10023`）：

```ts
declare enum WalletType { EOA = 0, POLY_PROXY = 1, GNOSIS_SAFE = 2, DEPOSIT_WALLET = 3 }
```

**SDK 用 `SignatureType: 2`（Gnosis Safe）签的，而交易所要的是 deposit wallet flow（3）。**

`src/lib/proxy-wallet.ts` 的注释里写着这个账户「signatureType = 3（DEPOSIT_WALLET）」，与观察到的 2 矛盾。

### 原因判断

`src/lib/clob-client.ts` 的 `createClient` 显式传了 `wallet`：

```ts
const client = await createSecureClient({ wallet: accountWallet, signer })
//                                          ^^^^^^^^^^^^^^^^^^^^^ 来自 gamma 的 proxyWallet
```

而 SDK 文档（`types-BqK8Y3G5.d.ts:5102`）说：

```ts
/**
 * Wallet address to use as the account wallet.
 *
 * If omitted, the client uses the signer's deterministic Deposit Wallet as
 * the account wallet. Pass the signer address itself to explicitly trade as
 * an EOA account, or pass a supported Poly Deposit Wallet, Poly Safe, or Poly
 * Proxy wallet address to use that wallet as the account/funder.
 */
wallet?: string
```

**我们传进去的那个地址被 SDK 归类成了 Gnosis Safe，于是按 Safe 的流程签名；而错误原文要求的正是 deposit wallet flow——也就是「省略 `wallet` 时 SDK 会用的那个」。**

### 下一步要做的第一步（只差一个数）

`clob-client.ts:214` 已经加了一行日志：

```ts
console.info('[clob] 账户身份：', {
  signer: acct?.signer, signerType: acct?.signerType,
  wallet: acct?.wallet, walletType: acct?.walletType,
})
```

**用户尚未提供展开后的内容**（控制台里是折叠的 `▸ Object`）。拿到 `walletType` 就能定死：

- **`2`（GNOSIS_SAFE）** → 确认是地址分类问题。改法是**不传 `wallet`**，让 SDK 推确定性 Deposit Wallet；或传入正确的 deposit wallet 地址。
- **`3`（DEPOSIT_WALLET）** → 那 `SignatureType: 2` 与它矛盾，问题在 SDK 更深处，需另找方向。

### 改「不传 wallet」时的一个未知数

不改动的现状下，「可交易 pUSD」读的是 gamma 的 `proxyWallet`（$4.80，与一笔真实入金一致）。

若省略 `wallet` 后 SDK 推出来的 deposit wallet 是**另一个地址**，那边大概率是 $0 —— 订单会因余额不足被拒（不丢钱，只是白签一次）。

而「钱在旧钱包里、交易账户却是 deposit wallet」正好对应代码里那条待办：

> 上游那次供应链事故的待办（**转移资金**、重新派生 CLOB key）还没做完

**这是猜测，不是结论。** 但如果成立，这条待办不是可选项，而是「能不能下单」的前提。

另外注意：现有的自检会在 SDK 解析出的 wallet ≠ 传入的 accountWallet 时**抛错**（`clob-client.ts` 的 `createClient`）。省略 `wallet` 必须同时放宽这条自检，否则会得到一个中文自检错误而不是我们想观察的结果。

---

## 二、已确认的账户与环境事实

| 项 | 值 | 来源 |
|---|---|---|
| 代理钱包 / maker | `0x171cD...429E2`（截图只有缩写，需完整值） | gamma `public-profile` |
| 可交易余额 | **$4.80** | 面板读数；与一笔真实入金 4.80 一致 |
| 钱包扩展 | **MetaMask + 币安钱包同时安装** | 用户，及控制台第三方日志 |
| 浏览器差异 | **Chrome 正常，Edge 出问题** | 用户观察，**成因未确认** |
| builder code | `0xaee29306e8f6a655eb52b16862809c91a64c3c4cba2a9efdc63c5285496e4af3` | `src/lib/builder.ts` |
| 设置页费率 | 0.05%（= 5 bps），**已生效** | 见下文「费率单位」一节 |
| 抵押代币 | pUSD `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`，6 位小数 | `src/lib/proxy-wallet.ts`；$4.80 显示正确即验证了小数位 |
| 链 | Polygon (137) | `src/lib/wagmi.ts` |

### 控制台里另外两条未解释的

```
Failed to load resource: clob.polymarket.com/auth/api-key:1  → 400
Failed to load resource: clob.polymarket.com/order:1         → 400
```

L2 凭据派生接口回 400。可能是「key 已存在」之类的正常响应，**未查证**。等 maker 问题解决后若仍有异常，再查。

---

## 三、本轮已改的代码（未提交）

> 工作区里还有用户自己更早的未提交改动（`App.tsx`、`match-picker.tsx`、`graph/*`、`layout.ts`、`index.css` 等，共 16 个文件）。**下面只列本次会话改的。**

### `src/lib/clob-client.ts`

| 位置 | 改动 | 为什么 |
|---|---|---|
| `:143` | `fetchFeeRates` 返回值 `× 10_000` | **修 confirmed bug**，见第四节 |
| `:214` | 新增 `console.info('[clob] 账户身份：')` | 定位 maker 拒单；**这是当前最需要的数据** |
| `:334` | 新增 `errorChain(e)` | 沿 cause 链取类名与报文，**按字段取而非 `instanceof`** |
| `:379` | 重写 `explainError` | **修 confirmed bug**，见第四节 |

### `src/lib/use-clob.ts`

| 位置 | 改动 | 为什么 |
|---|---|---|
| `:215-216` | `const fromApi = q.data ? maxBpsOf(q.data) : 0; return { feeBps: fromApi > 0 ? fromApi : maxBpsOf(BUILDER_FEE_RATES) }` | 原写法 `q.data ?? BUILDER_FEE_RATES` 接不住 API 返回 0，费率行会整个消失 |
| `:150-170, :184-192` | 注释与 warn 文案重写 | 原先的解释基于错误假设（见第五节） |

### `src/components/connect-wallet.tsx`

| 位置 | 改动 | 为什么 |
|---|---|---|
| `:56, :69, :184` | 把 `useConnect().error` 接出来并传下去 | **原先从不读它**，所以连接失败在界面上完全不存在 |
| `:213, :229` | 渲染 `ConnectError` | 同上 |
| `:286` | 新增 `ConnectError` 组件 | 悬浮在按钮下方，z-40（让钱包列表 z-50 盖住它） |
| `:317` | 新增 `explainConnectError` | -32002 单独翻译成人话 |
| `:455` | 面板新增「当前钱包」一行 | 装了多个扩展时，界面上原本看不出 dapp 在用哪个 |
| `:126-165` | `pickable()` 的注释 | 记录「什么时候会连错钱包」；**代码本身已回到原样** |

### `src/lib/use-wallet.ts`

| 位置 | 改动 |
|---|---|
| `:94-101, :113` | `useWalletBalances` 多返回一个 `connector`（供「当前钱包」那行用） |

---

## 四、两处已确认的 bug（本轮已修）

### 1. 费率单位错了 10000 倍

SDK 的 zod transform 把 bps 除掉了 10000（`@polymarket/bindings/dist/clob/index.js`）：

```js
oe = 1e4,
Pe = z.object({
  builder_maker_fee_rate_bps: z.number(),
  builder_taker_fee_rate_bps: z.number()
}).transform(({ builder_maker_fee_rate_bps: e, builder_taker_fee_rate_bps: t }) => ({
  maker: e / oe,      // ← 除以 10000
  taker: t / oe
}))
```

**所以 `r.maker` / `r.taker` 是小数，不是 bps。** 设置页配 0.05%（= 5 bps）时，原始字段是 5，SDK 交给我们的是 `0.0005`。

原代码只改了字段名、没换单位：

```js
return { makerBps: Number(r.maker), takerBps: Number(r.taker) }   // 把 0.0005 当成 bps
```

后果：费率被少报 10000 倍 → `bpsLabel(0.0005)` 四位小数舍成 `"0%"`，而 `feeCentsOf` 照样向上取整成 `$0.01` → 界面上出现自相矛盾的 **「手续费（0%）$0.01」**。

**同时这也说明：用户的 0.05% 早就生效了**，不是「还没生效」——`0.0005` 就是 5 bps。（曾经误判为「设置页改了还没生效」，那是错的。）

### 2. `explainError` 把服务端拒单误判成「你拒绝了签名」

原正则：

```js
if (/cancel|reject|denied|user refused/i.test(name) || ...)
```

`name` 是 **`RequestRejectedError`** ——名字里带 `Rejected`，被吃掉了。而它表示**服务端拒绝了这次请求**（就是上面那条 maker 拒单），跟签名毫无关系。

后果：用户明明点了「确认」，界面却说「你在钱包里拒绝了这次签名」，而真实原因被完全吞掉，只能反复重试。

已改成只认 `CancelledSigningError` 与 `UserRejectedRequestError`。

**另一个要注意的**：`CancelledSigningError` 本身也**不等于**用户拒绝。SDK 有 `static fromError(error: Error)`，用在 `try { signer.signTypedData(...) } catch (t) { throw fromError(t, '...') }` 这类位置——**`signTypedData` 的任何失败都会被转成它**。

---

## 五、走错的路（别重走）

排查过程中有两个假设被**推翻**了，写在这里省得重复：

1. **「wagmi 的 hydrate guard 会丢掉 6963 广播，导致连错钱包」——错。**
   `@wagmi/core/src/createConfig.ts:335` 确实有 `if (storage && !store.persist.hasHydrated()) return`，但 `:267` 是 `skipHydration: ssr`，我们没传 `ssr`（默认 false），localStorage 同步 hydrate，**那句 guard 不会触发**。
   相关事实：`multiInjectedProviderDiscovery` 默认 `true`（`:48`）；6963 发现的连接器**带着自己的 provider**（`:121` `injected({ target: { ...info, id: info.rdns, provider } })`），所以从列表里点 MetaMask 用的就是 MetaMask，不会串。

2. **「MetaMask 啃不动 ERC-7739 的 TypedDataSign 外壳」——错。**
   这次错误是 `RequestRejectedError`（服务端拒绝），**不是签名取消**——说明订单签名本身是成功的。

另外，`src/lib/proxy-wallet.ts` 里那条「POLY_ADDRESS 恒为签名地址，不是代理地址」是**已经订正过的结论**，别改回去。

---

## 六、未验证 / 风险

| 项 | 状态 |
|---|---|
| **整条下单路径** | **从未成功跑通过一笔** |
| **typecheck** | **本次会话一次都没跑成**（Bash 工具全程不可用）。所有改动**未经编译验证** |
| 手续费公式 | 「按成交名义额（份额×单价）计费」是**推出来的**，未实测。`bindings/clob` 的 `ClobTrade` / `PaginatedBuilderTrades` 里有 **`feeUsdc`** 和 **`feeRateBps`** 字段，成交后可拿来对账 |
| 卖出侧手续费 | 「从成交额里扣」同样未实测；若实际是另收一笔，`proceedsUsd` 会偏乐观 |
| 上游供应链事故 | 待办未做完（转移资金、重新派生 CLOB key）。**用同一个钱包下单会继承那份风险** |
| 测试覆盖 | `clob-client.ts`、`use-clob.ts`、两个弹窗组件**都没有测试**。有测试的只有纯函数（`tick` / `fee` / `book` / `graph` 等） |

**建议接手后第一件事：跑 `npm run typecheck`。**

---

## 七、口径速查（这个项目踩过的地方）

| 概念 | 正确口径 |
|---|---|
| `POLY_ADDRESS`（L2 认证头） | **恒为签名地址（EOA）**，不是代理地址。搞反会 401 |
| 订单的 `maker` | 账户/资金钱包（funder）。**当前用的 gamma `proxyWallet` 被交易所拒了** |
| `signatureType` | `0`=EOA `1`=POLY_PROXY `2`=GNOSIS_SAFE `3`=DEPOSIT_WALLET。**当前签出去的是 2** |
| 费率单位 | SDK 返回的是**小数**（已 ÷10000），不是 bps |
| 价格精度 tick | 每个市场各自不同（0.1/0.01/0.001/0.0001），必须问 CLOB。内部一律走**整数步**（`src/lib/tick.ts`） |
| 抵押代币 | **pUSD**，不是 USDC.e（后者是上一代协议的） |
| 交易所拒单 | 是**返回值**（`ok === false`），不是异常。签名/网络错才抛 |
| `CancelledSigningError` | **不是**「用户拒绝」的同义词，是 `signTypedData` 失败的统称 |

---

## 八、涉及的文件

```
src/components/connect-wallet.tsx   钱包入口（连接/切链/余额浮窗）
src/components/order-dialog.tsx     下单弹窗（tick/余额/费率汇合点 + 确认面板）
src/components/order-form.tsx       下单表单 + 手续费/余额校验
src/components/order-book.tsx       盘口深度
src/components/approvals-dialog.tsx 交易授权（relayer 免 gas）
src/lib/clob-client.ts              ★ 纯逻辑层：签名、下单、授权、挂单（不 import React）
src/lib/use-clob.ts                 React 层：何时调、状态怎么摆
src/lib/use-wallet.ts               余额读数（★ 不 import SDK，主包能用）
src/lib/proxy-wallet.ts             代理钱包地址 + pUSD 地址 + 历史踩坑
src/lib/fee.ts                      手续费计算与展示
src/lib/tick.ts                     价格精度（整数步）
src/lib/builder.ts                  builder code 归因
```

**一条架构约束**：`src/lib/use-wallet.ts` 与 `src/components/connect-wallet.tsx` 在**主包**里，**不许 import 任何牵进 `@polymarket/client` 的模块**（SDK 约 300 kB gzip）。违反不会有报错，只会让首屏包悄悄变胖。下单/授权弹窗都是 `lazy()` 的。

**另一条**：`clob-client.ts` 不 import React；`use-clob.ts` 不写业务逻辑。

---

## 九、建议的下一步

1. **跑 `npm run typecheck`** —— 本轮改动全部未经编译验证。
2. **拿到 `[clob] 账户身份：` 展开后的内容**（`walletType` 是 2 还是 3）。
3. 按结果选修法：
   - `walletType === 2` → 试**不传 `wallet`**，同时放宽 `createClient` 的地址自检（改成记录而非抛错），观察 SDK 推出来的 deposit wallet 地址，以及那个地址上有没有钱。
   - `walletType === 3` → 换方向，往 SDK 订单构造里查。
4. **测试下单请用远离市场的限价**（例如单价 0.10、5 份 = $0.50）。它不会成交，能验证整条链路而不用押上全部本金（余额只有 $4.80，而最小 5 份在市价 0.94 时就是 $4.70）。
5. 钱包弹窗**每笔订单必然出现一次**（这是模型决定的，不是实现问题）；另有**每会话一次**的 L2 凭据派生签名。想省掉后者需要持久化 `ApiKeyCreds`，但那与「重新派生 CLOB key」那条待办方向相反，**建议等那条待办做完**。

---

*本报告由 2026-09-24 的一次排查会话整理。所有结论标注了来源；未标注来源的判断都写明了是推断。*

---

## 更新 6（2026-09-25，重大发现 + V2 栈落地）：Polymarket 已升级 CLOB V2（pUSD），撤回 v4 弯路

**关键外部事实（官方文档）**：Polymarket 于 **2026-04-28 升级到 CLOB V2** —— 新交易所合约、新订单簿、**新抵押代币 pUSD 取代 USDC.e 成为当前所有交易的抵押品**（pUSD 1:1 兑 USDC）。用户账户里是 pUSD 正因为现在是 V2。

这**推翻了「更新 5」的方向**：那版照 `safe-wallet-integration`（V2 升级前的参考）建的经典 clob-client v4 + USDC.e，是针对**已废弃的旧交易所**，在当前系统下下不了单。最初 v2 SDK 报的「please use the deposit wallet flow」本就是 CLOB V2 在要 deposit-wallet 模型 —— 用户更早的 sigType=3 直觉是对的。

**已落地（回到 V2 栈，`npm run build` 通过、0 漏洞、后端冒烟通过）**：
- 依赖回滚到 v2 代次：`@polymarket/client 0.10.0` + `clob-client 5.8.1` + `ethers 6`；移除 v4 那批（builder-relayer-client / ethers5 / vite-plugin-node-polyfills），少了 200 个包。v2 SDK 浏览器原生，不需要 polyfill。
- `clob-client.ts` 重写回 v2 + 补上缺的那块：`createSecureClient({ signer: signerFrom(walletClient), apiKey: remoteBuilderSigning({ url: '/api/polymarket/sign' }) })` —— **不传 wallet → Deposit Wallet flow（POLY_1271）**；`apiKey` 打开 supportsGasless → SDK **免 gas 部署 Deposit Wallet + 设 pUSD 授权**（授权对象 CtfCollateralAdapter 等由 SDK 内部处理）。下单挂 `builderCode` 归因。
- 薄后端 `sign-server.mjs` 改为**零依赖 node crypto** 实现 HMAC（与 SDK 规范同式：`base64url(HMAC-SHA256(base64(secret), ts+method+path+body))`），返回 `POLY_BUILDER_SIGNATURE/TIMESTAMP/API_KEY/PASSPHRASE`，正是 v2 SDK remoteBuilderSigning 要的四个字段。已用 dummy 密钥验出签名。
- `.env`（gitignore）+ `.env.example`：填 `POLYMARKET_BUILDER_API_KEY/SECRET/PASSPHRASE` 即可，`npm run server` 自动读。
- 余额显示回到 **pUSD**。

**已确认的三点**（用户要求）：① builderCode 是下单参数字段 ✓；② pUSD 授权由 SDK 的 setupTradingApprovals 处理（不手写地址）✓；③ 免 gas 部署 = createSecureClient 传 apiKey(remoteBuilderSigning) ✓。

**仍需浏览器实测（我起不了钱包）**：最大未知仍是 **SDK 推出的 Deposit Wallet 是否就是有 pUSD 的那个地址**。之前观察到 gamma proxyWallet 被判成 Gnosis Safe（sigType 2）、$4.80 在那上面；若 Deposit Wallet flow 部署出的是另一个空地址，会在下单时报余额不足 —— 那说明资金需迁到 Deposit Wallet（或账户模型需再确认）。实测一笔远离市场的限价单即可见分晓。


---

## 更新 7（2026-09-25，闭环成功）：下单跑通了，根因确认是账号资金位置（非代码）

用户实测反馈：**"好了，可以下单了，确实是账号问题。"** —— 整条门户下单链路端到端**成功**。

**最终确认**：
- 代码/架构是对的（V2 栈：`@polymarket/client` + Deposit Wallet flow + `remoteBuilderSigning` apiKey 免 gas 部署/授权 + `builderCode` 归因 + 薄后端 HMAC + 自动交易授权 + 自动切 Polygon）。
- 之前所有的 `balance: 0` 拒单，根因是**账号资金位置**：$4.80 pUSD 卡在旧的账户地址（0x171c，"仅供 API 使用"），没进 V2 的 deposit 系统。属于历史遗留账户的资金状态问题，**不是本仓库的代码 bug**。用户在 polymarket.com 侧把账户/资金弄进 V2 后即可下单。
- 对门户的正常用户（本来就在 V2、余额在 deposit 系统里）——这套流程可用。

**本轮沿途还修的**：自动切 Polygon（省手动点）；下单按钮禁用时必给原因（修了 size=0 时静默灰按钮）；createClient 里下单前自动检查+免 gas 补交易授权；薄后端 HMAC 改零依赖 node crypto 实现、body 改可选（鉴权/查挂单无 body）；`.env` 配置文件（免手输环境变量）。

**门户下一步（非阻塞）**：核对 builder 归因是否真的记到我们名下（builder 后台 / `getBuilderTrades` 看带我们 code 的成交与费用）——这是门户的收入点。
