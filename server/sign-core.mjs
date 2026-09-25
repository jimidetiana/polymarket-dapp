/**
 * 薄后端的**平台无关核心**：一个 Web 标准 handler，`(Request, creds, opts) => Response`。
 *
 * 三个入口壳都调它，逻辑只此一份：
 *   - server/sign-server.mjs  本地开发（node:http 适配到 Web 请求/响应）
 *   - server/worker.js        Cloudflare Workers（export default { fetch }）
 *   - server/deno.ts          Deno Deploy（Deno.serve）
 *
 * 只用 Web 标准 API（Request/Response、Web Crypto 的 crypto.subtle、atob/btoa），
 * 所以 Workers / Deno / Node18+ 都能原样跑，零 npm 依赖。
 *
 * 端点语义与原实现一致：POST {method, path, body} -> 用 builder secret 算 HMAC，
 * 返回四个头值。secret 只在这里参与计算，绝不出现在响应里。
 */

// base64 -> 字节。secret 是 base64；真实 builder secret 常是 **url-safe**（含 - _、可能无填充），
// 而 atob 只认标准 base64 —— 先归一（- ->+、_ ->/、补齐 =）再 atob，与 node 的
// Buffer.from(secret,'base64') 及 SDK 的 buildHmacSignature 结果一致。
function base64ToBytes(b64) {
  let s = b64.replace(/-/g, '+').replace(/_/g, '/')
  const pad = s.length % 4
  if (pad) s += '='.repeat(4 - pad)
  const bin = atob(s)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// 字节 -> base64
function bytesToBase64(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

/**
 * Polymarket 规范的 builder HMAC（与 @polymarket/client 的 buildHmacSignature 同式）：
 * message = timestamp + method + requestPath + body；secret 为 base64；SHA-256 结果转
 * base64 后再 url-safe（'+'→'-'、'/'→'_'，保留 '='）。用 Web Crypto 实现，全平台通用。
 */
async function buildHmacSignature(secret, timestamp, method, requestPath, body) {
  const message = `${timestamp}${method}${requestPath}${body ?? ''}`
  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  const b64 = bytesToBase64(new Uint8Array(sigBuf))
  return b64.split('+').join('-').split('/').join('_')
}

/**
 * 解析 Origin 白名单：allowedOrigins 为空 -> 允许所有('*')。配了白名单时：
 *   - 带 Origin 且在名单 -> 回显该 Origin（放行）
 *   - 带 Origin 但不在名单 -> null（拒绝，浏览器跨站滥用挡在这）
 *   - 无 Origin（非浏览器/服务端调用）-> '*'（Origin 白名单只拦浏览器）
 * 注意：这是"减速带"不是"墙"——curl 能伪造 Origin。风险边界仅为 builder 归因，
 * 见 WALLET-HANDOFF / 部署说明。
 */
function resolveAllowedOrigin(request, allowedOrigins) {
  if (!allowedOrigins || allowedOrigins.length === 0) return '*'
  const origin = request.headers.get('Origin')
  if (!origin) return '*'
  return allowedOrigins.includes(origin) ? origin : null
}

function corsHeaders(allowOrigin) {
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function json(status, obj, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

/**
 * @param {Request} request
 * @param {{key?:string, secret?:string, passphrase?:string}} creds
 * @param {{allowedOrigins?: string[]}} [opts]
 * @returns {Promise<Response>}
 */
export async function handleSignRequest(request, creds, opts = {}) {
  const allowOrigin = resolveAllowedOrigin(request, opts.allowedOrigins)
  // Origin 不在白名单：预检和实请求都拒
  if (allowOrigin === null) return json(403, { error: 'origin not allowed' }, {})

  const cors = corsHeaders(allowOrigin)

  // CORS 预检：也用作探活（前端 resolveSigningUrl 会 OPTIONS 探测，不消耗签名）
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors })
  }
  if (request.method !== 'POST') {
    return json(404, { error: 'not found' }, cors)
  }
  if (!creds.key || !creds.secret || !creds.passphrase) {
    return json(
      500,
      { error: 'Builder credentials not configured (set POLYMARKET_BUILDER_API_KEY/SECRET/PASSPHRASE)' },
      cors,
    )
  }

  let payload
  try {
    const raw = await request.text()
    payload = raw ? JSON.parse(raw) : {}
  } catch {
    return json(400, { error: 'invalid JSON body' }, cors)
  }

  const { method, path, body } = payload
  // body 可选：鉴权/查挂单这类 GET 没 body（v2 SDK 发 body:undefined）。只有 method/path 必需。
  if (!method || !path) {
    return json(400, { error: 'Missing required parameters: method, path' }, cors)
  }

  try {
    const timestamp = Date.now().toString()
    const signature = await buildHmacSignature(creds.secret, timestamp, method, path, body)
    return json(
      200,
      {
        POLY_BUILDER_SIGNATURE: signature,
        POLY_BUILDER_TIMESTAMP: timestamp,
        POLY_BUILDER_API_KEY: creds.key,
        POLY_BUILDER_PASSPHRASE: creds.passphrase,
      },
      cors,
    )
  } catch (e) {
    console.error('[sign-core] error:', e)
    return json(500, { error: 'Failed to sign message' }, cors)
  }
}

/** 从环境变量对象取三件套凭据（Workers 的 env / Deno.env / process.env 通用形态）。*/
export function credsFromEnv(env) {
  return {
    key: env.POLYMARKET_BUILDER_API_KEY,
    secret: env.POLYMARKET_BUILDER_SECRET,
    passphrase: env.POLYMARKET_BUILDER_PASSPHRASE,
  }
}

/** 解析逗号分隔的 Origin 白名单（SIGN_ALLOWED_ORIGINS）。留空 -> undefined（允许所有）。*/
export function allowedOriginsFromEnv(env) {
  const raw = (env.SIGN_ALLOWED_ORIGINS || '').trim()
  if (!raw) return undefined
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}
