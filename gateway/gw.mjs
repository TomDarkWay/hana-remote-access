#!/usr/bin/env node
/**
 * hana-remote-gw — a pairing-gated public gateway in front of the local
 * HanaAgent (Hanako) server.
 *
 *   browser --https--> NAS --http--> this gateway --http(loopback)--> Hanako
 *
 * The gateway owns the public trust decision (one-time pairing token, device
 * roster, revocation). Its upstream leg always presents a genuine loopback
 * socket with the loopback Host, which is how Hanako classifies a request as
 * local transport; the owner bearer token from server-info.json is attached
 * server-side and never reaches the browser. Hanako itself keeps listening on
 * 127.0.0.1 and is never reconfigured.
 */

import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PairingService } from './pairing.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MAX_REWRITE_BYTES = 2 * 1024 * 1024

// ── config ────────────────────────────────────────────────────────────────
function loadConfig() {
  // When Hana hosts this gateway as a managed runtime service, the App entry
  // passes the config path as argv[2]; env/legacy paths stay for manual runs.
  const file = process.argv[2] || process.env.HANA_GW_CONFIG || path.join(HERE, 'config.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const dataDir = raw.dataDir ?? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'hana-remote-gw')
  return {
    // `listen` and `upstream.addr` are named apart on purpose: an earlier
    // config.json had two identical "host" keys and the wrong one got edited.
    listen: raw.listen ?? '127.0.0.1',
    port: raw.port ?? 19388,
    dataDir,
    devicesFile: raw.devicesFile ?? path.join(dataDir, 'devices.json'),
    upstream: {
      addr: raw.upstream?.addr ?? '127.0.0.1',
      port: raw.upstream?.port ?? 31787,
      publicHost: raw.upstream?.publicHost,
    },
    serverInfo: raw.serverInfo ?? path.join(os.homedir(), '.hanako', 'server-info.json'),
    publicBaseUrl: raw.publicBaseUrl ?? null,
    trustedHosts: Array.isArray(raw.trustedHosts) ? raw.trustedHosts : [],
    pairing: raw.pairing ?? {},
    panelLoopbackOnly: raw.panelLoopbackOnly !== false,
    pairScopeProfile: raw.pairScopeProfile ?? 'auto',
    // Hanako's /mobile/ client cannot create a session (it never marks the input
    // draft owner verified), and its /pad/ gate requires tools.run + plugins.use,
    // which a paired device credential can never hold. So phones land on /pad/ and
    // sign in once with the local account. Set "auto" to restore UA-based routing.
    landingSurface: raw.landingSurface ?? 'pad',
    upgradePaths: Array.isArray(raw.upgradePaths) ? raw.upgradePaths : ['/ws'],
    rewriteOrigins: raw.rewriteOrigins !== false,
    logRequests: raw.logRequests === true,
  }
}

const config = loadConfig()

// The App's settings panel reads this tail; keep stdout for the host's ready
// marker and put the same lines in a bounded file inside the data directory.
const requestLogFile = path.join(config.dataDir, 'gateway.log')
const NL = String.fromCharCode(10)
const originalLog = console.log.bind(console)
const originalWarn = console.warn.bind(console)
function tee(file, line) {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true })
    fs.appendFileSync(file, `${line}${NL}`)
    if (fs.statSync(file).size > 262144) {
      const tail = fs.readFileSync(file, 'utf8').split(NL).slice(-400).join(NL)
      fs.writeFileSync(file, `${tail}${NL}`)
    }
  } catch {}
}
console.log = (...args) => { originalLog(...args); tee(requestLogFile, args.join(' ')) }
console.warn = (...args) => { originalWarn(...args); tee(requestLogFile, args.join(' ')) }

// The whole trust model rests on the upstream leg being a genuine loopback
// socket presenting a loopback Host, which is how Hanako classifies it as
// local transport. A non-loopback upstream would 403 with
// loopback_host_mismatch, so refuse to start rather than fail mysteriously.
if (!isLoopbackAddress(config.upstream.addr)) {
  console.error(`hana-remote-gw: upstream.addr 必须是回环地址（当前是 ${config.upstream.addr}）。`)
  console.error('  它不是对外监听的开关——要放开监听请改顶层的 "listen"。')
  process.exit(1)
}

