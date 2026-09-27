/**
 * 导出图片里「价格」两种口径的换算。视觉排版没法在 node 里验（要 canvas），
 * 但**百分比 / 欧赔的定义**是用户明确要求的、又容易写错（欧赔常被误当成美式赔率或写成
 * 1-p），所以单独钉住。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { euroOdds, pct } from './orders-export'

test('百分比 = 成交价 ×100', () => {
  assert.equal(pct(0.45), '45.0%')
  assert.equal(pct(0.5), '50.0%')
  assert.equal(pct(0.015), '1.5%')
  assert.equal(pct(1), '100.0%')
})

test('欧赔 = 1 / 成交价（十进制赔率）', () => {
  assert.equal(euroOdds(0.5), '2.00')
  assert.equal(euroOdds(0.45), '2.22')
  assert.equal(euroOdds(0.8), '1.25')
  // 0 价无意义，给占位而不是 Infinity
  assert.equal(euroOdds(0), '—')
})
