/**
 * 动态排布测试。
 *
 * 要守住的是四条不变量 —— 全都是「画布初始太大还得滚」那个 bug 的反面：
 *  1. viewBox 恒等于容器 → 永远不滚动、不留边
 *  2. 任何比例下节点都不重叠（半径由最小间距反推，不是手写常量）
 *  3. 相对方位在所有屏幕上一致 → 换比赛/换设备不用重新找位置
 *  4. 退化输入（容器为 0、单个槽位）不产生 NaN —— NaN 会让 SVG 静默空白
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  BASE_R,
  EDGE_PAD_OF_R,
  MAX_R,
  MIN_R,
  R_OF_GAP,
  convergeStrength,
  layoutSlots,
} from './layout'
import { TEMPLATE_SLOTS } from '../graph/template'

/** 真实的 26 个槽位，只取排布需要的字段 */
const SLOTS = TEMPLATE_SLOTS.map((s) => ({ key: s.key, x: s.x, y: s.y }))

/** 几种真实容器：桌面、笔记本（原来会退 width 模式的那个）、平板竖屏、手机、超宽、矮宽 */
const DESKTOP = { w: 1608, h: 1004 }
const LAPTOP = { w: 1054, h: 692 }
const TABLET = { w: 522, h: 1036 }
const PHONE = { w: 366, h: 700 }
const ULTRAWIDE = { w: 3128, h: 1364 }
const SHORT = { w: 1688, h: 424 }
const ALL = { DESKTOP, LAPTOP, TABLET, PHONE, ULTRAWIDE, SHORT }

test('viewBox 恒等于容器尺寸 —— 画布就是屏幕，不滚动也不留边', () => {
  for (const [name, c] of Object.entries(ALL)) {
    const { viewBox } = layoutSlots(SLOTS, c)
    assert.equal(viewBox.x, 0, name)
    assert.equal(viewBox.y, 0, name)
    assert.equal(viewBox.w, c.w, `${name} 宽度应等于容器`)
    assert.equal(viewBox.h, c.h, `${name} 高度应等于容器`)
  }
})

test('所有槽位都落在容器内，且圆完整可见（含圆外标签的留白）', () => {
  for (const [name, c] of Object.entries(ALL)) {
    const { slots, r } = layoutSlots(SLOTS, c)
    for (const s of slots) {
      assert.ok(s.x - r >= 0, `${name} ${s.key} 左侧出界`)
      assert.ok(s.y - r >= 0, `${name} ${s.key} 顶部出界`)
      assert.ok(s.x + r <= c.w, `${name} ${s.key} 右侧出界`)
      assert.ok(s.y + r <= c.h, `${name} ${s.key} 底部出界`)
    }
  }
})

test('任何容器比例下节点都不重叠', () => {
  for (const [name, c] of Object.entries(ALL)) {
    const { slots, r } = layoutSlots(SLOTS, c)
    for (let i = 0; i < slots.length; i += 1) {
      for (let j = i + 1; j < slots.length; j += 1) {
        const d = Math.hypot(slots[i].x - slots[j].x, slots[i].y - slots[j].y)
        assert.ok(
          d >= 2 * r - 1e-6,
          `${name}: ${slots[i].key} 与 ${slots[j].key} 中心距 ${d.toFixed(1)} < 直径 ${(2 * r).toFixed(1)}`,
        )
      }
    }
  }
})

test('半径由最小间距反推，夹在 [MIN_R, MAX_R]', () => {
  for (const [name, c] of Object.entries(ALL)) {
    const { r } = layoutSlots(SLOTS, c)
    assert.ok(r >= MIN_R, `${name} r=${r} 低于下限`)
    assert.ok(r <= MAX_R, `${name} r=${r} 超过上限`)
  }
})