// A second instance would fight the first over devices.json. Deliberately NOT a
// lock file: Windows recycles PIDs, so a stale lock whose number got reused made
// every restart refuse to start and the supervisor loop livelocked. Ask instead
// whether something already answers as this gateway on this port.
const alreadyServing = await new Promise((resolve) => {
  const probe = http.get({ host: '127.0.0.1', port: config.port, path: '/healthz', timeout: 1_500 }, (res) => {
    res.resume()
    resolve(res.statusCode === 200)
  })
  probe.on('error', () => resolve(false))
  probe.on('timeout', () => {
    probe.destroy()
    resolve(false)
  })
})
if (alreadyServing) {
  console.error(`hana-remote-gw: 端口 ${String(config.port)} 上已有一个网关在正常服务，拒绝重复启动。`)
  console.error('  要先停掉它：powershell "Get-CimInstance Win32_Process -Filter \"Name=\\\'node.exe\\\'\" | ? CommandLine -match gw.mjs | % { Stop-Process -Id $_.ProcessId -Force }"')
  process.exit(1)
}

// ── upstream owner token ──────────────────────────────────────────────────
const owner = {
  token: null,
  port: config.upstream.port,
  read() {
    try {
      const info = JSON.parse(fs.readFileSync(config.serverInfo, 'utf8'))
      if (typeof info.token === 'string' && info.token.length > 0) this.token = info.token
      if (Number.isFinite(info.port)) this.port = info.port
      return true
    } catch {
      return false
    }
  },
  invalidate() {
    this.token = null
    this.read()
  },
}
owner.read()
try {
  fs.watch(config.serverInfo, { persistent: false }, () => {
    // HanaAgent restarts rotate the token and may move port; pick both up.
    setTimeout(() => owner.read(), 250)
  })
} catch {}

const upstreamBase = () => `http://${config.upstream.addr}:${String(owner.port)}`

/** Host value the proxied browser leg presents: a LAN-facing address, so Hanako
 *  classifies the request as LAN transport and honours device-credential sessions. */
const frontHost = () => config.upstream.publicHost ?? lanBases()[0]?.address ?? config.upstream.addr

// ── pairing service ───────────────────────────────────────────────────────
const service = new PairingService(config.pairing, {
  file: config.devicesFile,
  publicBaseUrl: config.publicBaseUrl ?? undefined,
})

function lanBases() {
  // The link a phone opens must point at *this* gateway, not at Hanako's own
  // port - the upstream port only belongs to the proxied leg.
  const port = config.port
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      // Skip the TUN/CGNAT adapter (198.18.0.0/15) - it is not a LAN face.
      if (entry.address.startsWith('198.18.')) continue
      out.push({ address: entry.address, base: `http://${entry.address}:${String(port)}`, name })
    }
  }
  return out
}

function refreshBases() {
  service.setLanBases(lanBases())
}
refreshBases()
setInterval(refreshBases, 30_000).unref()
setInterval(() => service.sweep(), 10_000).unref()

// ── host / transport predicates ───────────────────────────────────────────
/** Strip a trailing :port and lowercase, mirroring Hanako's own normalization. */
function normalizeHost(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === '') return ''
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    return end >= 0 ? raw.slice(0, end + 1) : raw
  }
  const last = raw.lastIndexOf(':')
  return last > -1 && raw.indexOf(':') === last ? raw.slice(0, last) : raw
}

function isLoopbackAddress(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === 'localhost' || raw === '::1' || raw === '[::1]') return true
  const mapped = raw.startsWith('::ffff:') ? raw.slice(7) : raw
  return /^127(?:\.\d{1,3}){3}$/.test(mapped)
}

function isLoopbackRequest(req) {
  return isLoopbackAddress(req.socket?.remoteAddress)
}

/** Host authorities this gateway answers on: public base + trusted + LAN faces. */
function trustedHostSet() {
  const set = new Set()
  if (config.publicBaseUrl) {
    try {
      set.add(normalizeHost(new URL(config.publicBaseUrl).host))
    } catch {}
  }
  for (const entry of config.trustedHosts) set.add(normalizeHost(entry))
  for (const entry of lanBases()) set.add(normalizeHost(entry.address))
  set.delete('')
  return set
}

function hostAllowed(req) {
  const host = normalizeHost(req.headers.host)
  if (host === '') return false
  if (isLoopbackAddress(host) || host === 'localhost') return true
  return trustedHostSet().has(host)
}

function readCookie(req, name) {
  const header = req.headers.cookie
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      return undefined
    }
  }
  return undefined
}

/** The device credential a request presents: cookie, header, or query. */
function deviceIdOf(req) {
  const name = service.config.cookieName
  return readCookie(req, name)
    ?? (typeof req.headers['x-hana-remote-device'] === 'string' ? req.headers['x-hana-remote-device'] : undefined)
    ?? (reqUrl(req).searchParams.get('device') ?? undefined)
}

