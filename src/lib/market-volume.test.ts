import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildMarketGraph } from '@/graph/graph'
import { fetchRecentMarketTrades, type PolyTrade } from './positions'
import { slotVolumes, summarizeVolume } from './market-volume'

const graph = buildMarketGraph({ id: 'event', homeTeamEn: 'Home FC', awayTeamEn: 'Away FC' }, [{
  id: 'm', conditionId: 'condition', questionEn: 'Spread: Home FC (-1.5)', line: -1.5,
  outcomes: ['Home FC', 'Away FC'], clobTokenIds: ['home', 'away'], volume: 100_000,
}])
const trade = (fields: Partial<PolyTrade> = {}): PolyTrade => ({
  asset: 'home', conditionId: 'condition', side: 'BUY', size: 100, price: 0.4,
  timestamp: 1000, outcome: 'Home FC', title: '', icon: '', transactionHash: 'tx', ...fields,
})

afterEach(() => vi.unstubAllGlobals())

describe('近期成交水位', () => {
  it('按实际交易 token 累计 size × price，买卖均计入，不按报价拆总量', () => {
    const sample = summarizeVolume([
      trade(), trade({ side: 'SELL', size: 10, timestamp: 1100 }),
      trade({ asset: 'away', price: 0.6, timestamp: 900 }),
    ], graph.nodes)
    expect(sample).toEqual({ byToken: { home: 44, away: 60 }, count: 3, oldest: 900, newest: 1100 })
    expect(graph.nodes[0].volume).toBe(100_000)
  })

  it('让球两侧共用 market 时按槽位 token 交换正反方向', () => {
    const sample = summarizeVolume([trade()], graph.nodes)
    expect(slotVolumes(graph.nodes[0], 'home', sample)).toEqual({ own: 40, opposite: 0 })
    expect(slotVolumes(graph.nodes[0], 'away', sample)).toEqual({ own: 0, opposite: 40 })
    expect(slotVolumes(graph.nodes[0], 'home')).toEqual({ own: null, opposite: null })
  })

  it('忽略别场成交和非法数值；样本中无成交与未获取数据有区别', () => {
    const sample = summarizeVolume([
      trade({ conditionId: 'other' }), trade({ asset: 'other' }),
      trade({ price: NaN }), trade({ size: Infinity }), trade({ price: 1.5 }), trade({ size: -1 }),
    ], graph.nodes)
    expect(sample).toEqual({ byToken: { home: 0, away: 0 }, count: 0, oldest: null, newest: null })
  })

  it('公开批量请求只取 taker，不传钱包地址，不用被忽略的 asset 筛选', async () => {
    const mock = vi.fn().mockResolvedValue({ ok: true, json: async () => [trade()] })
    vi.stubGlobal('fetch', mock)
    expect(await fetchRecentMarketTrades([])).toEqual([])
    expect(mock).not.toHaveBeenCalled()
    expect(await fetchRecentMarketTrades(['a', 'b'])).toHaveLength(1)
    const url = new URL(mock.mock.calls[0][0])
    expect(url.searchParams.get('market')).toBe('a,b')
    expect(url.searchParams.get('limit')).toBe('1000')
    expect(url.searchParams.get('takerOnly')).toBe('true')
    expect(url.searchParams.has('user')).toBe(false)
    expect(url.searchParams.has('asset')).toBe(false)
  })
})