test('相对方位在所有屏幕上保持一致（同一套标准的核心）', () => {
  // 取几对有明确上下/左右关系的槽位，断言在每种容器里关系都不变
  const above: Array<[string, string]> = [
    ['total_5.5', 'total_4.5'], // 大小球梯子自上而下
    ['total_4.5', 'total_3.5'],
    ['total_3.5', 'total_2.5'],
    ['total_2.5', 'total_1.5'],
    ['home_2.5', 'home_1.5'], // 两翼向外上方
    ['away_2.5', 'away_1.5'],
    ['goals_total', 'goals_home'], // 中心 → 单队
    ['ml_home', 'sp_home_-1.5'], // 胜平负 → 让球
    ['sp_home_-1.5', 'sp_home_-2.5'], // 让球梯子
  ]
  const leftOf: Array<[string, string]> = [
    ['home_2.5', 'home_1.5'], // 主队梯子往左爬
    ['away_1.5', 'away_2.5'], // 客队梯子往右爬
    ['home_1.5', 'away_1.5'], // 主队在左、客队在右
    ['goals_home', 'goals_away'],
    ['ml_home', 'ml_away'],
    ['sp_home_-1.5', 'sp_away_-1.5'],
  ]
  for (const [name, c] of Object.entries(ALL)) {
    const { slots } = layoutSlots(SLOTS, c)
    const at = (k: string) => slots.find((s) => s.key === k)!
    for (const [a, b] of above) {
      assert.ok(at(a).y < at(b).y, `${name}: ${a} 应在 ${b} 上方`)
    }
    for (const [a, b] of leftOf) {
      assert.ok(at(a).x < at(b).x, `${name}: ${a} 应在 ${b} 左侧`)
    }
  }
})

test('宽屏横向铺开：容器越宽，横向跨度越大', () => {
  const spanX = (c: { w: number; h: number }) => {
    const { slots } = layoutSlots(SLOTS, c)
    const xs = slots.map((s) => s.x)
    return Math.max(...xs) - Math.min(...xs)
  }
  // 这正是原来浪费掉的那半屏：宽度富余时应该用上，而不是被竖长包围盒锁死
  assert.ok(spanX(ULTRAWIDE) > spanX(DESKTOP), '超宽屏应比桌面铺得更开')
  assert.ok(spanX(DESKTOP) > spanX(LAPTOP), '桌面应比笔记本铺得更开')
})

test('笔记本 1366x768 不再需要滚动，且半径可读', () => {
  // 回归：这个尺寸原来会退 width 模式，SVG 高度撑到 1600+px
  const { viewBox, r } = layoutSlots(SLOTS, LAPTOP)
  assert.equal(viewBox.h, LAPTOP.h, '高度不应超出容器')
  assert.ok(r > MIN_R, `r=${r} 应明显高于下限`)
})

test('矮而宽的容器（2000x500）也不滚动', () => {
  const { viewBox, slots } = layoutSlots(SLOTS, SHORT)
  assert.equal(viewBox.h, SHORT.h)
  for (const s of slots) assert.ok(s.y <= SHORT.h, `${s.key} 纵向出界`)
})

test('scale 与 r 同步，节点内部偏移整体缩放', () => {
  const { r, scale } = layoutSlots(SLOTS, DESKTOP)
  assert.ok(Math.abs(scale - r / BASE_R) < 1e-9)
})

test('容器未测到（0×0）时返回安全布局，不产生 NaN', () => {
  const { slots, r, viewBox } = layoutSlots(SLOTS, { w: 0, h: 0 })
  assert.ok(Number.isFinite(r))
  assert.ok(viewBox.w >= 1 && viewBox.h >= 1, 'viewBox 不能是 0 尺寸')
  for (const s of slots) {
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y), `${s.key} 坐标为 NaN`)
  }
})

test('空槽位列表不崩', () => {
  const { slots, viewBox } = layoutSlots([], DESKTOP)
  assert.equal(slots.length, 0)
  assert.ok(viewBox.w > 0)
})

test('单个槽位居中，不因除以 0 得 NaN', () => {
  const { slots } = layoutSlots([{ x: 500, y: 500 }], DESKTOP)
  assert.ok(Number.isFinite(slots[0].x))
  assert.ok(Number.isFinite(slots[0].y))
})