function isPaired(req) {
  const deviceId = deviceIdOf(req)
  if (deviceId === undefined || !service.hasDevice(deviceId)) return false
  service.touch(deviceId)
  return true
}

function reqUrl(req) {
  try {
    return new URL(req.url ?? '/', 'http://placeholder')
  } catch {
    return new URL('/', 'http://placeholder')
  }
}

function transportSecure(req) {
  if (req.socket?.encrypted === true) return true
  // The NAS terminates TLS and stamps X-Forwarded-Proto; used ONLY to decide
  // this gateway's own cookie flag, never as an authorization input.
  return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https'
}

// ── tiny response helpers ─────────────────────────────────────────────────
function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function html(res, status, body, extraHeaders) {
  const text = body
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(text)
}

const PAGE_STYLE = 'font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;background:#14100e;color:#f2e9e1;'
  + 'max-width:34rem;margin:0 auto;padding:2rem 1.25rem;'
  + 'a{color:#e8a33d} .box{background:#1d1815;border:1px solid #3a2f28;border-radius:12px;padding:1rem 1.15rem;margin:.9rem 0}'
  + 'input{width:100%;padding:.6rem .7rem;border-radius:8px;border:1px solid #4a3c33;background:#120f0d;color:#f2e9e1;font:inherit}'
  + 'button{margin-top:.8rem;padding:.55rem 1.1rem;border-radius:8px;border:1px solid #e8a33d;background:#e8a33d;color:#1a1310;font:inherit;font-weight:600;cursor:pointer}'
  + 'small{color:#a89689}'

function shellPage(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">`
    + `<title>${title}</title><style>${PAGE_STYLE}</style></head><body>${body}</body></html>`
}

// ── pairing pages ─────────────────────────────────────────────────────────
/** Where a freshly paired device lands: phones get /mobile, the rest /pad. */
function nextTarget(req, requested) {
  const next = typeof requested === 'string' && requested.startsWith('/') && !requested.startsWith('//') ? requested : undefined
  if (next !== undefined) return next
  if (config.landingSurface === 'mobile') return '/mobile'
  if (config.landingSurface === 'pad') return '/pad'
  const ua = String(req.headers['user-agent'] ?? '')
  return /iPhone|iPad|iPod|Android|Mobile/i.test(ua) ? '/mobile' : '/pad'
}

function acceptPage(token, next) {
  return shellPage('配对中…', `<h2>正在完成配对</h2><div class="box" id="m">请稍候…</div>
<small>本页会把这台设备登记到 HanaAgent 的远程访问名册。</small>
<script>
(async () => {
  const m = document.getElementById('m')
  try {
    const r = await fetch('/api/pair/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: ${JSON.stringify(token)} }),
    })
    const j = await r.json()
    if (!j.ok) {
      m.textContent = '配对失败：' + (j.code === 'expired' ? '链接或令牌已过期，请在电脑上重新生成二维码'
        : j.code === 'device-limit' ? '名册已满，请先在面板里移除一台设备' : j.code)
      return
    }
    history.replaceState(null, '', '/')
    location.replace(${JSON.stringify(next)})
  } catch (e) {
    m.textContent = '配对失败：' + e.message
  }
})()
</script>`)
}

function manualPairPage() {
  return shellPage('设备配对', `<h2>输入配对令牌</h2>
<div class="box"><p>在电脑的远程访问面板里点“复制令牌”，粘贴到这里。</p>
<input id="t" placeholder="配对令牌" autocomplete="off" autocapitalize="none" spellcheck="false">
<button id="b">配对</button></div>
<script>
document.getElementById('b').onclick = async () => {
  const token = document.getElementById('t').value.trim()
  const r = await fetch('/api/pair/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
  const j = await r.json()
  if (j.ok) location.replace(j.redirect ?? '/')
  else alert('配对失败：' + (j.code ?? 'unknown'))
}
</script>`)
}

function blockedPage() {
  return shellPage('未配对设备', `<h2>这台设备尚未配对</h2>
<div class="box"><p>请在运行 HanaAgent 的电脑上打开「远程访问」面板，扫码或把配对链接粘贴到本浏览器。</p>
<p><a href="/pair">已有配对令牌？在这里输入 →</a></p></div>
<small>网关只接受名册内设备的请求；停止或吊销会立即生效。</small>`)
}

