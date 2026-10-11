/**
 * 钱包交互的「正在等待」信号 —— 跨 lazy chunk 共享的一点全局状态。
 *
 * ## 为什么需要它
 *
 * 手机端连钱包 / 下单，每一步（连接、切链、签名、补授权）都要跳去钱包 App 再跳回来：
 * 每次往返钱包侧要几秒才弹出确认框，这中间应用这边一片空白；而首单往往要**连着签不止
 * 一次**（派生凭据、补授权、下单各一次）。用户在这些**跳转的缝隙里**看不到任何「在等你」
 * 的反馈，很容易以为卡死了，于是反复点 —— 而反复点正是 -32002（上一笔还没处理完）的来源。
 *
 * 这个模块把「此刻在不在等钱包」收成一个信号：产生方（连接按钮、下单用的 SDK 签名器）
 * 调 `beginWalletWait` 开一段、拿回的函数收一段；消费方（主包里的等待浮层）用
 * `subscribeWalletWait` / `getWalletWait` 订阅，整段跳转期间都显示转圈 + 该回钱包做什么。
 *
 * ## 为什么单独一个不碰 SDK 的文件
 *
 * 浮层在**主包**里（见 lib/use-wallet.ts 顶部那条「主包组件只 import 不碰 SDK 的 hook」）。
 * 下单的 SDK 签名器在 lazy chunk 里**写**这个信号，浮层在主包里**读** —— 两边 import 同
 * 一个模块，打包器会把它并进一个共享 chunk，全局只有一份状态。所以这个文件自己**绝不能**
 * import @polymarket/client，否则就把那 300 kB 的 SDK 又拖回首屏了。
 */

export type WalletWaitKind = 'connect' | 'switch' | 'sign'

let seq = 0
const active = new Map<number, WalletWaitKind>()
const listeners = new Set<() => void>()

/** 同时有多段时取「最该抢注意力」的那种：签名卡着下单那一步 > 切链 > 连接。 */
function compute(): WalletWaitKind | null {
  const rank = { sign: 3, switch: 2, connect: 1 } as const
  let best: WalletWaitKind | null = null
  for (const k of active.values()) {
    if (!best || rank[k] > rank[best]) best = k
  }
  return best
}

// 缓存当前值：getWalletWait 要在没变化时返回同一个引用，否则 useSyncExternalStore 会疑似
// 死循环。这里是原始值（string | null），按值比较即稳定。
let current = compute()

function emit() {
  const next = compute()
  if (next === current) return
  current = next
  for (const l of listeners) l()
}

/**
 * 开一段「正在等钱包」。返回的函数收这一段 —— 放进 `finally` / effect cleanup。
 * 幂等：同一个返回函数调多次只收一次（靠 Map.delete 的返回值挡住重复）。
 */
export function beginWalletWait(kind: WalletWaitKind): () => void {
  const id = ++seq
  active.set(id, kind)
  emit()
  return () => {
    if (active.delete(id)) emit()
  }
}

export function getWalletWait(): WalletWaitKind | null {
  return current
}

export function subscribeWalletWait(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