test('同一行的多个槽位（spanY=0）纵向居中而非 NaN', () => {
  const { slots } = layoutSlots(
    [
      { x: 0, y: 100 },
      { x: 500, y: 100 },
    ],
    DESKTOP,
  )
  for (const s of slots) assert.ok(Number.isFinite(s.y))
  assert.ok(Math.abs(slots[0].y - slots[1].y) < 1e-9, '同一行应保持同高')
})

test('留白与半径的关系符合 EDGE_PAD_OF_R', () => {
  const { slots, r } = layoutSlots(SLOTS, DESKTOP)
  const pad = r * EDGE_PAD_OF_R
  const minX = Math.min(...slots.map((s) => s.x))
  const minY = Math.min(...slots.map((s) => s.y))
  assert.ok(Math.abs(minX - pad) < 1e-6, `左留白 ${minX} 应等于 ${pad}`)
  assert.ok(Math.abs(minY - pad) < 1e-6, `上留白 ${minY} 应等于 ${pad}`)
})

test('R_OF_GAP < 0.5，保证相邻节点之间留得下连线', () => {
  assert.ok(R_OF_GAP < 0.5)
})

// ==================== 窄屏收束 ====================

test('收束强度随宽高比单调：越窄越强，且夹在 [0,1]', () => {
  const ratios = [4, 2.4, 1.8, 1.2, 1, 0.75, 0.6, 0.3]
  const ts = ratios.map((a) => convergeStrength(a * 100, 100))
  for (const [i, t] of ts.entries()) {
    assert.ok(t >= 0 && t <= 1, `宽高比 ${ratios[i]} 的强度 ${t} 越界`)
  }
  for (let i = 1; i < ts.length; i += 1) {
    assert.ok(ts[i] >= ts[i - 1], `宽高比 ${ratios[i]} 更窄，强度反而更小`)
  }
  assert.equal(ts[0], 0, '极宽时应当完全不收')
  assert.equal(ts[ts.length - 1], 1, '极窄时应当收到底')
})

test('收束确实是「向中轴收 + 上移」，且不会反方向', () => {
  for (const [name, c] of Object.entries(ALL)) {
    const converged = layoutSlots(TEMPLATE_SLOTS, c).slots
    const bare = layoutSlots(SLOTS, c).slots
    const axis = converged.find((s) => s.key === 'goals_total')!.x
    for (const k of ['goals_home', 'goals_away']) {
      const now = converged.find((s) => s.key === k)!
      const was = bare.find((s) => s.key === k)!
      assert.ok(
        Math.abs(now.x - axis) <= Math.abs(was.x - axis) + 1e-6,
        `${name} ${k} 没有向中轴收`,
      )
      assert.ok(now.y <= was.y + 1e-6, `${name} ${k} 没有上移`)
    }
  }
})

test('收束不改变节点半径 —— 只挪位置，不重新缩放整张图', () => {
  // 这是这次改动最容易被破坏的承诺：r 由「最近一对的间距 × R_OF_GAP」算出，
  // 而中心那个三角正好是全图最近的一对。若 r 改成按收束后的位置算，全图的
  // 圆都会跟着缩水。
  for (const [name, c] of Object.entries(ALL)) {
    const withConverge = layoutSlots(TEMPLATE_SLOTS, c).r
    const without = layoutSlots(SLOTS, c).r
    assert.equal(withConverge, without, `${name}: 半径被收束改动了 ${without} → ${withConverge}`)
  }
})

test('收束是连续的：宽度连续变化时节点不跳变', () => {
  // 拖窗口时宽度是连续变的，节点位置也必须连续 —— 否则会看到它「啪」地跳一格。
  // 安全回退是按档试的，所以这里专门盯住台阶。
  let prev: { x: number; y: number } | null = null
  for (let w = 200; w <= 2400; w += 4) {
    const g = layoutSlots(TEMPLATE_SLOTS, { w, h: 900 }).slots.find((s) => s.key === 'goals_home')!
    if (prev) {
      const jump = Math.hypot(g.x - prev.x, g.y - prev.y)
      assert.ok(jump < 8, `宽度 ${w} 处跳了 ${jump.toFixed(1)}px`)
    }
    prev = { x: g.x, y: g.y }
  }
})
