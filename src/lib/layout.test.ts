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
  layoutSlots,
} from './layout'
import { isOuterSlot, TEMPLATE_EDGES, TEMPLATE_SLOTS } from '../graph/template'

/** 模板槽位，只取排布需要的字段 */
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

test('折叠后按剩余节点重新铺满，节点变大且各尺寸不重叠', () => {
  const compact = TEMPLATE_SLOTS.filter((s) => !isOuterSlot(s))
  for (const [name, c] of Object.entries(ALL)) {
    const { slots, r, viewBox } = layoutSlots(compact, c)
    assert.equal(viewBox.w, c.w)
    assert.equal(viewBox.h, c.h)
    assert.ok(r > layoutSlots(TEMPLATE_SLOTS, c).r, `${name} 折叠后应释放空间给剩余节点`)
    for (let i = 0; i < slots.length; i += 1) {
      const s = slots[i]
      assert.ok(s.x >= r && s.x + r <= c.w && s.y >= r && s.y + r <= c.h, `${name} ${s.key} 出界`)
      for (let j = i + 1; j < slots.length; j += 1) {
        const d = Math.hypot(s.x - slots[j].x, s.y - slots[j].y)
        assert.ok(d >= 2 * r - 1e-6, `${name} ${s.key} 与 ${slots[j].key} 重叠`)
      }
    }
  }
})

test('半径为正且不超过 MAX_R，窄屏允许缩小以避免重叠', () => {
  for (const [name, c] of Object.entries(ALL)) {
    const { r } = layoutSlots(SLOTS, c)
    assert.ok(r > 0, `${name} r=${r} 必须为正`)
    assert.ok(r <= MAX_R, `${name} r=${r} 超过上限`)
  }
  assert.ok(layoutSlots(SLOTS, PHONE).r < MIN_R, '扩展模板在手机上不能强撑最小半径')
})

test('相对方位在所有屏幕上保持一致（同一套标准的核心）', () => {
  // 取几对有明确上下/左右关系的槽位，断言在每种容器里关系都不变
  const above: Array<[string, string]> = [
    ['total_8.5', 'total_7.5'],
    ['total_7.5', 'total_6.5'],
    ['total_6.5', 'total_5.5'],
    ['total_5.5', 'total_4.5'], // 大小球梯子自上而下
    ['total_4.5', 'total_3.5'],
    ['total_3.5', 'total_2.5'],
    ['total_2.5', 'total_1.5'],
    ['home_5.5', 'home_4.5'],
    ['home_4.5', 'home_3.5'],
    ['home_3.5', 'home_2.5'],
    ['away_5.5', 'away_4.5'],
    ['away_4.5', 'away_3.5'],
    ['away_3.5', 'away_2.5'],
    ['home_2.5', 'home_1.5'], // 两翼向外上方
    ['away_2.5', 'away_1.5'],
    ['goals_total', 'goals_home'], // 中心 → 单队
    ['ml_home', 'sp_home_-1.5'], // 胜平负 → 让球
    ['sp_home_-1.5', 'sp_home_-2.5'], // 让球梯子
    ['sp_home_-2.5', 'sp_home_-3.5'],
    ['sp_home_-3.5', 'sp_home_-4.5'],
    ['sp_home_-4.5', 'sp_home_-5.5'],
    ['sp_away_+2.5', 'sp_away_+3.5'],
    ['sp_away_+3.5', 'sp_away_+4.5'],
    ['sp_away_+4.5', 'sp_away_+5.5'],
  ]
  const leftOf: Array<[string, string]> = [
    ['home_5.5', 'home_4.5'],
    ['away_4.5', 'away_5.5'],
    ['sp_home_-5.5', 'sp_home_+5.5'],
    ['sp_home_+5.5', 'sp_away_-5.5'],
    ['sp_away_-5.5', 'sp_away_+5.5'],
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

test('笔记本默认折叠视图不需要滚动，且半径可读', () => {
  const compact = TEMPLATE_SLOTS.filter((s) => !isOuterSlot(s))
  const { viewBox, r } = layoutSlots(compact, LAPTOP)
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

// ==================== 间距均匀 ====================

/** 模板里每条边在当前容器下的长度，除以直径 —— 眼睛读到的间距就是它 */
function edgeSpans(c: { w: number; h: number }) {
  const visible = TEMPLATE_SLOTS.filter((s) => !isOuterSlot(s)).map((s) => ({
    key: s.key,
    x: s.x,
    y: s.y,
  }))
  const { slots, r } = layoutSlots(visible, c)
  const at = (k: string) => slots.find((s) => s.key === k)!
  const lens = TEMPLATE_EDGES.filter(
    ([a, b]) => visible.some((s) => s.key === a) && visible.some((s) => s.key === b),
  )
    .map(([a, b]) => {
      const pa = at(a)
      const pb = at(b)
      return Math.hypot(pa.x - pb.x, pa.y - pb.y) / (2 * r)
    })
    .sort((x, y) => x - y)
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length
  const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length)
  return { r, min: lens[0], max: lens[lens.length - 1], cv: sd / mean }
}

test('竖屏上相邻节点的间距均匀：最长的一条边不超过最短的 1.6 倍', () => {
  // 竖屏是这个问题的主场：x 被压扁、y 被拉长，各梯子的步长差被放大到 1.5 倍以上，
  // 看上去就是「上面挤、下面散」。横屏另有一段历史遗留（横向步长比纵向长得多，
  // DESKTOP 2.3 / ULTRAWIDE 3.3），这次只修竖屏，所以阈值只卡竖屏。
  for (const [name, c] of Object.entries(ALL)) {
    if (c.w / c.h > 1) continue
    const s = edgeSpans(c)
    assert.ok(s.max / s.min < 1.6, `${name}: 间距差到 ${(s.max / s.min).toFixed(2)} 倍（${s.min.toFixed(2)}..${s.max.toFixed(2)}）`)
    assert.ok(s.cv < 0.15, `${name}: 离散度 ${s.cv.toFixed(3)} 偏大`)
  }
})

test('窄屏上节点不会因为调模板而变小', () => {
  // 半径由「全图最近的一对 × R_OF_GAP」定，所以任何一次调模板都可能悄悄把
  // 全图缩一圈。这三个数是这次调完好间距之后的实测值，往下卡住。
  const got = {
    '840x1570': layoutSlots(TEMPLATE_SLOTS.filter((s) => !isOuterSlot(s)), { w: 840, h: 1570 }).r,
    '390x780': layoutSlots(TEMPLATE_SLOTS.filter((s) => !isOuterSlot(s)), { w: 390, h: 780 }).r,
    '820x1100': layoutSlots(TEMPLATE_SLOTS.filter((s) => !isOuterSlot(s)), { w: 820, h: 1100 }).r,
  }
  assert.ok(got['840x1570'] > 45, `手机画布半径只剩 ${got['840x1570'].toFixed(1)}`)
  assert.ok(got['390x780'] > 21, `小屏手机半径只剩 ${got['390x780'].toFixed(1)}`)
  assert.ok(got['820x1100'] > 37, `平板竖屏半径只剩 ${got['820x1100'].toFixed(1)}`)
})

test('槽位位置对容器尺寸连续：拖窗口时不跳变', () => {
  // 拖窗口时宽度是连续变的，节点位置也必须连续 —— 否则会看到它「啪」地跳一格。
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
