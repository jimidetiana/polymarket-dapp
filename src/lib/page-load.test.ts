import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPageReload } from './page-load'

/** 把 performance.getEntriesByType 换成给定返回 */
function stubNavigation(entries: unknown) {
  vi.stubGlobal('performance', {
    getEntriesByType: () => entries,
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('isPageReload', () => {
  it('刷新出来的是 true', () => {
    stubNavigation([{ type: 'reload' }])
    expect(isPageReload()).toBe(true)
  })

  it('点链接进来、前进后退都不是刷新', () => {
    stubNavigation([{ type: 'navigate' }])
    expect(isPageReload()).toBe(false)
    stubNavigation([{ type: 'back_forward' }])
    expect(isPageReload()).toBe(false)
  })

  it('拿不到 Navigation Timing 时按「不是刷新」 —— 宁可多弹一次也不让深链失效', () => {
    stubNavigation([])
    expect(isPageReload()).toBe(false)
    vi.stubGlobal('performance', {
      getEntriesByType: () => {
        throw new Error('unsupported')
      },
    })
    expect(isPageReload()).toBe(false)
  })
})
