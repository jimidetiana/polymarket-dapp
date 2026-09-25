/**
 * 盘口关系图的主客队配色方案。
 *
 * 单独拆出来是为了避免 React Fast Refresh 对「组件文件里同时导出组件和常量」
 * 发出警告，也方便测试页和画布共用同一套预设。
 *
 * 颜色层级：
 *   home / away          主客队实时报价节点（最饱和）
 *   homeDim / awayDim    主客队只有快照的节点（同色相压暗）
 *   neutral              中性盘口实时报价节点（总进球、平局等）
 *   goalTotal            中心「总进球」推断节点，比 neutral 深一档
 *   neutralDim           中性盘口只有快照的节点（最深）
 *   hit / hitDim         已打出的大小球节点
 */
export type TeamPaletteKey = 'amberIndigo' | 'redBlue' | 'orangeTeal' | 'coralSapphire'

export interface TeamPalette {
  name: string
  home: string
  homeDim: string
  away: string
  awayDim: string
  neutral: string
  neutralDim: string
  goalTotal: string
  hit: string
  hitDim: string
}

export const PALETTES: Record<TeamPaletteKey, TeamPalette> = {
  amberIndigo: {
    name: '琥珀橙 + 靛蓝',
    home: '#d97706',
    homeDim: '#92400e',
    away: '#4f46e5',
    awayDim: '#3730a3',
    neutral: '#007aff',
    neutralDim: '#0040dd',
    goalTotal: '#0056b3',
    hit: '#248a3d',
    hitDim: '#1a6d2f',
  },
  redBlue: {
    name: '运动红 + 经典蓝',
    home: '#dc2626',
    homeDim: '#991b1b',
    away: '#2563eb',
    awayDim: '#1e40af',
    // 中性色从灰改成钢蓝，和客队的经典蓝同系，避免红蓝主题里夹一块突兀的灰
    neutral: '#5b7fa3',
    neutralDim: '#3d5a7a',
    goalTotal: '#4a6b8a',
    // 已打出绿压暗一档，避免在红白蓝之间显得像高亮色
    hit: '#15803d',
    hitDim: '#14532d',
  },
  orangeTeal: {
    name: '暖橙 + 青绿',
    home: '#ea580c',
    homeDim: '#9a3412',
    away: '#0d9488',
    awayDim: '#115e59',
    neutral: '#475569',
    neutralDim: '#1e293b',
    goalTotal: '#334155',
    hit: '#15803d',
    hitDim: '#14532d',
  },
  coralSapphire: {
    name: '珊瑚红 + 宝石蓝',
    home: '#be123c',
    homeDim: '#881337',
    away: '#1d4ed8',
    awayDim: '#1e3b8b',
    neutral: '#52525b',
    neutralDim: '#27272a',
    goalTotal: '#3f3f46',
    hit: '#15803d',
    hitDim: '#14532d',
  },
}

export const DEFAULT_PALETTE: TeamPaletteKey = 'amberIndigo'
