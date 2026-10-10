import fs from 'node:fs'
import path from 'node:path'
import { state, buildGatewayConfig } from '../lib/state.js'
import { configPath, findService, restartService, startService, stopService } from '../index.js'

/** `ctx.runtime.fetch` hands back a real Response. */
async function readResponse(res) {
  const text = typeof res?.text === 'function' ? await res.text() : String(res?.body ?? '')
  let json = null
  if (text !== '') {
    try { json = JSON.parse(text) } catch { json = null }
  }
  return { status: res?.status ?? 0, json, text }
}

async function serviceCall(ctx, method, servicePath, body) {
  const row = await findService(ctx.runtime)
  const runtimeId = row?.runtimeId ?? state.runtimeId
  if (typeof runtimeId !== 'string' || runtimeId === '') {
    const err = new Error('gateway-not-running')
    err.status = 503
    throw err
  }
  const init = { method, headers: { 'content-type': 'application/json' }, timeoutMs: 20000 }
  if (body !== undefined) init.body = JSON.stringify(body)
  return readResponse(await ctx.runtime.fetch(runtimeId, servicePath, init))
}

export default function register(app, ctx) {
  app.get('/status', async (c) => {
    const cfg = state.config ?? buildGatewayConfig({}, ctx.dataDir ?? '')
    const row = await findService(ctx.runtime).catch(() => null)
    const ready = row?.service?.state === 'ready'
    let health = null
    if (ready) health = (await serviceCall(ctx, 'GET', '/healthz').catch(() => null))?.json ?? null
    // The roster file may live outside this App's permission root, so count it
    // through the service instead of the filesystem.
    let paired = 0
    if (ready) paired = (await serviceCall(ctx, 'GET', '/api/pair/status').catch(() => null))?.json?.devices?.length ?? 0
    return c.json({
      ok: true,
      running: ready,
      service: row?.service ?? null,
      runtime: row === null ? null : {
        runtimeId: row.runtimeId, state: row.state, profile: row.profile,
        enforcement: row.enforcement, network: row.network,
        exitCode: row.exitCode ?? null, logBytes: row.logBytes ?? 0,
      },
      lastStartError: state.lastStartError,
      settings: state.settings ?? {},
      config: cfg,
      gatewayConfigPath: configPath(),
      health,
      paired,
    })
  })

  app.post('/start', async (c) => {
    try {
      const record = await startService(ctx.runtime)
      return c.json({ ok: true, runtimeId: state.runtimeId, record })
    } catch (error) {
      state.lastStartError = error instanceof Error ? error.message : String(error)
      return c.json({ ok: false, error: state.lastStartError }, 500)
    }
  })

  app.post('/stop', async (c) => c.json({ ok: true, stopped: await stopService(ctx.runtime) }))

  app.post('/config', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object') return c.json({ ok: false, error: 'invalid body' }, 400)
    const settings = { ...(state.settings ?? {}), ...body }
    try {
      await ctx.config.setMany(settings)
    } catch (error) {
      return c.json({ ok: false, error: `配置写入宿主失败：${error instanceof Error ? error.message : String(error)}` }, 500)
    }
    try {
      const outcome = await restartService(ctx.runtime, settings)
      return c.json({ ok: outcome.running, running: outcome.running, error: state.lastStartError, config: state.config })
    } catch (error) {
      state.lastStartError = error instanceof Error ? error.message : String(error)
      return c.json({ ok: false, error: state.lastStartError, config: state.config }, 500)
    }
  })

  app.get('/logs', async (c) => {
    try {
      const r = await serviceCall(ctx, 'GET', '/api/pair/logs?limit=200')
      return c.json({ ok: true, text: r.json?.text ?? '' })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error), text: '' }, error?.status ?? 502)
    }
  })

  const forward = (method, servicePath) => async (c) => {
    const body = method === 'GET' ? undefined : await c.req.json().catch(() => undefined)
    try {
      const r = await serviceCall(ctx, method, servicePath, body)
      if (r.json === null) return c.json({ ok: r.status === 200, raw: r.text.slice(0, 400) })
      return c.json(r.json, r.status >= 400 ? r.status : 200)
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, error?.status ?? 502)
    }
  }

  app.get('/pair/status', forward('GET', '/api/pair/status'))
  app.post('/pair/issue', forward('POST', '/api/pair/issue'))
  app.post('/pair/revoke', forward('POST', '/api/pair/revoke'))
  app.post('/pair/cancel', forward('POST', '/api/pair/cancel'))
  app.post('/pair/stop', forward('POST', '/api/pair/stop'))

  app.get('/doctor', async (c) => {
    const cfg = state.config ?? buildGatewayConfig({}, ctx.dataDir ?? '')
    const diag = await serviceCall(ctx, 'GET', '/api/pair/diag').catch(() => null)
    const info = diag?.json?.serverInfo ?? {}
    const checks = [
      { name: '宿主 server-info', ok: Boolean(info.present) && Boolean(info.token), detail: info.present ? `端口 ${String(info.port ?? '?')}；token ${info.token ? '可用' : '不可用'}` : `读不到（${diag === null ? '网关未运行' : 'HanaAgent 是否在运行？'}）` },
      { name: '网关监听', ok: diag?.json?.ok === true, detail: diag?.json?.listening ?? '连不上网关' },
      { name: '宿主可达', ok: diag?.json?.upstreamReachable === true, detail: `宿主 ${String(info.port ?? '?')}，上游配置 ${String(cfg.upstream.port)}，探测 ${String(diag?.json?.upstreamReachable)}` },
      { name: 'HanaAgent 网络模式', ok: info.networkMode === 'lan', detail: `当前 ${String(info.networkMode ?? '?')}；需 lan（允许局域网设备），否则设备会话会被判为 loopback_host_mismatch` },
      { name: '公网地址', ok: Boolean(cfg.publicBaseUrl), detail: cfg.publicBaseUrl ?? '未填写，二维码会退化为内网地址' },
      { name: '允许的 Host', ok: cfg.trustedHosts.length > 0, detail: cfg.trustedHosts.join(', ') || '空' },
      { name: '已配对设备', ok: (diag?.json?.paired ?? 0) > 0, detail: (diag?.json?.paired ?? 0) > 0 ? `${String(diag.json.paired)} 台` : '还没有设备配对，去第 2 步生成二维码' },
    ]
    return c.json({ ok: checks.every(x => x.ok), checks })
  })
}

export { configPath }