// ── upstream proxy ────────────────────────────────────────────────────────
const PASS_REQUEST_HEADERS = ['content-type', 'content-length', 'accept', 'accept-language', 'range', 'if-none-match', 'if-modified-since']
const DROP_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-security-policy'])
const REWRITABLE = /text\/html|application\/javascript|text\/javascript|application\/manifest\+json|application\/json/

/**
 * Hanako decides the `Secure` cookie flag from `socket.encrypted` only, and it
 * has no X-Forwarded-Proto support — behind a TLS-terminating NAS it always
 * sees plaintext, so its session cookie would ship without `Secure`. Add the
 * flag whenever the browser really did arrive over https.
 */
function hardenCookies(value, req) {
  const list = Array.isArray(value) ? value : [value]
  if (!transportSecure(req)) return list
  return list.map(cookie => /;\s*secure/i.test(cookie) ? cookie : `${cookie}; Secure`)
}

function upstreamHeaders(req) {
  const browserCookie = typeof req.headers.cookie === 'string' ? req.headers.cookie : ''
  // Two auth paths need two different Host values, and this is the one that
  // serves browsers: Hanako accepts a device-credential session only when the
  // request classifies as LAN (trustState "lan" ⇒ connectionKind "lan"), so the
  // proxied leg presents a live interface address. The loopback Host is kept for
  // the gateway's own owner-token bootstrap calls, which need "local".
  const headers = {
    host: `${frontHost()}:${String(owner.port)}`,
    'accept-encoding': 'identity',
    'sec-fetch-site': 'same-origin',
  }
  if (browserCookie !== '') headers.cookie = browserCookie
  for (const name of PASS_REQUEST_HEADERS) {
    const value = req.headers[name]
    if (typeof value === 'string') headers[name] = value
  }
  const deviceId = deviceIdOf(req)
  if (deviceId !== undefined) headers['x-hana-remote-device'] = deviceId
  return headers
}

function rewriteText(text, req) {
  if (!config.rewriteOrigins) return text
  const inner = upstreamBase()
  const outer = config.publicBaseUrl ?? `http://${req.headers.host ?? `${config.upstream.addr}:${String(owner.port)}`}`
  if (text.includes(inner)) return text.split(inner).join(outer)
  return text
}

function proxyHttp(req, res, innerPath) {
  if (owner.token === null) owner.read()
  if (owner.token === null) {
    json(res, 503, { ok: false, code: 'owner-token-unavailable', detail: `读不到 ${config.serverInfo}；HanaAgent 是否在运行？` })
    return
  }
  const upstream = http.request(
    { host: config.upstream.addr, port: owner.port, path: innerPath, method: req.method, headers: upstreamHeaders(req) },
    (upstreamRes) => {
      if (upstreamRes.statusCode === 401) owner.invalidate()
      if (config.logRequests && !/^\/(assets|lib|modules|icons)\//.test(innerPath)) {
        console.log(`[req] ${String(req.method)} ${innerPath.split('?')[0]} → ${String(upstreamRes.statusCode)}`)
      }
      const contentType = String(upstreamRes.headers['content-type'] ?? '')
      const out = {}
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (DROP_RESPONSE_HEADERS.has(name.toLowerCase())) continue
        if (value !== undefined) out[name] = value
      }
      const cookies = upstreamRes.headers['set-cookie']
      if (cookies !== undefined) out['set-cookie'] = hardenCookies(cookies, req)
      const location = upstreamRes.headers.location
      if (typeof location === 'string' && /^https?:\/\//i.test(location)) {
        out.location = rewriteText(location, req)
      }
      const canRewrite = REWRITABLE.test(contentType) && !canRewriteBody(out)
      if (!canRewrite) {
        res.writeHead(upstreamRes.statusCode ?? 502, out)
        upstreamRes.pipe(res)
        upstreamRes.on('error', () => res.destroy())
        res.on('close', () => {
          if (!upstreamRes.readableEnded) upstream.destroy()
        })
        return
      }
      // Buffer the small text bodies that may carry the inner absolute origin.
      const chunks = []
      let total = 0
      let aborted = false
      upstreamRes.on('data', (chunk) => {
        total += chunk.length
        if (total > MAX_REWRITE_BYTES) {
          aborted = true
          return
        }
        chunks.push(chunk)
      })
      upstreamRes.on('end', () => {
        if (aborted) {
          res.writeHead(upstreamRes.statusCode ?? 502, out)
          for (const chunk of chunks) res.write(chunk)
          res.end()
          return
        }
        const body = rewriteText(Buffer.concat(chunks).toString('utf8'), req)
        const headers = { ...out }
        delete headers['content-length']
        headers['content-length'] = Buffer.byteLength(body)
        res.writeHead(upstreamRes.statusCode ?? 502, headers)
        res.end(body)
      })
      upstreamRes.on('error', () => res.destroy())
    },
  )
  upstream.on('error', () => {
    if (!res.headersSent) {
      json(res, 502, { ok: false, code: 'upstream-unreachable', detail: `${config.upstream.addr}:${String(owner.port)} 连不上` })
      return
    }
    res.destroy()
  })
  req.on('error', () => upstream.destroy())
  req.pipe(upstream)
}

