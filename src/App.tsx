/**
 * 常规网页布局：顶栏（品牌 + 价格模式 + 钱包）+ 左栏（比赛列表）+ 关系图。
 *
 * 关系图仍占主位 —— 核心是那张图，交易是图上的动作，不是独立页面。
 * 变的是控制项的位置：比赛列表从顶栏挪进左栏，钱包从版面收进顶栏的浮窗。
 *
 * 原来比赛选择器挤在顶栏里，只能靠 max-w 截断（窄屏 150px，队名都放不下），
 * 点开还是一层盖住半张图的浮层 —— 见 match-picker.tsx 顶部。列表进左栏后
 * 宽度够用，选中态也一直看得见。
 *
 * 左栏只有比赛列表一件事：其余信息（本场统计、实时/快照判据、订单摘要）
 * 看着有用，实际要么画布上已经有了（节点自带快照标记），要么点节点时
 * 会弹出下单面板。堆在栏里只是把画布挤窄、把列表挤到看不见。
 *
 * 窄屏（<lg）左栏收成抽屉，由顶栏的汉堡按钮开合，画布因此拿到整个宽度。
 * 宽屏下左栏固定 288px 常驻。
 *
 * 数据链路全在浏览器里：Gamma API → 合并衍生赛事 → buildMarketGraph
 * → resolveTemplate → 画布。没有后端，没有库。
 */
import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { WalletMenu } from './components/connect-wallet'
import { MarketGraphCanvas } from './components/market-graph-canvas'
import { MatchPicker } from './components/match-picker'
/**
 * 下单弹窗按需加载。
 *
 * 它牵进 @polymarket/client（1929 个模块里的大头），静态 import 会把这整块
 * 打进首屏包。而「打开页面看一眼图」和「下单」是两件事 —— 第一眼不该为
 * 后者付 300 kB gzip 的代价。
 *
 * 用 lazy 而不是静态 import：静态 import 会让打包器无条件把模块拉进依赖图，
 * 与 DictAdmin 那里是同一个理由。
 *
 * 注意它是 `.then(m => ({ default: m.OrderDialog }))` 而不是直接 lazy(import(...))：
 * 那个模块是**具名导出**，React.lazy 只认 default。
 */
const OrderDialog = lazy(() =>
  import('./components/order-dialog').then((m) => ({ default: m.OrderDialog })),
)
import { useSoccerMatches, useMarketGraph, usePositionMatches, TEMPLATE_EDGES } from './lib/use-graph'
import { defaultMatchId, mergeMatchLists } from './lib/match-list'
import { PRICE_MODE_LABEL, type PriceMode } from './lib/odds'
/**
 * 持仓。走公开 REST（lib/positions.ts），**不碰 SDK** —— 画布和比赛列表都在主包里，
 * 引一个间接依赖 SDK 的 hook 会把那 300 kB 打回首屏（见 lib/use-positions.ts 顶部）。
 */
import { usePositions } from './lib/use-positions'
import { cn } from './lib/utils'

/**
 * 词典维护页面，**只在开发时打包**。
 *
 * `import.meta.env.DEV` 是 Vite 的编译期常量：生产构建时它是字面量 false，
 * 整个分支被摇掉，dict-admin.tsx 及其依赖不会进产物。这不是运行时判断 ——
 * 运行时判断会把代码打进包里，只是不显示，那等于把维护后台发到线上。
 *
 * 用 lazy 而不是静态 import：静态 import 会让打包器无条件把模块拉进依赖图，
 * DEV 门就白设了。
 */
const DictAdmin = import.meta.env.DEV ? lazy(() => import('./pages/dict-admin')) : null
const TestGraph = lazy(() => import('./pages/test-graph').then((m) => ({ default: m.default })))

/** 当前 hash 路由。没上 react-router —— 只有两个页面，装路由库不值得 */
function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const on = () => setHash(window.location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash
}

