import { afterEach, expect, test, vi } from 'vitest'
import { marketHref, parseMarketLink } from './market-link'
import { fetchMarketEventIds } from './gamma'

afterEach(() => vi.unstubAllGlobals())

test('订单链接保留盘口和结果代币，包括 URL 特殊字符', () => {
  const market = { conditionId: '0xabc', asset: '123+456&789' }
  expect(parseMarketLink(marketHref(market))).toEqual({ conditionId: market.conditionId, tokenId: market.asset })
  expect(parseMarketLink('#/orders')).toBeNull()
  expect(parseMarketLink('#/')).toBeNull()
  expect(parseMarketLink('#/market?')).toEqual({ conditionId: '', tokenId: '' })
})

test('按 condition 精确查询赛事，不误用接口返回的其他盘口', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([
    { id: '1', conditionId: '0xabc', events: [{ id: '10' }, { id: '11' }] },
    { id: '2', conditionId: 'other', events: [{ id: '12' }] },
  ])))
  vi.stubGlobal('fetch', fetch)
  expect(await fetchMarketEventIds('0xabc')).toEqual(['10', '11'])
  expect(new URL(fetch.mock.calls[0][0]).searchParams.getAll('condition_ids')).toEqual(['0xabc'])
})

test('盘口下架或没有赛事时返回空列表', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([
    { id: '1', conditionId: '0xabc' },
  ]))))
  expect(await fetchMarketEventIds('0xabc')).toEqual([])
  expect(await fetchMarketEventIds('')).toEqual([])
})

test('接口异常由调用方兜底处理', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')))
  await expect(fetchMarketEventIds('0xabc')).rejects.toThrow()
})
