import { ConnectionController, StorageUtil } from '@reown/appkit-controllers'

interface WalletLink {
  mobile_link?: string | null
  link_mode?: string | null
  play_store?: string | null
}

function walletBase(link: string): string {
  let base = link
  if (!base.includes('://')) base = `${base.replaceAll('/', '').replaceAll(':', '')}://`
  return base.endsWith('/') ? base : `${base}/`
}

function androidPackage(playStore?: string | null): string | undefined {
  if (!playStore) return undefined
  try {
    const url = new URL(playStore)
    if (url.origin !== 'https://play.google.com' || url.pathname !== '/store/apps/details') return undefined
    const id = url.searchParams.get('id')
    return id && /^[a-zA-Z]\w*(?:\.[a-zA-Z]\w*)+$/.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

export function androidWalletIntent(href: string, wallets: readonly WalletLink[]): string | undefined {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^#]+)$/i.exec(href)
  if (!match || /^(intent|javascript|data|file)$/i.test(match[1])) return undefined
  const queryStart = href.indexOf('?')
  if (queryStart === -1) return undefined
  const params = new URLSearchParams(href.slice(queryStart + 1))
  if (!params.get('uri') && !(params.get('requestId') && params.get('sessionTopic'))) return undefined

  const path = href.slice(0, queryStart)
  for (const wallet of wallets) {
    if (!wallet || typeof wallet !== 'object') continue
    const matchesWallet = [wallet.mobile_link, wallet.link_mode].some(
      (link) => typeof link === 'string' && link && path === `${walletBase(link)}wc`,
    )
    if (!matchesWallet) continue
    const packageId = androidPackage(wallet.play_store)
    if (packageId) {
      return `intent://${match[2]}#Intent;scheme=${match[1]};package=${packageId};end`
    }
  }
  return undefined
}

let installed = false

export function installAndroidWalletLaunch() {
  if (installed || typeof window === 'undefined' || typeof navigator === 'undefined' || !/Android/i.test(navigator.userAgent)) return
  installed = true
  const open = window.open.bind(window)

  // 两个 SDK 入口共用 window.open；不能把 Intent 存成 href，签名 SDK 还会往 href 后追加 /wc 参数。
  window.open = (url, target, features) => {
    let intent: string | undefined
    if (url != null) {
      try {
        const href = String(url)
        const isPairing = new URLSearchParams(href.slice(href.indexOf('?') + 1)).has('uri')
        const current = ConnectionController.state.recentWallet
        if (isPairing) {
          intent = androidWalletIntent(href, current ? [current] : [])
        } else {
          const selected = StorageUtil.getWalletConnectDeepLink()
          const recent = StorageUtil.getRecentWallets()
          const wallets = [current, ...(Array.isArray(recent) ? recent : [])]
            .filter((wallet): wallet is NonNullable<typeof wallet> => Boolean(wallet))
          intent = androidWalletIntent(href, wallets.filter((wallet) => wallet.name === selected?.name))
        }
      } catch {
        // 存储被禁用或旧记录损坏时，不阻断 SDK 原本的连接流程。
      }
    }
    if (intent) {
      window.location.assign(intent)
      return null
    }
    return open(url, target, features)
  }
}