export default function App() {
  const hash = useHash()

  if (DictAdmin && hash === '#/dict') {
    return (
      <Suspense
        fallback={
          <div className="flex h-dvh items-center justify-center bg-background text-sm text-muted-foreground">
            加载中…
          </div>
        }
      >
        <DictAdmin />
      </Suspense>
    )
  }

  if (hash === '#/test') {
    return (
      <Suspense
        fallback={
          <div className="flex h-dvh items-center justify-center bg-background text-sm text-muted-foreground">
            加载中…
          </div>
        }
      >
        <TestGraph />
      </Suspense>
    )
  }

  return <GraphPage />
}

function GraphPage() {
  const { matches, loading, error, network, reload } = useSoccerMatches()
  /**
   * 持仓标记的数据源。一次取全账户，两处共用：画布按 tokenId 查、列表按 eventId 查。
   *
   * 在这一层取而不是各组件自己取：同一份数据取两次，会出现「图上有标记、列表没有」
   * 这种自相矛盾（两次请求的时机不同）。拿不到就是空索引，不挡界面。
   */
  const { index: positions } = usePositions()
  /**
   * 有仓位但**不在时间窗内**的比赛，按赛事 id 单独捞回来。
   *
   * 窗口（今天+明天）管的是「哪些比赛还能下注」，而「我参与过哪些比赛」跟窗口无关 ——
   * 踢完的比赛早就掉出窗口了，列表里没有那一行，持仓徽标也就没有地方挂。
   * 合并规则见 lib/match-list.ts 的 mergeMatchLists（按标题去重、eventIds 取并集）。
   */
  const extraMatches = usePositionMatches(positions.eventIds)
  const allMatches = useMemo(() => mergeMatchLists(matches, extraMatches), [matches, extraMatches])
  const [matchId, setMatchId] = useState<string | null>(null)
  const [priceMode, setPriceMode] = useState<PriceMode>('prob')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  /** 选中的盘口槽位 key。**关掉弹窗不清它** —— 侧栏还要显示这个盘口 */
  const [pickedKey, setPickedKey] = useState<string | null>(null)
  /**
   * 在弹窗里切到的那一侧的名字（Under / No / 某队）。null = 槽位自己的那一侧。
   *
   * 单独存而不是并进 pickedKey：槽位只代表盘口的**一侧** —— 总进球 2.5 是 Over
   * 侧、主胜是 Yes 侧，Under / No 在图上没有槽位，只能从节点的 sides 里找。
   */
  const [pickedSideName, setPickedSideName] = useState<string | null>(null)
  /** 弹窗开关。与 pickedKey 分开：关掉弹窗不该丢掉「刚才看的是哪个盘口」 */
  const [orderOpen, setOrderOpen] = useState(false)
  /**
   * 窄屏左栏抽屉的开合。宽屏左栏常驻，这个值不起作用（lg:translate-x-0 盖掉）。
   *
   * 不按断点分别存状态：选完比赛要收起抽屉，而「收起」在宽屏下本来就该是
   * 无操作 —— 一个布尔值加一组 lg: 覆盖类就够，再拆一个「是不是窄屏」的
   * 状态就得跟着 resize 同步，那是为了省一次无效果的 setState 引入一处不同步。
   */
  const [navOpen, setNavOpen] = useState(false)

  /**
   * 首次拿到列表时自动打开**开赛时间最近的那场**。
   *
   * 不用列表给的顺序（那是重要性排序）：那个顺序与眼睛看到的列表顺序（按开赛时间）
   * 不是一回事，于是默认打开的那场和列表第一行常常不是同一场 —— 实测踩过，
   * 在一个不是自己刚下过单的比赛上找持仓，结论成了「我的持仓不见了」。
   * 口径见 lib/match-list.ts 的 defaultMatchId（有测试钉着）。
   *
   * 只依赖 `matches`：补进来的那些是窗口外的历史比赛，默认不该落到一场已经踢完的
   * 比赛上；等它们回来时 matchId 早就定了，不该被改。
   */
  useEffect(() => {
    if (matchId == null && matches.length > 0) setMatchId(defaultMatchId(matches))
  }, [matches, matchId])

  const match = allMatches.find((m) => m.id === matchId) ?? null
  const {
    graph,
    marketsLoading,
    marketsError,
    reloadMarkets,
    slots,
    goals,
    prevPrices,
    book,
    tickByToken,
  } = useMarketGraph(match)

  /**
   * 存的是**槽位的 key，不是槽位对象**。
   *
   * slots 每次报价变动都会重算（resolveTemplate 依赖 graph），对象引用每轮
   * 都是新的。存对象会让弹窗里的 target 在每次价格跳动后被判为「新的」，
   * 把用户正在填的表单重置掉。key 是稳定的。
   */
  const picked = useMemo(() => slots.find((s) => s.key === pickedKey) ?? null, [slots, pickedKey])

  const pickedNode = useMemo(
    () => (picked?.nodeId ? (graph?.nodes.find((n) => n.id === picked.nodeId) ?? null) : null),
    [graph, picked],
  )

  /**
   * 真正要下单的那一侧。默认是槽位自己的那一侧（总进球 2.5 → Over，主胜 → Yes），
   * 在弹窗里切过就是另一侧 —— token、报价、tick 都从这一侧取，不从槽位取。
   */
  const pickedSide = useMemo(() => {
    if (!pickedNode || !picked) return null
    const sides = pickedNode.sides.filter((s) => s.tokenId)
    return sides.find((s) => s.name === pickedSideName) ?? sides.find((s) => s.tokenId === picked.tokenId) ?? null
  }, [pickedNode, picked, pickedSideName])

  /**
   * 同一张盘口的可下单侧，给弹窗做 Over/Under、Yes/No 切换。
   *
   * 从节点的 sides 取，**不从兄弟槽位取**：大小球和胜平负每张盘只有一个槽位
   * （另一侧不在图上），按槽位找永远只有一侧，切换按钮就不会出现。这就是
   * 原来点进去只能买 Over / Yes 的原因。让球盘两侧各有槽位，两种取法一样。
   */
  const pickedSides = useMemo(
    () =>
      (pickedNode?.sides ?? [])
        .filter((s) => s.tokenId)
        .map((s) => ({ name: s.name, tokenId: s.tokenId as string })),
    [pickedNode],
  )

  return (
    // h-dvh + flex 列，而不是 min-h-screen：
    //  1. 画布要用 ResizeObserver 量到一个**确定的**高度才能算缩放。
    //     min-h-* 下的百分比高度解析成 auto，子元素的 h-full 会量到 0，
    //     contain 模式就永远算不出来。
    //  2. dvh 而不是 vh：手机浏览器的 100vh 不含地址栏，用 vh 底部会被
    //     地址栏切掉一截。这一层是撑开整个布局的那个高度，所以丢的是全页
    //     的高度（画布跟着矮一截），不只是某个面板。
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2 sm:px-4 sm:py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {/* 抽屉开关，只在窄屏出现 —— 宽屏左栏常驻，这个按钮没有意义 */}
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="打开菜单"
            className="rounded-md border border-border p-1.5 text-foreground/80 hover:bg-muted lg:hidden"
          >
            <MenuIcon />
          </button>

          {/* 品牌字标：字号比正文大一档，用品牌蓝而不是前景黑，
              和按钮/选中态同一个强调色，全站只有一个强调色。
              窄屏截断而不是换行：顶栏高度要固定，否则画布高度跟着抖 */}
          <h1 className="truncate text-lg font-semibold tracking-tight text-primary">polysoccer</h1>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setPriceMode(priceMode === 'prob' ? 'odds' : 'prob')}
            className="rounded-md border border-border px-2 py-1 text-[11px] text-foreground/80 hover:bg-muted"
          >
            {PRICE_MODE_LABEL[priceMode]}
          </button>

          {/* 词典入口只在开发时出现。与上面的 lazy 用同一个编译期常量，
              生产构建里这个 && 分支整体被摇掉，不会留下一个点不开的链接。 */}
          {import.meta.env.DEV && (
            <a
              href="#/dict"
              className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
            >
              词典
            </a>
          )}

          <WalletMenu />
        </div>
      </header>

      {/* flex-1 + min-h-0：撑满 header 以下的高度，且允许子元素比内容矮。
          少了 min-h-0，flex 子项的默认 min-height:auto 会被内容顶高，
          高度重新变成不确定的，画布又量不到数。 */}
      {/*
        横排到底，不再按断点切成纵向堆叠：窄屏时左栏是 position:fixed
        （脱离文档流），main 的在流子项就只剩画布一个，它自然拿到整个宽度
        和高度。原来那套「窄屏纵向堆叠 + 画布固定 60dvh」于是整段不需要了 ——
        顺带让手机上的画布从 60dvh 变成整屏。

        也不要 overflow-y-auto：宽屏左栏自己滚，窄屏抽屉自己滚，画布不滚。
        main 只负责把确定的高度传下去。
      */}
      <main className="flex min-h-0 flex-1 overflow-hidden">
        {/* 窄屏抽屉的遮罩。宽屏左栏常驻，既不需要遮罩，也不该挡住画布 */}
        {navOpen && (
          <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setNavOpen(false)} />
        )}

        {/*
          左栏。窄屏是抽屉：fixed 脱离文档流、用负位移藏在屏幕外，开合只改
          transform 和 visibility，不动布局 —— 画布的 ResizeObserver 不会
          因为开合而重算一次缩放。

          宽屏（lg）回到流内常驻：static 一次性让 fixed / max-w / 位移失效。

          藏起来时补一个 invisible，而不是只靠位移：-translate-x-full 只是把
          元素挪出视口，它仍在无障碍树里，键盘 Tab 会跳进一栏看不见的控件。
          visibility 是可过渡的离散属性（变成 visible 立即生效，变成 hidden
          要等过渡走完），所以配 transition-[transform,visibility] 滑动照旧顺。

          DOM 里排在画布前面：宽屏下它就是左栏，读屏和 Tab 顺序都该先到它。
          窄屏它是 fixed，在文档流里的位置不影响显示。
        */}
        <aside
          className={cn(
            'fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] shrink-0 flex-col overflow-y-auto border-r border-border bg-card transition-[transform,visibility] duration-200',
            'lg:static lg:z-auto lg:max-w-none lg:visible lg:translate-x-0',
            navOpen ? 'visible translate-x-0' : 'invisible -translate-x-full',
          )}
        >
          {/* 抽屉盖住了顶栏的品牌，这里补一个，顺带放个关闭按钮 */}
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 lg:hidden">
            <span className="text-base font-semibold tracking-tight text-primary">polysoccer</span>
            <button
              type="button"
              onClick={() => setNavOpen(false)}
              aria-label="关闭菜单"
              className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              ✕
            </button>
          </div>

          {/* 左栏只有比赛列表一件事。标题行是固定的（不折叠）：只有一块内容时
              折叠控件没有意义，而「N 场」这个计数值得一直看得见 */}
          <div className="flex items-baseline justify-between gap-2 border-b border-border px-3 py-2.5">
            <span className="text-xs font-semibold text-foreground">比赛</span>
            <span className="text-[10px] text-muted-foreground">{allMatches.length} 场</span>
          </div>

          <div className="p-3">
            <MatchPicker
              matches={allMatches}
              matchId={matchId}
              positionEventIds={positions.eventIds}
              onPick={(id) => {
                setMatchId(id)
                setSelectedKey(null)
                setPickedKey(null)
                setPickedSideName(null)
                setOrderOpen(false)
                // 窄屏选完就收起抽屉，否则图还压在抽屉后面（宽屏下这句是空操作）
                setNavOpen(false)
              }}
            />
          </div>
        </aside>

        {/* 关系图。m-3 而不是给 main 加 padding：左栏要贴到顶栏和底边
            （border-r 才是一条通到底的分隔线，抽屉盖上顶栏时也才不留缝），
            所以那一圈的间距只能由画布这边让出来 */}
        <section className="m-3 flex min-h-0 min-w-0 flex-1 rounded-lg border border-border bg-card">
          {loading ? (
            <Centered>正在拉取比赛…</Centered>
          ) : error && matches.length === 0 ? (
            <Centered>
              <p className="text-sm text-warning">{error}</p>
              {network && (
                <p className="max-w-md text-center text-[11px] leading-relaxed text-muted-foreground">
                  浏览器连不上 gamma-api.polymarket.com。这个接口 CORS 是全开的，
                  连不上通常是网络层被拦 —— 确认能直接打开 polymarket.com。
                </p>
              )}
              <button
                type="button"
                onClick={reload}
                className="rounded-md border border-border px-2.5 py-1 text-[11px] text-foreground/80 hover:bg-muted"
              >
                重试
              </button>
            </Centered>
          ) : graph ? (
            <MarketGraphCanvas
              graph={graph}
              slots={slots}
              templateEdges={TEMPLATE_EDGES}
              goals={goals}
              priceMode={priceMode}
              prevPrices={prevPrices}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
              positionsByToken={positions.byToken}
              onBuy={(s) => {
                // 点节点永远从槽位自己的那一侧开始；上一次在弹窗里切的侧不带过来
                setPickedKey(s.key)
                setPickedSideName(null)
                setOrderOpen(true)
              }}
            />
          ) : marketsLoading ? (
            <Centered>正在拉取盘口…</Centered>
          ) : marketsError ? (
            <Centered>
              <p className="text-sm text-warning">{marketsError}</p>
              <button
                type="button"
                onClick={reloadMarkets}
                className="rounded-md border border-border px-2.5 py-1 text-[11px] text-foreground/80 hover:bg-muted"
              >
                重试
              </button>
            </Centered>
          ) : (
            <Centered>选一场比赛</Centered>
          )}
        </section>

      </main>

      {/* 下单弹窗。挂在页面根上而不是节点 onClick 那一刻就地展开：
          弹窗要跨「换侧」存活，而 onBuy 只在点击瞬间给得出数据。
          换侧只改 pickedSideName，剩下的（token、报价、tick）都由节点的那一侧重新推出来。 */}
      {orderOpen && picked && pickedNode && pickedSide?.tokenId && graph && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-3 text-sm text-muted-foreground backdrop-blur-sm">
              正在加载下单面板…
            </div>
          }
        >
          <OrderDialog
            tokenId={pickedSide.tokenId}
            sideName={pickedSide.name}
            // 带上侧名：切到 Under 之后光看「总进球 2.5」分不出买的是哪一边
            marketLabel={`${picked.label} · ${pickedSide.name}`}
            marketQuestion={pickedNode.questionZh || pickedNode.questionEn || pickedNode.desc.label}
            eventTitle={graph.title}
            // 按盘口查订单只认 conditionId —— data-api 的 `asset=`（tokenId）参数是
            // 静默忽略的，传了会拿回全部盘口的数据（见 lib/positions.ts 顶部）
            conditionId={pickedNode.conditionId}
            sides={pickedSides}
            onSelectSide={(s) => {
              setPickedSideName(s.name)
              // 让球盘的另一侧在图上也有槽位（主队 -1.5 ↔ 客队 +1.5），
              // 选中跟着挪过去，画布高亮和侧栏才不会还停在原来那侧
              const hit = slots.find((x) => x.tokenId === s.tokenId)
              if (hit) setPickedKey(hit.key)
            }}
            tickByToken={tickByToken}
            quotes={book}
            onClose={() => setOrderOpen(false)}
          />
        </Suspense>
      )}
    </div>
  )
}

/** 顶栏的汉堡图标。三条线而已，用内联 SVG 而不是再装一个图标库 */
function MenuIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
      <path
        d="M2 4.5h12M2 8h12M2 11.5h12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    // 不写 min-h-[70vh]：那会把 section 顶出确定高度，破坏画布的尺寸测量
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
      {children}
    </div>
  )
}

