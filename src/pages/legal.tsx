/**
 * 法律与身份页面 —— 隐私政策、服务条款、免责声明。
 *
 * ## 为什么这个站必须有这三页
 *
 * 钱包（MetaMask 等）对 dApp 的钓鱼拦截是**域名级**判定，人工审核看的信号是
 * 「这站有没有可核实的真实身份」。一个连隐私政策都没有、页面上找不到主体和
 * 联系方式的钱包站，和钓鱼站的机器特征无法区分 —— 这是被拦的常见原因之一，
 * 不是只有域名的问题。三页合一个路由，内容独立可深链（`#/legal`）。
 *
 * ## 一页三 Tab 而不是三个路由
 *
 * 三份文本都很短，拆三个 hash 路由要多写两处 App.tsx 的分支和两处入口，
 * 收益只是地址栏好看一点。用一个页面 + 内部 Tab，内容照样能整段引用给审核方。
 *
 * ## 文案口径
 *
 * - **不自称「非托管」**：钱在用户自己的钱包/Polymarket 代理钱包里是事实，
 *   但本项目持有 builder 凭据、后端会代发签名，说「非托管」属于过度承诺。
 *   如实写「不持有用户私钥、不代管资金」就够，且每句都站得住。
 * - **地理限制如实写**：本项目对部分地区不开放是真事（Polymarket 是美国受限
 *   产品），写出来既真实也是审核方想看的负责任信号。
 * - **不提「不是赌博」**：预测市场是否构成赌博存在司法辖区差异，本项目无权替
 *   监管下结论。免责声明里说清「自行确认所在地法律」即可，别下断言。
 */
import { useState } from 'react'
import { tr } from '../lib/i18n'
import { BRAND, CONTACT_EMAIL, ENTITY, LEGAL_UPDATED_AT, siteOrigin } from '../lib/site'
import { cn } from '../lib/utils'

type Tab = 'privacy' | 'terms' | 'disclaimer'

const TABS: { key: Tab; zh: string; en: string }[] = [
  { key: 'privacy', zh: '隐私政策', en: 'Privacy' },
  { key: 'terms', zh: '服务条款', en: 'Terms' },
  { key: 'disclaimer', zh: '免责声明', en: 'Disclaimer' },
]

export default function LegalPage() {
  const [tab, setTab] = useState<Tab>('privacy')
  const origin = siteOrigin()

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <a href="#/" className="text-sm text-primary hover:underline">
        {tr('← 返回', '← Back')}
      </a>

      <h1 className="mt-4 text-xl font-semibold text-foreground">
        {tr('法律与免责', 'Legal & Disclaimer')}
      </h1>
      <p className="mt-1 text-xs text-muted-foreground">
        {tr(`最后更新：${LEGAL_UPDATED_AT}`, `Last updated: ${LEGAL_UPDATED_AT}`)}
      </p>

      {/* 身份卡：审核方要在这页一眼看到主体和联系方式 */}
      <dl className="mt-5 space-y-1 rounded-lg border border-border bg-card p-4 text-sm">
        <Row label={tr('站点', 'Site')} value={origin || '—'} />
        {ENTITY && <Row label={tr('运营主体', 'Operated by')} value={ENTITY} />}
        {CONTACT_EMAIL && (
          <Row
            label={tr('联系邮箱', 'Contact')}
            value={<a className="text-primary hover:underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>}
          />
        )}
      </dl>

      <div className="mt-6 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
              tab === t.key
                ? 'border-primary font-medium text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tr(t.zh, t.en)}
          </button>
        ))}
      </div>

      <div className="mt-5 space-y-4 text-sm leading-relaxed text-foreground/90">
        {tab === 'privacy' && <Privacy />}
        {tab === 'terms' && <Terms />}
        {tab === 'disclaimer' && <Disclaimer />}
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all">{value}</dd>
    </div>
  )
}

/** 小标题 */
function H({ zh, en }: { zh: string; en: string }) {
  return <h2 className="pt-2 font-medium text-foreground">{tr(zh, en)}</h2>
}

/** 段落 */
function P({ zh, en }: { zh: string; en: string }) {
  return <p>{tr(zh, en)}</p>
}

