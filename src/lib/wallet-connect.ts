import type { Connector } from 'wagmi'
import { tr } from './i18n'

/**
 * 只检测注入钱包，不为了显示按钮去初始化 WalletConnect 的远程会话。
 * getProvider 放在 effect 中调用并捕获异常：某些扩展的 ethereum getter 会抛错，
 * 不能在 render 里直接读 window.ethereum，导致整个页面失效。
 */
export async function pickable(connectors: readonly Connector[]): Promise<Connector[]> {
  const checked = await Promise.all(connectors.map(async (connector) => {
    if (connector.type !== 'injected') return connector
    try {
      return await connector.getProvider() ? connector : null
    } catch {
      return null
    }
  }))
  const available = checked.filter((c): c is Connector => c !== null)
  // 只有具体的注入钱包才能替代通用 injected；WalletConnect 不属于扩展发现结果。
  const discovered = available.some((c) => c.type === 'injected' && c.id !== 'injected')
  return available.filter((c) => !discovered || c.id !== 'injected')
}

/**
 * 沿 cause 链取错误：跨 realm 的钱包报错不一定是 instanceof Error，
 * 因此只认字段。最多六层，避免自引用 cause 无限循环。
 */
export function explainConnectError(e: unknown): string {
  const texts: string[] = []
  const msgs: string[] = []
  let cur: unknown = e
  for (let i = 0; cur != null && i < 6; i++) {
    if (typeof cur === 'string') {
      texts.push(cur)
      msgs.push(cur)
      break
    }
    if (typeof cur !== 'object') {
      texts.push(String(cur))
      break
    }
    const o = cur as Record<string, unknown>
    for (const k of ['shortMessage', 'message', 'name']) {
      const v = o[k]
      if (typeof v !== 'string' || !v) continue
      texts.push(v)
      // name 只用来匹配错误类型，不展示类名。
      if (k !== 'name') msgs.push(v)
    }
    if (typeof o.code === 'number' || typeof o.code === 'string') {
      texts.push(`code=${o.code}`)
    }
    cur = o.cause
  }

  const text = texts.join(' | ')
  if (/ProviderNotFoundError|provider not found/i.test(text)) {
    return tr(
      '当前浏览器没有注入钱包。请使用 WalletConnect，或在币安钱包 / MetaMask 的内置浏览器中打开本站后连接。',
      'No wallet is injected into this browser. Use WalletConnect, or open this site in the Binance Wallet / MetaMask in-app browser.',
    )
  }
  if (/-32002|already pending/i.test(text)) {
    return tr(
      '钱包里还有一个没处理完的连接请求（-32002）。打开钱包确认或取消那笔待处理请求，再点一次。',
      'Your wallet still has a pending connection request (-32002). Open your wallet, approve or cancel that prompt, then try again.',
    )
  }
  if (/reject|denied|refus/i.test(text)) return tr('你在钱包里拒绝了这次连接。', 'You rejected the connection in your wallet.')
  // 最里层的报文通常比外层的 "Failed to connect." 更有用。
  return msgs[msgs.length - 1] ?? texts[texts.length - 1] ?? tr('连接失败', 'Connection failed')
}
