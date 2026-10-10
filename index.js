import fs from 'node:fs'
import path from 'node:path'
import { defineApp } from './sdk/app-contract/server-client.js'
import { state, buildGatewayConfig } from './lib/state.js'

export const name = 'hana-remote-access'

export const READY_MARKER = 'HANA_REMOTE_ACCESS_READY'
export const SERVICE_ID = 'gateway'

export function configPath() {
  return path.join(state.dataDir, 'gateway.json')
}

/** The host's settings form can read back as defaults right after a reload,
 *  before its schema contribution is registered; keep our own last-known copy
 *  in the App data dir and fall back to it for anything the host didn't give. */
function storedSettingsPath() {
  return path.join(state.dataDir, 'settings.json')
}

export function readStoredSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storedSettingsPath(), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function writeConfig(settings) {
  state.settings = { ...(state.settings ?? {}), ...(settings ?? {}) }
  state.config = buildGatewayConfig(state.settings, state.dataDir)
  fs.mkdirSync(state.dataDir, { recursive: true })
  fs.writeFileSync(configPath(), `${JSON.stringify(state.config, null, 2)}\n`)
  fs.writeFileSync(storedSettingsPath(), JSON.stringify(state.settings, null, 2) + String.fromCharCode(10))
  return state.config
}

/** This App's own gateway service row, active or recently terminated. */
export async function findService(runtime) {
  const rows = await runtime.list()
  const mine = rows.filter(r => r?.service?.id === SERVICE_ID)
  // Prefer a live row; a terminal record must not be mistaken for the service.
  const live = mine.filter(r => r.exitCode === undefined && r.signal === undefined && r.endedAt === undefined)
  return live[live.length - 1] ?? null
}

async function waitServiceGone(runtime, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if ((await findService(runtime)) === null) return true
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return false
}

/** Adopt an existing service when there is one, otherwise start it. */
export async function startService(runtime) {
  const existing = await findService(runtime)
  if (existing !== null) {
    state.runtimeId = existing.runtimeId
    state.lastRecord = existing
    state.lastStartError = null
    return existing
  }
  const cfg = state.config
  const record = await runtime.start({
    runtime: 'node',
    profile: 'local-machine',
    network: 'external',
    entry: 'gateway/gw.mjs',
    args: [configPath()],
    service: { id: SERVICE_ID, port: cfg.port, readyMarker: READY_MARKER },
  })
  state.lastRecord = record
  state.runtimeId = record?.runtimeId ?? null
  state.lastStartError = null
  return record
}

export async function stopService(runtime) {
  const row = await findService(runtime)
  const id = row?.runtimeId ?? state.runtimeId
  if (typeof id === 'string' && id !== '') {
    try { await runtime.stop(id) } catch { /* already gone */ }
  }
  state.runtimeId = null
  return waitServiceGone(runtime, 8_000)
}

/** Rewrite config, restart, and wait until the host marks the service ready. */
export async function restartService(runtime, settings) {
  await stopService(runtime)
  writeConfig(settings)
  if (state.config.enabled !== true) return { ok: true, started: false, running: false }
  const record = await startService(runtime)
  let ready = record?.service?.state === 'ready'
  const started = Date.now()
  while (!ready && Date.now() - started < 25_000) {
    const row = await findService(runtime)
    ready = row?.service?.state === 'ready'
    if (row !== null && state.runtimeId === null) state.runtimeId = row.runtimeId
    if (!ready) await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  if (!ready) {
    const row = await findService(runtime)
    state.lastStartError = row === null
      ? '网关服务未能启动（进程已退出，见运行日志）'
      : `网关服务未就绪：${String(row.service?.state ?? row.state)}`
  }
  return { ok: true, started: true, running: ready, record: await findService(runtime) }
}

export default defineApp(async (sdk) => {
  state.dataDir = sdk.dataDir
  await sdk.logger.info('hana-remote-access loading')

  const fromHost = (await sdk.config.getAll?.()) ?? {}
  const stored = readStoredSettings()
  const defined = Object.fromEntries(Object.entries(fromHost).filter(([, v]) => v !== undefined && v !== null && v !== ''))
  writeConfig({ ...stored, ...defined })

  const runtime = sdk.runtime
  if (!runtime || typeof runtime.start !== 'function') {
    state.lastStartError = '宿主没有提供 ctx.runtime，无法托管网关进程'
    await sdk.logger.info(`hana-remote-access: ${state.lastStartError}`)
    return
  }
  if (state.config.enabled !== true) {
    await sdk.logger.info('hana-remote-access: 远程访问未启用，等待用户在设置里开启')
    return
  }
  try {
    const outcome = await restartService(runtime, state.settings)
    await sdk.logger.info(`hana-remote-access: 网关${outcome.running ? '已就绪' : '未就绪'}，端口 ${String(state.config.port)}${state.lastStartError ? ` — ${state.lastStartError}` : ''}`)
  } catch (error) {
    state.lastStartError = error instanceof Error ? error.message : String(error)
    await sdk.logger.info(`hana-remote-access: 网关启动失败 — ${state.lastStartError}`)
  }
})