/** A body that must not be buffered (ranged media, explicit streaming). */
function canRewriteBody(headers) {
  return headers['content-range'] !== undefined || headers['content-disposition'] !== undefined
}

function proxyUpgrade(req, socket, head, innerPath) {
  if (owner.token === null) owner.read()
  const lines = [
    `GET ${innerPath} HTTP/1.1`,
    `Host: ${frontHost()}:${String(owner.port)}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
  ]
  // 与真实浏览器直连 Hanako 时一致：升级请求带会话 cookie，不带 owner token。
  // owner token 只在回环传输上有效，而这里的 Host 是 LAN 值，带上反而会被判
  // loopback_token_requires_local_transport。
  if (typeof req.headers.cookie === 'string' && req.headers.cookie !== '') {
    lines.push(`Cookie: ${req.headers.cookie}`)
  }
  for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol']) {
    const value = req.headers[name]
    if (value !== undefined) lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
  }
  const upstream = net.connect(owner.port, config.upstream.addr)
  // 这个超时只覆盖握手阶段。socket.setTimeout 计的是「连续无活动」，若一直挂着，
  // 空闲的 WebSocket 会被每 10 秒掐死一次，客户端就陷入无限重连。
  const handshakeTimer = setTimeout(() => upstream.destroy(), 10_000)
  const clearHandshakeTimer = () => clearTimeout(handshakeTimer)
  upstream.once('close', clearHandshakeTimer)
  upstream.once('error', clearHandshakeTimer)
  const tearDown = () => {
    upstream.destroy()
    socket.destroy()
  }
  upstream.on('error', tearDown)
  socket.on('error', tearDown)
  upstream.on('close', () => socket.destroy())
  socket.on('close', () => upstream.destroy())
  upstream.on('connect', () => {
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) upstream.write(head)
    // 拿到 101（第一个回包）就说明隧道成立了，此后不再有任何空闲超时
    upstream.prependOnceListener('data', (chunk) => {
      clearHandshakeTimer()
      if (config.logRequests) {
        console.log(`[ws] ${innerPath.split('?')[0]} → ${String(chunk.toString('latin1').split('\r\n')[0] ?? '').slice(0, 40)}`)
      }
    })
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
}

// ── static panel assets ───────────────────────────────────────────────────
const WEB_MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }

function serveWeb(res, name) {
  const file = path.join(HERE, 'web', name)
  if (!file.startsWith(path.join(HERE, 'web')) || !fs.existsSync(file)) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const body = fs.readFileSync(file)
  res.writeHead(200, {
    'content-type': WEB_MIME[path.extname(file)] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * One-shot upstream call used by the pairing bootstrap. Returns the parsed body
 * plus any Set-Cookie headers so the caller can hand a session to the browser.
 */
function upstreamRequest(method, urlPath, body) {
  return new Promise((resolve) => {
    if (owner.token === null) owner.read()
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request({
      host: config.upstream.addr,
      port: owner.port,
      path: urlPath,
      method,
      headers: {
        host: `${config.upstream.addr}:${String(owner.port)}`,
        authorization: owner.token === null ? '' : `Bearer ${owner.token}`,
        'accept-encoding': 'identity',
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }),
      },
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        cookies: res.headers['set-cookie'] ?? [],
        json: (() => {
          try {
            return JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            return null
          }
        })(),
      }))
    })
    req.on('error', () => resolve({ status: 0, cookies: [], json: null }))
    req.end(payload)
  })
}

/**
 * Turn a freshly paired device into a logged-in one, so scanning the QR is all
 * it takes (the DSH behaviour). Mints a Hanako mobile key with the owner token,
 * redeems it for a session cookie, and remembers the credential id so that
 * unpairing revokes both sides. A failure here degrades to "pair now, log in
 * once by hand" rather than blocking the pairing.
 * @returns {Promise<string[]>} Set-Cookie headers to pass to the browser
 */
/**
 * 1.0.6 deletes `server-info.json` when HanaAgent shuts down, so a gateway that
 * starts first has neither a token nor an upstream to talk to. Poll until both are
 * back rather than pairing a device that then has to sign in by hand.
 */
async function waitForUpstream(attempts, delayMs) {
  for (let i = 0; i < attempts; i += 1) {
    owner.invalidate()
    if (owner.token !== null) {
      const probe = await upstreamRequest('GET', '/api/health')
      if (probe.status === 200) return true
    }
    if (i + 1 < attempts) await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  return false
}

async function bootstrapSession(deviceId, label, kind = 'mobile') {
  if (!await waitForUpstream(3, 1_500)) {
    console.warn('hana-remote-gw: HanaAgent 未就绪（缺 owner token 或 31787 不可达），该设备需手动登录一次')
    return []
  }
  const minted = await upstreamRequest('POST', `/api/access/${kind}-credentials`, {
    displayName: `远程配对 · ${label}`,
  })
  const secret = minted.json?.secret
  const credentialId = minted.json?.credential?.credentialId
  if (typeof secret !== 'string' || secret === '') {
    console.warn(`hana-remote-gw: 铸${kind === 'desktop' ? '桌面' : '移动'}端访问钥匙失败（HTTP ${String(minted.status)}），该设备需手动登录一次`)
    return []
  }
  const login = await upstreamRequest('POST', '/api/web-auth/login', { credential: secret })
  if (login.status !== 200 || login.cookies.length === 0) {
    console.warn(`hana-remote-gw: 用访问钥匙换取会话失败（HTTP ${String(login.status)}），该设备需手动登录一次`)
    return []
  }
  if (typeof credentialId === 'string') service.attachCredential(deviceId, credentialId)
  return login.cookies
}

/** Best-effort revoke of the Hanako-side credentials behind a pairing. */
async function revokeCredentials(credentialIds) {
  for (const credentialId of credentialIds) {
    const r = await upstreamRequest('POST', `/api/devices/credentials/${encodeURIComponent(credentialId)}/revoke`)
    if (r.status !== 200) console.warn(`hana-remote-gw: 吊销宿主凭证 ${credentialId} 未成功（HTTP ${String(r.status)}），请到 HanaAgent 的访问面板手动清理`)
  }
}

// ── router ────────────────────────────────────────────────────────────────
async function readBody(req, maxBytes = 65536) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function requireLoopback(req, res) {
  if (!config.panelLoopbackOnly || isLoopbackRequest(req)) return true
  json(res, 403, { ok: false, code: 'panel-loopback-only', detail: '配对面板仅限本机使用' })
  return false
}

function setPairCookie(res, deviceId, req) {
  const maxAge = Math.floor(service.config.idleExpireMs / 1000)
  res.setHeader('set-cookie', `${service.config.cookieName}=${encodeURIComponent(deviceId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(maxAge)}${transportSecure(req) ? '; Secure' : ''}`)
}

const server = http.createServer(async (req, res) => {
  const url = reqUrl(req)
  const path = url.pathname
  try {
    // ── control surface (this machine only) ──
    if (path === '/healthz') {
      if (!requireLoopback(req, res)) return
      // HanaAgent deletes server-info.json on shutdown and rewrites it on start,
      // and a delete/recreate pair does not reliably reach a path watcher, so a
      // still-missing token is worth one more read on every probe.
      if (owner.token === null) owner.read()
      json(res, 200, {
        ok: true,
        gateway: { host: config.listen, port: config.port },
        upstream: upstreamBase(),
        ownerTokenLoaded: owner.token !== null,
        publicBaseUrl: config.publicBaseUrl ?? null,
        devices: service.snapshot().devices.length,
      })
      return
    }
    if (path === '/api/pair/logs') {
      if (!requireLoopback(req, res)) return
      const limit = Math.min(400, Math.max(1, Number(url.searchParams.get('limit') ?? 200) || 200))
      // requestLogFile is module scope: inside the router the identifier `path`
      // is the request pathname, so never rebuild the path here.
      let text = ''
      try {
        text = fs.readFileSync(requestLogFile, 'utf8').split(NL).filter(l => l !== '').slice(-limit).join(NL)
      } catch { text = '' }
      json(res, 200, { ok: true, text })
      return
    }
    if (path === '/api/pair/diag') {
      if (!requireLoopback(req, res)) return
      // Runs inside the gateway process (no sandbox), so it can see what the
      // AppHost child cannot: the host's discovery file and the upstream port.
      const info = (() => {
        try {
          const parsed = JSON.parse(fs.readFileSync(config.serverInfo, 'utf8'))
          return { present: true, port: Number.isSafeInteger(parsed.port) ? parsed.port : null, token: typeof parsed.token === 'string' && parsed.token.length > 0, networkMode: parsed.networkMode ?? null }
        } catch { return { present: false } }
      })()
      const upstreamOk = await new Promise((resolve) => {
        // Any HTTP answer proves the port is the host; /api/health itself 401/403
        // without a credential, so do not treat that as "unreachable".
        const probe = http.get({ host: config.upstream.addr, port: info.port ?? config.upstream.port, path: '/api/health', timeout: 3000, headers: { host: `${String(config.upstream.addr)}:${String(info.port ?? config.upstream.port)}` } }, (res) => { res.resume(); resolve(res.statusCode < 500) })
        probe.on('error', () => resolve(false))
        probe.on('timeout', () => { probe.destroy(); resolve(false) })
      })
      json(res, 200, { ok: true, serverInfo: info, upstreamReachable: upstreamOk, listening: `${String(config.listen)}:${String(config.port)}`, paired: service.snapshot().devices.length })
      return
    }
    if (path === '/panel' || path === '/panel/') return void (requireLoopback(req, res) && serveWeb(res, 'panel.html'))
    if (path === '/panel.js') return void (requireLoopback(req, res) && serveWeb(res, 'panel.js'))
    if (path === '/qr.js') return void serveWeb(res, 'qr.js')
    if (path === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }

    if (path === '/api/pair/issue' || path === '/api/pair/refresh') {
      if (!requireLoopback(req, res)) return
      const address = url.searchParams.get('address') ?? undefined
      const issued = service.issue(address)
      json(res, 200, { ok: true, ...issued, lanAddresses: service.lanAddresses, publicBaseUrl: config.publicBaseUrl ?? null })
      return
    }
    if (path === '/api/pair/cancel') {
      if (!requireLoopback(req, res)) return
      json(res, 200, { ok: true, cancelled: service.cancelToken() })
      return
    }
    if (path === '/api/pair/stop') {
      if (!requireLoopback(req, res)) return
      const doomed = service.credentialIds()
      service.stop()
      // Awaited on purpose: a fire-and-forget revoke used to die with the
      // process, leaving live Hanako credentials behind an unpaired device.
      if (doomed.length > 0) await revokeCredentials(doomed)
      json(res, 200, { ok: true, revokedCredentials: doomed.length })
      return
    }
    if (path === '/api/pair/revoke') {
      if (!requireLoopback(req, res)) return
      let deviceId
      try {
        deviceId = JSON.parse(await readBody(req)).deviceId
      } catch {
        deviceId = undefined
      }
      const doomed = service.credentialOf(deviceId)
      const revoked = typeof deviceId === 'string' && service.revoke(deviceId)
      if (revoked && doomed !== undefined) await revokeCredentials([doomed])
      json(res, 200, { ok: revoked })
      return
    }
    if (path === '/api/pair/status') {
      if (!isLoopbackRequest(req) && !hostAllowed(req) && !isPaired(req)) return void json(res, 403, { ok: false, code: 'forbidden' })
      json(res, 200, service.snapshot())
      return
    }
    if (path === '/api/pair/events') {
      if (!requireLoopback(req, res)) return
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(`data: ${JSON.stringify(service.snapshot())}\n\n`)
      const off = service.onState(snapshot => res.write(`data: ${JSON.stringify(snapshot)}\n\n`))
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
      req.on('close', () => {
        clearInterval(ping)
        off()
      })
      return
    }

    // ── device-facing pairing (public origins allowed) ──
    if (path === '/pair-accept') {
      const token = url.searchParams.get('pair') ?? ''
      if (!hostAllowed(req)) return void html(res, 403, shellPage('不可用', '<h2>不可用</h2><div class="box">该地址未被网关信任。</div>'))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(acceptPage(token, nextTarget(req, url.searchParams.get('next'))))
      return
    }
    if (path === '/pair') return void html(res, 200, manualPairPage())
    if (path === '/api/pair/accept') {
      if (!hostAllowed(req)) return void json(res, 403, { ok: false, code: 'forbidden' })
      let payload
      try {
        payload = JSON.parse(await readBody(req))
      } catch {
        return void json(res, 400, { ok: false, code: 'bad-payload' })
      }
      const result = service.accept(String(payload?.token ?? ''), req.headers['user-agent'])
      if (!result.ok) return void json(res, 404, { ok: false, code: result.code })
      setPairCookie(res, result.deviceId, req)
      // 扫码即登录：顺手把 Hanako 的会话 cookie 也交给浏览器（DSH 的同款语义）。
      // 凭证种类决定权限面：Hanako 把 mobile 钥匙硬上限在 chat/files，desktop 钥匙
      // 才带 studio.owner/settings.*，也就是 DSH 的「配对即全控」。可用
      // pairScopeProfile:"full" 强制全控。
      const label = service.snapshot().devices.find(d => d.deviceId === result.deviceId)?.label ?? '设备'
      const ua = String(req.headers['user-agent'] ?? '')
      const wantsFull = config.pairScopeProfile === 'full'
      const kind = wantsFull || !/iPhone|iPad|iPod|Android|Mobile/i.test(ua) ? 'desktop' : 'mobile'
      for (const cookie of hardenCookies(await bootstrapSession(result.deviceId, label, kind), req)) res.appendHeader('set-cookie', cookie)
      json(res, 200, { ok: true, redirect: nextTarget(req, payload?.next) })
      return
    }
    if (path === '/api/pair/heartbeat') {
      const deviceId = deviceIdOf(req)
      json(res, 200, { ok: deviceId !== undefined && service.heartbeat(deviceId) })
      return
    }

    // ── everything else rides the pairing gate ──
    if (!hostAllowed(req)) {
      html(res, 403, shellPage('不可用', '<h2>不可用</h2><div class="box">这个地址没有被网关信任（检查 publicBaseUrl / trustedHosts）。</div>'))
      return
    }
    if (!isPaired(req)) {
      const acceptsHtml = String(req.headers.accept ?? '').includes('text/html')
      if (acceptsHtml && !path.startsWith('/api/')) return void html(res, 401, blockedPage())
      json(res, 401, { ok: false, code: 'unpaired', detail: '在电脑上打开远程访问面板完成配对' })
      return
    }
    // Hanako's own root sends browsers to /mobile/, which cannot create a
    // session. A bookmarked or re-opened pairing link should land on the
    // configured surface instead.
    if (path === '/' && config.landingSurface !== 'auto'
      && String(req.headers.accept ?? '').includes('text/html')) {
      res.writeHead(302, { location: `/${config.landingSurface}/`, 'cache-control': 'no-store' })
      res.end()
      return
    }
    proxyHttp(req, res, `${path}${url.search}`)
  } catch (error) {
    console.error(`hana-remote-gw: 请求处理异常 ${path} (${error instanceof Error ? error.stack ?? error.message : String(error)})`)
    if (!res.headersSent) json(res, 500, { ok: false, code: 'gateway-error' })
    else res.destroy()
  }
})

server.on('upgrade', (req, socket, head) => {
  const url = reqUrl(req)
  const path = url.pathname
  if (!config.upgradePaths.includes(path)) {
    if (config.logRequests) console.log(`[ws] 拒绝未登记路径 ${path}`)
    socket.destroy()
    return
  }
  if (!hostAllowed(req) || !isPaired(req)) {
    if (config.logRequests) console.log(`[ws] 拒绝 ${path}：host=${String(req.headers.host)} paired=${String(isPaired(req))}`)
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  proxyUpgrade(req, socket, head, `${path}${url.search}`)
})

server.listen(config.port, config.listen, () => {
  const snapshot = service.snapshot()
  console.log(`hana-remote-gw: 监听 http://${config.listen}:${String(config.port)} → 回环上游 ${upstreamBase()}`)
  console.log('HANA_REMOTE_ACCESS_READY')
  console.log(`hana-remote-gw: owner token ${owner.token === null ? '未加载' : '已加载'}；公网 origin ${config.publicBaseUrl ?? '(未配置)'}`)
  console.log(`hana-remote-gw: 面板 http://127.0.0.1:${String(config.port)}/panel  名册设备 ${String(snapshot.devices.length)} 台`)
  if (config.publicBaseUrl === null) console.warn('hana-remote-gw: 警告 — publicBaseUrl 未填，二维码只能指向局域网地址')
})

server.on('error', (error) => {
  console.error(`hana-remote-gw: 启动失败 ${error.code ?? ''} ${error.message}`)
  process.exitCode = 1
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`hana-remote-gw: 收到 ${signal}，关闭中`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3_000).unref()
  })
}
