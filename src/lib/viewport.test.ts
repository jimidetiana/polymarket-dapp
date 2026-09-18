/**
 * 缩放平移的换算测试。
 *
 * 重点不是「函数会不会跑」，而是三件容易写错、且肉眼很难发现的事：
 *  1. 定点缩放：捏住的那一点必须留在原处（差一点点就是「图自己跑」的手感）
 *  2. 夹取边界：k=1 时不许平移；放大后不许把内容拖出画面
 *  3. 留边补偿：容器与内容盒不等比时，像素→用户坐标要减掉半条留边
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  IDENTITY,
  MAX_K,
  MIN_K,
  baseScale,
  clampView,
  clientToUser,
  isZoomed,
  panBy,
  transformOf,
  zoomAt,
} from './viewport'
import { layoutSlots } from './layout'
import { TEMPLATE_SLOTS } from '../graph/template'

/**
 * 模板 22 个槽位的原始坐标。
 *
 * 直接引模板而不是抄一份：抄下来的坐标改了模板也不会红，
 * 断言会悄悄失去意义（stale `s * 76` 就是这么来的）。
 */
const REAL_SLOTS = TEMPLATE_SLOTS.map((s) => ({ x: s.x, y: s.y }))

/**
 * 一个测试用的内容盒，用来验算 baseScale / clampView / clientToUser。
 *
 * 这些函数是通用几何，与「viewBox 是否等于容器」无关 —— 传一个非等比的盒
 * 反而更能测出留边补偿写错。真实运行时 viewBox 由 layoutSlots 给，恒等于容器。
 */
const BOX = { x: 12, y: 12, w: 1310, h: 1751 }

/** 手机竖屏容器：空间本身不够，排布省不出来，只能靠缩放 */
const PHONE = { w: 366, h: 700 }
/** 桌面 1080p 的画布区 */
const DESKTOP = { w: 1608, h: 1004 }

