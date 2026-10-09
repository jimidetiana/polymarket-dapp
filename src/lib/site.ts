/**
 * 站点自报身份 —— 单一事实源。
 *
 * ## 为什么要有这个文件
 *
 * 钱包（MetaMask 等）对 dApp 的钓鱼判定是**域名级**的，人工审核看的是
 * 「这个站有没有可核实的真实身份」。换域名只是第一步，域名换了但页面上
 * 找不到主体信息、找不到联系方式，照样过不了。
 *
 * 所以这些东西必须集中且显眼：品牌名、主体、联系方式、隐私/条款入口、
 * 以及「与 Polymarket 无隶属关系」的声明。
 *
 * ## 注意：这里写的每一项都会展示给用户和审核方
 *
 * `entity` / `contactEmail` 之类留空时，页面会隐藏对应行而不是显示空格子。
 * 但**别用假信息占位** —— 无效联系信息比没有更糟，审核会直接判为钓鱼特征。
 * 填不出真实主体的，就让它空着，等有了再补。
 */

/** 品牌名。同时被 index.html 的 <title>、PWA manifest 引用，改这里即可（但 html 里那份是手写的，要同步改）。 */
export const BRAND = 'PolySoccer'

/**
 * 站点正式地址。**换域名时只改这一处**（连同 index.html 的 canonical）。
 *
 * 留空则回落到 `window.location.origin`：本地开发、预览部署都会自动用当前地址，
 * 不会把生产域名印到开发环境的页脚上。
 *
 * 之所以不用 `import.meta.env.VITE_SITE_URL`：换域名是个低频动作，却要同时改
 * Cloudflare 变量 + 重新构建，多一个必填的构建期变量只增加「忘了配」的失败面；
 * 而这里硬编码一个常量，改一行、构建、发布，链路最短。要注入再改这里。
 */
export const SITE_URL = ''

/**
 * 运营主体 —— 自然人姓名或公司全称都行，写**能对得上**的那个。
 * 例：'张三' 或 'XX 科技有限公司'
 */
export const ENTITY = ''

/** 联系邮箱。要真实可达（审核方可能真的发信）。 */
export const CONTACT_EMAIL = ''

/**
 * 生效/更新日期，显示在隐私政策与条款页顶部。
 * 改了内容就顺手改这里。
 */
export const LEGAL_UPDATED_AT = '2026-10-08'

/**
 * 站点根地址（带协议，不带尾斜杠）。
 *
 * 服务端渲染 / 测试环境下 `window` 不存在时，回落到 SITE_URL；两个都没有时
 * 返回空串，调用方自己决定怎么处理（导出图片里印空串即可，不该崩）。
 */
export function siteOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin
  return SITE_URL.replace(/\/+$/, '')
}

/**
 * 页脚/水印用的展示地址（带尾斜杠，好看一点）。
 */
export function siteDisplayUrl(): string {
  const o = siteOrigin()
  return o ? `${o}/` : ''
}

/**
 * 联系方式是否已经填了真实值。全部为空时页脚不显示「联系」那一行。
 */
export function hasContact(): boolean {
  return Boolean(ENTITY || CONTACT_EMAIL)
}
