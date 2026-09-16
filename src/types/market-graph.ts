/**
 * 画布用的类型别名。
 *
 * 原项目前后端 tsconfig 独立，没法互相 import，所以前端手抄了一份类型，
 * 靠「改后端记得改前端」维持一致。dapp 没有这个分界——推导逻辑
 * （graph/）和画布在同一个编译单元里，所以这里只做**重命名转发**，
 * 不再抄第二份定义。抄一份的代价是它会静默漂移：字段含义变了而类型仍
 * 编译通过，图就会画错而没人报错。
 *
 * 名字对应关系（画布沿用前端旧名，右侧是推导逻辑里的真名）：
 *   GraphSlot       → template.ResolvedSlot
 *   GraphGoalCounts → template.GoalCounts
 */
export type { MarketGraph, GraphNode, GraphEdge, GraphSide, MarketDescriptor } from '@/graph/types'
export type { ResolvedSlot as GraphSlot, GoalCounts as GraphGoalCounts } from '@/graph/template'