const near = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`)

test('baseScale 取较小方向，并给出居中留边', () => {
  const { s, ox, oy } = baseScale(PHONE, BOX)
  // 366/1310 = 0.2794 < 700/1751 = 0.3998 → 宽度是瓶颈
  near(s, 366 / 1310)
  near(ox, 0) // 宽度贴满，没有横向留边
  assert.ok(oy > 0) // 纵向有留边
})

test('baseScale 容器为 0 时不炸，返回 0 缩放', () => {
  const { s } = baseScale({ w: 0, h: 0 }, BOX)
  assert.equal(s, 0)
})

test('基础适配下不允许平移', () => {
  // k=1 时整图已铺满，拖动只会把内容拖出画面
  const v = clampView({ k: 1, tx: -500, ty: 300 }, BOX)
  assert.equal(v.tx, 0)
  assert.equal(v.ty, 0)
})

test('缩放倍数夹在 [MIN_K, MAX_K]', () => {
  assert.equal(clampView({ k: 0.2, tx: 0, ty: 0 }, BOX).k, MIN_K)
  assert.equal(clampView({ k: 99, tx: 0, ty: 0 }, BOX).k, MAX_K)
})

test('放大后平移被夹住，内容不会跑出画面', () => {
  const k = 3
  // 往左上狂拖
  const v = clampView({ k, tx: -99999, ty: -99999 }, BOX)
  // 可见的用户坐标右下角不应超出内容盒
  const rightEdge = (BOX.x + BOX.w - v.tx) / k
  assert.ok(rightEdge <= BOX.x + BOX.w + 1e-6, `右边界 ${rightEdge} 超出`)
  const bottomEdge = (BOX.y + BOX.h - v.ty) / k
  assert.ok(bottomEdge <= BOX.y + BOX.h + 1e-6, `下边界 ${bottomEdge} 超出`)
})

test('zoomAt 保持锚点不动（定点缩放的核心）', () => {
  const anchor = { x: 600, y: 900 }
  const before = IDENTITY
  const after = zoomAt(before, anchor, 2.5, BOX)

  // 屏幕位置 v = k*u + t，缩放前后必须相等
  const vBefore = { x: before.k * anchor.x + before.tx, y: before.k * anchor.y + before.ty }
  const vAfter = { x: after.k * anchor.x + after.tx, y: after.k * anchor.y + after.ty }
  near(vBefore.x, vAfter.x, 1e-4)
  near(vBefore.y, vAfter.y, 1e-4)
})

test('zoomAt 到达上限后返回原值，不再变化', () => {
  const atMax = clampView({ k: MAX_K, tx: 0, ty: 0 }, BOX)
  const again = zoomAt(atMax, { x: 600, y: 900 }, 2, BOX)
  assert.equal(again.k, MAX_K)
})

test('zoomAt 缩不到基础适配以下', () => {
  const v = zoomAt(IDENTITY, { x: 600, y: 900 }, 0.3, BOX)
  assert.equal(v.k, MIN_K)
  assert.equal(v.tx, 0)
  assert.equal(v.ty, 0)
})

test('clientToUser 在等比容器里还原坐标', () => {
  // 构造一个与内容盒同比例的容器，留边为 0，换算最直观
  const box = { x: 0, y: 0, w: 1000, h: 1000 }
  const container = { w: 500, h: 500 }
  const u = clientToUser(250, 250, container, box, IDENTITY)
  near(u.x, 500)
  near(u.y, 500)
})

test('clientToUser 减掉了 meet 留边', () => {
  // 容器比内容盒扁：纵向贴满、横向留边。中心点仍应映射到内容盒中心
  const box = { x: 0, y: 0, w: 100, h: 200 }
  const container = { w: 400, h: 400 } // s = min(4, 2) = 2，横向留边 (400-200)/2 = 100
  const u = clientToUser(200, 200, container, box, IDENTITY)
  near(u.x, 50) // 内容盒横向中心
  near(u.y, 100) // 纵向中心
})

test('clientToUser 在放大平移后仍能还原', () => {
  const view = clampView({ k: 3, tx: -800, ty: -1200 }, BOX)
  // 取一个用户坐标点，正向算到像素，再反算回来
  const u0 = { x: 500, y: 700 }
  const { s, ox, oy } = baseScale(DESKTOP, BOX)
  const vx = view.k * u0.x + view.tx
  const vy = view.k * u0.y + view.ty
  const px = ox + (vx - BOX.x) * s
  const py = oy + (vy - BOX.y) * s

  const back = clientToUser(px, py, DESKTOP, BOX, view)
  near(back.x, u0.x, 1e-4)
  near(back.y, u0.y, 1e-4)
})

test('panBy 按像素位移换算，放大后手感一致', () => {
  const { s } = baseScale(DESKTOP, BOX)
  const start = clampView({ k: 2, tx: -400, ty: -600 }, BOX)
  const moved = panBy(start, -50, -30, DESKTOP, BOX)
  // 位移应等于像素 / baseScale（不是直接加像素）
  near(moved.tx, start.tx - 50 / s, 1e-6)
  near(moved.ty, start.ty - 30 / s, 1e-6)
})

test('panBy 在基础适配下无效（被夹回 0）', () => {
  const v = panBy(IDENTITY, -200, -200, DESKTOP, BOX)
  assert.equal(v.tx, 0)
  assert.equal(v.ty, 0)
})

test('isZoomed 区分基础适配与已缩放', () => {
  assert.equal(isZoomed(IDENTITY), false)
  assert.equal(isZoomed({ k: 2, tx: -100, ty: -100 }), true)
  assert.equal(isZoomed({ k: 1, tx: -100, ty: 0 }), true)
})

test('transformOf 顺序是先 translate 再 scale', () => {
  // 顺序写反会让平移量被缩放乘一遍，放大后拖动距离对不上
  assert.equal(transformOf({ k: 2, tx: -100, ty: 50 }), 'translate(-100 50) scale(2)')
})

test('手机小屏靠放大能达到可读半径', () => {
  // 这是加缩放的动机：手机竖屏上 22 个槽位排下来，单个节点半径被挤到
  // MIN_R 附近，标签虽不重叠但偏小；剩下的可读性交给捏合放大。
  //
  // 半径直接问 layoutSlots，不再用 baseScale * 常量反推 —— 原来那样写
  // 等于把基准半径抄成字面量 76，改了 layout.ts 里的常量这里也不会红，
  // 断言会悄悄失去意义（已经发生过一次）。
  const { r } = layoutSlots(REAL_SLOTS, PHONE)
  assert.ok(r <= 30, `手机上半径 ${r} 本应偏小`)
  // 捏合放大 3 倍后越过 34px 可读线
  assert.ok(r * 3 >= 34, `放大 3 倍后 ${r * 3} 应可读`)
})
