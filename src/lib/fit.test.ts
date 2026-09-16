/**
 * 画布自适应判据测试。
 *
 * 最要紧的两条（都反直觉，也都是实际踩过的）：
 *  1. 宽屏不该无脑贴宽 —— 高度卡死时才退 width，否则一屏看全更好。
 *  2. 窄屏不该退 width —— 贴宽换不来更大的节点，滚动是白付代价。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { chooseFit, contentBox, MIN_NODE_R_PX, VB, PAD } from './fit'

/** 模板 22 个槽位的实测坐标范围，与 resolveTemplate 的输出一致 */
const REAL_PTS = [
  { x: 112, y: 112 },
  { x: 1222, y: 1663 },
]

test('contentBox 按内容外扩 PAD，而不是用设计稿全幅', () => {
  const box = contentBox(REAL_PTS)
  assert.equal(box.x, 112 - PAD)
  assert.equal(box.y, 112 - PAD)
  assert.equal(box.w, 1222 + PAD - (112 - PAD))
  assert.equal(box.h, 1663 + PAD - (112 - PAD))
  // 必须比设计稿全幅小：否则等于把四周空白也缩进去
  assert.ok(box.w < VB.width, `${box.w} 应小于 ${VB.width}`)
  assert.ok(box.h < VB.height, `${box.h} 应小于 ${VB.height}`)
})

test('无槽位时退回设计稿全幅，不产生 0 尺寸 viewBox', () => {
  const box = contentBox([])
  assert.deepEqual(box, { x: 0, y: 0, w: VB.width, h: VB.height })
})

test('容器尺寸未测到（0）时不崩，按 contain 处理', () => {
  const box = contentBox(REAL_PTS)
  const fit = chooseFit({ w: 0, h: 0 }, box)
  assert.equal(fit.mode, 'contain')
  assert.equal(fit.scaleContain, 0)
})

test('宽屏一屏看全：节点半径够大就 contain', () => {
  const box = contentBox(REAL_PTS)
  // 1920x1080 减去 header 与侧栏
  const fit = chooseFit({ w: 1608, h: 1004 }, box)
  assert.equal(fit.mode, 'contain')
  assert.ok(fit.scaleContain * VB.r >= MIN_NODE_R_PX)
})

test('高度卡死时退 width：笔记本 1366x768 节点会糊', () => {
  const box = contentBox(REAL_PTS)
  const fit = chooseFit({ w: 1054, h: 692 }, box)
  assert.equal(fit.mode, 'width')
  // contain 下半径不足，width 下明显变大才值得滚
  assert.ok(fit.scaleContain * VB.r < MIN_NODE_R_PX)
  assert.ok(fit.scaleWidth > fit.scaleContain)
})

test('窄容器不退 width：贴宽换不来更大节点，不该白滚', () => {
  const box = contentBox(REAL_PTS)
  // 平板竖屏 834x1112 减去侧栏后约 522x1036，卡在宽度上
  const fit = chooseFit({ w: 522, h: 1036 }, box)
  assert.equal(fit.mode, 'contain')
  // 两种模式缩放几乎相同 —— 这正是不该滚的理由
  assert.ok(fit.scaleWidth <= fit.scaleContain * 1.01)
})

test('竖屏同理：宽度是瓶颈，保持 contain', () => {
  const box = contentBox(REAL_PTS)
  const fit = chooseFit({ w: 768, h: 1844 }, box)
  assert.equal(fit.mode, 'contain')
})

test('width 模式不放大超过内容盒原宽', () => {
  const box = contentBox(REAL_PTS)
  // 矮而宽：2000x500，贴宽会想放大到 1.5 倍
  const fit = chooseFit({ w: 1688, h: 424 }, box)
  assert.equal(fit.mode, 'width')
  assert.equal(fit.widthPx, box.w)
  assert.ok(fit.scaleWidth <= 1)
})

test('width 模式的高度按内容盒比例算，不会拉伸变形', () => {
  const box = contentBox(REAL_PTS)
  const fit = chooseFit({ w: 1054, h: 692 }, box)
  const ratio = fit.heightPx / fit.widthPx
  assert.ok(Math.abs(ratio - box.h / box.w) < 1e-9, `比例 ${ratio} 应等于 ${box.h / box.w}`)
})

test('超宽屏与 2K 判定一致：宽度富余不改变结论', () => {
  const box = contentBox(REAL_PTS)
  const a = chooseFit({ w: 2248, h: 1364 }, box)
  const b = chooseFit({ w: 3128, h: 1364 }, box)
  assert.equal(a.mode, 'contain')
  assert.equal(b.mode, 'contain')
  // 高度相同 → contain 缩放相同（被高度卡住），多出来的宽度不影响
  assert.equal(a.scaleContain, b.scaleContain)
})
