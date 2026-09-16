import { ConnectWallet, WalletPanel, Panel } from './components/connect-wallet'

/**
 * 三块布局：关系图（主）+ 钱包 + 订单。
 *
 * 关系图占绝对主位，钱包和订单收在右侧窄栏 —— 这与原型的意图一致：
 * 核心是那张图，交易是图上的动作，不是独立页面。
 */
export default function App() {
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
        <div>
          <h1 className="text-sm font-semibold">盘口网状图</h1>
          <p className="text-[11px] text-neutral-500">
            结构关系与实时价格叠在一张图上，点节点直接下单
          </p>
        </div>
        <ConnectWallet />
      </header>

      <main className="flex gap-3 p-3">
        {/* 左：关系图 */}
        <section className="min-h-[70vh] min-w-0 flex-1 rounded-lg border border-neutral-800 bg-neutral-900/60">
          <div className="flex h-full min-h-[70vh] flex-col items-center justify-center gap-2 text-neutral-500">
            <p className="text-sm">关系图画布</p>
            <p className="max-w-md text-center text-[11px] leading-relaxed">
              下一步：搬 <code className="text-neutral-400">graph.ts</code>（拓扑推导，1197 行纯函数）
              与 <code className="text-neutral-400">template.ts</code>（固定布局），
              数据源接 Gamma API。
            </p>
          </div>
        </section>

        {/* 右：钱包 + 订单 */}
        <aside className="flex w-72 shrink-0 flex-col gap-3">
          <WalletPanel />
          <Panel title="订单">
            <p className="text-xs text-neutral-500">
              连接钱包并下单后显示。订单状态从 CLOB 读，不落本地库。
            </p>
          </Panel>
        </aside>
      </main>
    </div>
  )
}
