/**
 * 盘口关系图的主客队配色方案。
 *
 * 单独拆出来是为了避免 React Fast Refresh 对「组件文件里同时导出组件和常量」
 * 发出警告，也方便测试页和画布共用同一套预设。
 *
 * 颜色层级：
 *   home / away          主客队节点
 *   neutral              中性盘口节点（总进球、平局等）
 *   goalTotal            中心「总进球」推断节点，比 neutral 深一档
 *   hit                  已打出的大小球节点
 *
 * 不再按「实时报价 / 只有快照」分深浅：同一队两种深浅在图上读起来像配色不统一，
 * 而没有实时报价的节点 Ask/Bid 本来就显示「—」。
 */
export type TeamPaletteKey = 'amberIndigo' | 'redBlue' | 'orangeTeal' | 'coralSapphire'

export interface TeamPalette {
  name: string
  home: string
  away: string
  neutral: string
  goalTotal: string
  hit: string
}

export const PALETTES: Record<TeamPaletteKey, TeamPalette> = {
  amberIndigo: {
    name: '琥珀橙 + 靛蓝',
    home: '#d97706',
    away: '#4f46e5',
    neutral: '#007aff',
    goalTotal: '#0056b3',
    hit: '#248a3d',
  },
  redBlue: {
    name: '运动红 + 经典蓝',
    home: '#dc2626',
    away: '#2563eb',
    // 中性色从灰改成钢蓝，和客队的经典蓝同系，避免红蓝主题里夹一块突兀的灰
    neutral: '#5b7fa3',
    goalTotal: '#4a6b8a',
    // 已打出绿压暗一档，避免在红白蓝之间显得像高亮色
    hit: '#15803d',
  },
  orangeTeal: {
    name: '暖橙 + 青绿',
    home: '#ea580c',
    away: '#0d9488',
    neutral: '#475569',
    goalTotal: '#334155',
    hit: '#15803d',
  },
  coralSapphire: {
    name: '珊瑚红 + 宝石蓝',
    home: '#be123c',
    away: '#1d4ed8',
    neutral: '#52525b',
    goalTotal: '#3f3f46',
    hit: '#15803d',
  },
}

export const DEFAULT_PALETTE: TeamPaletteKey = 'amberIndigo'