function Privacy() {
  return (
    <>
      <P
        zh="本站不设账号体系，不收集姓名、手机号、身份证件等身份信息。你可以不注册直接使用。"
        en="This site has no account system and does not collect your name, phone number, or identity documents. You can use it without registering."
      />

      <H zh="本站会处理的数据" en="Data this site handles" />
      <P
        zh="1. 钱包地址与链上数据（持仓、成交、授权、余额）。这些数据本身公开在 Polygon 区块链上，本站只是读取后展示。读取通过公开的 Polymarket 接口与 Polygon RPC 完成。"
        en="1. Wallet addresses and on-chain data (positions, trades, allowances, balances). This data is already public on the Polygon blockchain; this site only reads and displays it, via public Polymarket APIs and Polygon RPC."
      />
      <P
        zh="2. API 凭据。首次下单时你会在钱包里签名一次，用于派生访问 Polymarket 交易接口所需的凭据。该签名不上链、不消耗 gas。凭据保存在你的浏览器本地（localStorage），用于后续请求签名，本站服务器不留存。"
        en="2. API credentials. On your first order you sign once in your wallet to derive the credentials needed to access Polymarket's trading API. That signature is off-chain and costs no gas. The credentials are stored locally in your browser (localStorage) and are not retained on this site's servers."
      />
      <P
        zh="3. 浏览器本地存储。站点用 localStorage 保存界面偏好（语言、上次查看的盘口等）与上述凭据。这些数据只存在你的设备上，清除浏览器数据即可删除。"
        en="3. Browser local storage. The site uses localStorage for UI preferences (language, last viewed market) and the credentials above. This data lives only on your device; clearing browser data removes it."
      />

      <H zh="本站不做什么" en="What this site does not do" />
      <P
        zh="不收集邮箱、不投放第三方广告、不做跨站跟踪、不向第三方出售或共享你的数据用于营销。"
        en="We do not collect email addresses, do not serve third-party ads, do not track you across sites, and do not sell or share your data for marketing."
      />

      <H zh="托管与日志" en="Hosting and logs" />
      <P
        zh="站点静态资源托管于 Cloudflare，签名服务同样运行在 Cloudflare Workers。按 Cloudflare 的通用做法，其边缘节点会记录请求 IP 与时间戳等访问日志，本站不额外保存这些日志，也不将其与钱包地址关联。"
        en="Static assets are hosted on Cloudflare, and the signing service runs on Cloudflare Workers. As is standard for Cloudflare, its edge records request IPs and timestamps. This site does not retain those logs or link them to wallet addresses."
      />

      <H zh="第三方" en="Third parties" />
      <P
        zh="交易实际发生在 Polymarket 的合约与接口上，本站只是入口。你在 Polymarket 上的数据处理适用其自身的隐私政策。连接钱包时，钱包提供方（如 MetaMask、WalletConnect）亦有其各自的隐私政策。"
        en="Trading itself takes place on Polymarket's contracts and APIs; this site is only an entry point. Data handling on Polymarket is governed by its own privacy policy. Wallet providers (e.g. MetaMask, WalletConnect) have their own policies as well."
      />
    </>
  )
}

