export function marketHref(market: { conditionId: string; asset: string }): string {
  return `#/market?${new URLSearchParams({ condition: market.conditionId, token: market.asset })}`
}

export function parseMarketLink(hash: string): { conditionId: string; tokenId: string } | null {
  if (!hash.startsWith('#/market?')) return null
  const params = new URLSearchParams(hash.slice(hash.indexOf('?') + 1))
  return { conditionId: params.get('condition') ?? '', tokenId: params.get('token') ?? '' }
}
