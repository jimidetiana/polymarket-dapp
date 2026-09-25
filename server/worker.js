/**
 * Cloudflare Workers 入口 —— builder 归因签名端点。
 *
 * 逻辑全在 sign-core.mjs（Web 标准 handler），这里只做壳：把 Workers 的 (request, env)
 * 转交进去。env 里注入密钥（用 `wrangler secret put` 加密下发，不写进代码/仓库）。
 *
 * 部署：
 *   1. cd server
 *   2. npx wrangler secret put POLYMARKET_BUILDER_API_KEY
 *      npx wrangler secret put POLYMARKET_BUILDER_SECRET
 *      npx wrangler secret put POLYMARKET_BUILDER_PASSPHRASE
 *      （可选）npx wrangler secret put SIGN_ALLOWED_ORIGINS   # 逗号分隔的前端域名
 *   3. npx wrangler deploy
 *   端点 = https://<name>.<subdomain>.workers.dev（把它填进前端 VITE_SIGN_URL_PRIMARY/FALLBACK）
 *
 * 与 Deno Deploy 是**对等双活**：同一份 secret 各配一遍，无主从、无共享状态。
 */
import { handleSignRequest, credsFromEnv, allowedOriginsFromEnv } from './sign-core.mjs'

export default {
  /** @param {Request} request @param {Record<string,string>} env */
  async fetch(request, env) {
    return handleSignRequest(request, credsFromEnv(env), {
      allowedOrigins: allowedOriginsFromEnv(env),
    })
  },
}