function Terms() {
  return (
    <>
      <H zh="服务性质" en="What this service is" />
      <P
        zh={`${BRAND} 是 Polymarket 预测市场的第三方前端界面。本站不是 Polymarket 官方产品，与该平台不存在隶属、代理、背书或合作授权关系。「Polymarket」是其权利人的商标，本站仅在说明所对接服务的必要范围内提及。`}
        en={`${BRAND} is a third-party front end for the Polymarket prediction market. It is not an official Polymarket product and has no affiliation, agency, endorsement, or partnership with that platform. "Polymarket" is a trademark of its owner and is referenced here only as needed to describe the service this site connects to.`}
      />

      <H zh="资金与托管" en="Funds and custody" />
      <P
        zh="本站不持有你的私钥，不代管你的资金，无法动用或转移你的资产。所有交易均由你在钱包中亲自确认后，由 Polymarket 的合约执行。资金存放在你自己的钱包地址或 Polymarket 的代理钱包合约中，本站不提供充值入口，也不提供提现功能 —— 存取款请前往 Polymarket 官方站点操作。"
        en="This site does not hold your private keys, does not custody your funds, and cannot move or transfer your assets. Every transaction is confirmed by you in your wallet and executed by Polymarket's contracts. Funds sit in your own wallet address or in Polymarket's proxy wallet contract. This site offers no deposit or withdrawal function — use the official Polymarket site for those."
      />

      <H zh="你的责任" en="Your responsibility" />
      <P
        zh="你需要自行确认：你所在的国家或地区允许使用预测市场类服务；你的资金来源合法；你已理解所交易标的风险。本站对因此产生的任何后果不承担责任。"
        en="You are responsible for confirming that prediction-market services are permitted where you live, that your funds are lawfully sourced, and that you understand the risks of what you trade. This site accepts no liability for the consequences."
      />

      <H zh="地理限制" en="Geographic restrictions" />
      <P
        zh="本服务不向受限制地区的用户提供，包括但不限于美国及其领土，以及适用法律禁止此类服务的其他司法辖区。若你位于上述地区，请停止使用。"
        en="This service is not offered to users in restricted regions, including but not limited to the United States and its territories, or any other jurisdiction where such services are prohibited. If you are in such a region, please stop using it."
      />

      <H zh="风险提示" en="Risk warning" />
      <P
        zh="预测市场交易存在本金全部损失的风险，且不受任何存款保险或投资者保护机制保障。历史表现不代表未来结果。请只投入你能够承受全部损失的资金。本站不提供投资建议。"
        en="Trading on prediction markets carries the risk of losing your entire principal and is not covered by any deposit insurance or investor protection scheme. Past performance does not indicate future results. Only commit funds you can afford to lose entirely. This site does not provide investment advice."
      />

      <H zh="可用性与变更" en="Availability and changes" />
      <P
        zh="本站按「现状」提供，不保证不间断可用。盘口数据、赔率、费用由第三方接口提供，可能与 Polymarket 官方界面存在时间差或显示差异，最终以链上成交结果为准。本站可随时修改或停止服务，条款更新后以本页为准。"
        en="This site is provided “as is,” with no guarantee of uninterrupted availability. Market data, odds, and fees come from third-party APIs and may lag or differ from Polymarket's official interface; the on-chain execution result is what counts. This site may change or discontinue the service at any time, and this page governs once updated."
      />

      <H zh="费用" en="Fees" />
      <P
        zh="本站通过 Polymarket 的 builder 归因机制获取推荐分成，该分成由平台侧结算，不额外增加你支付的手续费。下单页展示的 Polymarket 手续费与本站费用分列，以页面显示的预估为准，最终以实际成交为准。"
        en="This site earns a referral share through Polymarket's builder attribution mechanism. That share is settled platform-side and does not add to the fees you pay. Polymarket fees and this site's fees are shown separately on the order form; page estimates are indicative, actual execution governs."
      />
    </>
  )
}

function Disclaimer() {
  return (
    <>
      <P
        zh={`${BRAND} 是由第三方独立开发运营的前端工具，与 Polymarket 官方无任何关联。本站不使用 Polymarket 的商标、标识或视觉资产，站内出现的「Polymarket」字样仅用于说明所对接的服务。`}
        en={`${BRAND} is an independently developed third-party front end with no connection to the official Polymarket team. This site does not use Polymarket's trademarks, logos, or visual assets; the word "Polymarket" appears only to describe the service it connects to.`}
      />

      <H zh="数据准确性" en="Data accuracy" />
      <P
        zh="站内所有价格、赔率、预估收益、奖励估算均为展示用途，可能因接口延迟、计算口径差异而与实际不符。任何情况下都以下单回执与链上结算结果为准。"
        en="All prices, odds, projected returns, and reward estimates shown are for display only and may differ from reality due to API latency or differences in calculation. The order receipt and on-chain settlement always govern."
      />

      <H zh="合规自查" en="Verify your own compliance" />
      <P
        zh="不同司法辖区对预测市场的法律定性不同。本站不判断你是否具备使用资格，也不构成任何法律意见。使用前请自行确认所在地法律，并自行承担相应责任。"
        en="The legal treatment of prediction markets differs between jurisdictions. This site does not determine your eligibility and provides no legal advice. Confirm the law where you are before using it, and bear the consequences yourself."
      />

      <H zh="安全提示" en="Security notes" />
      <P
        zh={`本站永远不会索要你的助记词或私钥，也不会要求你导出钱包。任何人以「${BRAND} 客服」名义向你索要这些信息，都是诈骗。请核对浏览器地址栏域名确为本站，勿从他人转发的链接进入。`}
        en={`This site will never ask for your seed phrase or private key, and will never ask you to export your wallet. Anyone requesting those while claiming to be ${BRAND} support is a scammer. Check that the address bar shows this site's domain, and do not enter via links forwarded by others.`}
      />

      {CONTACT_EMAIL && (
        <>
          <H zh="联系" en="Contact" />
          <P
            zh={`对本站内容有疑问或需要举报冒用本站名义的站点，请邮件联系 ${CONTACT_EMAIL}。`}
            en={`For questions about this site, or to report a site impersonating it, email ${CONTACT_EMAIL}.`}
          />
        </>
      )}
    </>
  )
}
