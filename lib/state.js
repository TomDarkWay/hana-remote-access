import path from 'node:path'
/** Shared, in-process state between the app entry and its backend routes. */
export const state = {
  runtimeId: null,
  /** Resolved gateway config last written to <dataDir>/gateway.json. */
  config: null,
  settings: null,
  lastStartError: null,
  /** Verbatim record from ctx.runtime.start, for the settings panel to show. */
  lastRecord: null,
}

export function pickRuntimeId(record) {
  const candidates = [record?.runtimeId, record?.id, record?.runtime?.id, record?.runtime?.runtimeId]
  return candidates.find(v => typeof v === 'string' && v !== '') ?? null
}

/** Prefer the start record; otherwise find this App's ready gateway service. */
export async function resolveRuntimeId(runtime) {
  if (typeof state.runtimeId === 'string' && state.runtimeId !== '') return state.runtimeId
  if (typeof runtime?.list !== 'function') return null
  const listed = await runtime.list()
  const rows = Array.isArray(listed) ? listed : (listed?.runtimes ?? listed?.items ?? [])
  const mine = rows.find(r => (r?.service?.id ?? r?.serviceId ?? r?.id) === 'gateway' && r?.ready !== false) ?? rows[rows.length - 1]
  state.runtimeId = pickRuntimeId(mine)
  return state.runtimeId
}

const DEFAULTS = {
  enabled: true,
  publicBaseUrl: '',
  listen: '0.0.0.0',
  port: 19388,
  upstreamPort: 31787,
  trustedHosts: '',
  pairScopeProfile: 'full',
  landingSurface: 'pad',
  maxDevices: 4,
  dataDir: '',
  logRequests: true,
}

function toInt(value, fallback) {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 && n < 65536 ? n : fallback
}

/** Turn the host's settings values into the gateway's own config document. */
export function buildGatewayConfig(settings, dataDir) {
  const s = { ...DEFAULTS, ...(settings ?? {}) }
  const publicBaseUrl = String(s.publicBaseUrl ?? '').trim()
  const trusted = String(s.trustedHosts ?? '')
    .split(',')
    .map(v => v.trim())
    .filter(v => v !== '')
  if (publicBaseUrl !== '' && !trusted.includes(new URL(publicBaseUrl).hostname)) {
    trusted.push(new URL(publicBaseUrl).hostname)
  }
  return {
    // Kept in the gateway document too: /config uses it to decide whether the
    // managed service should be (re)started.
    enabled: s.enabled !== false,
    listen: String(s.listen ?? '0.0.0.0'),
    port: toInt(s.port, 19388),
    publicBaseUrl: publicBaseUrl === '' ? null : publicBaseUrl,
    trustedHosts: trusted,
    upstream: { addr: '127.0.0.1', port: toInt(s.upstreamPort, 31787) },
    dataDir: String(s.dataDir ?? '').trim() === '' ? dataDir : String(s.dataDir).trim(),
    serverInfo: path.join(process.env.USERPROFILE || process.env.HOME || '', '.hanako', 'server-info.json'),
    panelLoopbackOnly: true,
    pairScopeProfile: s.pairScopeProfile === 'auto' ? 'auto' : 'full',
    landingSurface: ['pad', 'mobile'].includes(s.landingSurface) ? s.landingSurface : 'pad',
    logRequests: s.logRequests !== false,
    rewriteOrigins: true,
    upgradePaths: ['/ws'],
    pairing: { maxDevices: toInt(s.maxDevices, 4) },
    appDataDir: dataDir,
  }
}
