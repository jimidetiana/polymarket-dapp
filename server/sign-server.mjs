/**
 * 本地开发用的薄后端 —— builder 归因签名端点。
 *
 * 逻辑已抽到平台无关的 `sign-core.mjs`（Web 标准 handler）；生产走 Workers（worker.js）
 * 或 Deno Deploy（deno.ts）。这个文件只是给**本地开发**用的 node:http 壳：把 node 的
 * 请求/响应适配成 Web 的 Request/Response，转交给同一个 core，保证三处逻辑不分叉。
 *
 * 运行：`node server/sign-server.mjs`（默认 8787 端口）。开发期 vite 把 /api 代理到这里
 * （见 vite.config.ts）。密钥从环境变量读：
 *   POLYMARKET_BUILDER_API_KEY / POLYMARKET_BUILDER_SECRET / POLYMARKET_BUILDER_PASSPHRASE
 *   （可选）SIGN_ALLOWED_ORIGINS —— 逗号分隔的 Origin 白名单
 *
 * Node 18+ 全局已带 Request/Response/crypto.subtle/atob/btoa，core 直接可用，零依赖。
 */
import http from 'node:http'
import { handleSignRequest, credsFromEnv, allowedOriginsFromEnv } from './sign-core.mjs'

const PORT = Number(process.env.SIGN_SERVER_PORT || 8787)
const creds = credsFromEnv(process.env)
const opts = { allowedOrigins: allowedOriginsFromEnv(process.env) }

/** node IncomingMessage -> Web Request（先把 body 读成字符串，避免流的 duplex 麻烦）。*/
function toWebRequest(req, rawBody) {
  const url = `http://localhost:${PORT}${req.url || '/'}`
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((one) => headers.append(k, one))
    else if (v != null) headers.set(k, v)
  }
  const method = req.method || 'GET'
  const hasBody = method !== 'GET' && method !== 'HEAD' && rawBody.length > 0
  return new Request(url, { method, headers, body: hasBody ? rawBody : undefined })
}

/** Web Response 写回 node ServerResponse。*/
async function writeWebResponse(res, webRes) {
  const buf = Buffer.from(await webRes.arrayBuffer())
  const headers = {}
  webRes.headers.forEach((v, k) => {
    headers[k] = v
  })
  res.writeHead(webRes.status, headers)
  res.end(buf)
}

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => {
    raw += c
    if (raw.length > 1_000_000) {
      res.writeHead(413, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'body too large' }))
      req.destroy()
    }
  })
  req.on('end', async () => {
    try {
      const webReq = toWebRequest(req, raw)
      const webRes = await handleSignRequest(webReq, creds, opts)
      await writeWebResponse(res, webRes)
    } catch (e) {
      console.error('[sign-server] error:', e)
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Failed to sign message' }))
    }
  })
  req.on('error', (e) => console.error('[sign-server] req error:', e))
})

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `[sign-server] 端口 ${PORT} 已被占用 —— 多半是上一个 sign-server 还开着。\n` +
        `  关掉那个窗口，或在 .env 里改 SIGN_SERVER_PORT 换个端口（记得 vite proxy 目标要一致）。\n` +
        `  Windows 查占用：netstat -ano | findstr :${PORT}，再 taskkill /F /PID <PID>。`,
    )
  } else {
    console.error('[sign-server] 启动失败：', err)
  }
  process.exit(1)
})

server.listen(PORT, () => {
  console.log(`[sign-server] listening on http://localhost:${PORT}/api/polymarket/sign`)
  if (!creds.key || !creds.secret || !creds.passphrase) {
    console.warn('[sign-server] ⚠️ builder 密钥未配置：设置 POLYMARKET_BUILDER_API_KEY / POLYMARKET_BUILDER_SECRET / POLYMARKET_BUILDER_PASSPHRASE 后重启。')
  }
})
