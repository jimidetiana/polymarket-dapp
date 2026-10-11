/**
 * 「正在等待钱包对一次签名作出响应」的全局信号 —— 跨 lazy chunk 共享的一点状态。
 *
 * ## 它只盯一件事：签名的往返
 *
 * 连接钱包、切网络那两步不归它管：那时浏览器/系统自己会弹选择框或钱包界面（手机上还会把
 * 我们的页面整个盖住），我们再叠一层「等待」浮层既被挡住、又没对应任何「这边在等」的状态，
 * 纯属添乱。真正该提示的是——**签名请求已经发给钱包、正等它回应**的那段：首次下单往往要
 * 连签多次（派生凭据、补授权、下单），每次都要跳去钱包确认，中间这边一片空白。
 *
 * 所以这里只收签名：下单用的 SDK 签名器每发起一次签名就 `beginWalletSignature()`、拿回的
 * 函数在签名 resolve/reject 时收掉。消费方（主包里的浮层）用 `subscribeWalletSigning` /
 * `getWalletSigning` 订阅。签名一旦完成，计数归零、浮层随即消失 —— 不会「认证好了还挂着」。
 *
 * ## 为什么单独一个不碰 SDK 的文件
 *
 * 浮层在**主包**里（见 lib/use-wallet.ts 顶部那条「主包组件只 import 不碰 SDK 的 hook」）。
 * 签名器在 lazy chunk 里**写**这个信号，浮层在主包里**读** —— 两边 import 同一个模块，打包器
 * 并进一个共享 chunk，全局只有一份计数。所以这个文件自己**绝不能** import @polymarket/client，
 * 否则那 300 kB 的 SDK 又被拖回首屏了。
 */

let count = 0
let signing = false
const listeners = new Set<() => void>()

function emit() {
  const next = count > 0
  if (next === signing) return // 布尔，按值比较即稳定（useSyncExternalStore 要求 snapshot 不变就同引用）
  signing = next
  for (const l of listeners) l()
}

/**
 * 标记「发起了一次签名，正等钱包回应」。返回的函数在签名有结果（确认 / 拒绝 / 出错）时收掉，
 * 放进 `finally`。幂等：返回的函数调多次只减一次计数。
 */
export function beginWalletSignature(): () => void {
  count += 1
  emit()
  let done = false
  return () => {
    if (done) return
    done = true
    count = Math.max(0, count - 1)
    emit()
  }
}

export function getWalletSigning(): boolean {
  return signing
}

export function subscribeWalletSigning(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
