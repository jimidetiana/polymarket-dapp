/**
 * Deno Deploy 入口 —— builder 归因签名端点。
 *
 * 逻辑全在 sign-core.mjs（Web 标准 handler），这里只做壳：Deno.serve 把每个请求转交进去。
 * 密钥从环境变量读（Deno Deploy 面板里配 Environment Variables）。
 *
 * 部署（两种任选）：
 *   A. 面板 GitHub 集成：入口文件选 server/deno.ts，配好三件套环境变量即可。
 *   B. CLI：deno install -gArf jsr:@deno/deployctl
 *      deployctl deploy --entrypoint=server/deno.ts \
 *        --env=POLYMARKET_BUILDER_API_KEY=... --env=POLYMARKET_BUILDER_SECRET=... \
 *        --env=POLYMARKET_BUILDER_PASSPHRASE=...   # 生产建议用面板配密钥而非命令行
 *   端点 = https://<project>.deno.dev（把它填进前端另一个 VITE_SIGN_URL_* 槽位）
 *
 * 与 Cloudflare Workers 是**对等双活**：同一份 secret 各配一遍，无主从、无共享状态。
 * 注：.mjs 里用的都是全局 Web API（crypto.subtle / atob / btoa / Request / Response），
 * Deno 原生支持，无需 node 兼容层。
 */
// @ts-ignore -- Deno 全局在本仓库的 tsconfig 里没有类型；运行时由 Deno 提供
import { handleSignRequest, credsFromEnv, allowedOriginsFromEnv } from './sign-core.mjs'

// @ts-ignore -- Deno 全局
const env = Deno.env.toObject()
const creds = credsFromEnv(env)
const opts = { allowedOrigins: allowedOriginsFromEnv(env) }

// @ts-ignore -- Deno 全局
Deno.serve((request: Request) => handleSignRequest(request, creds, opts))
