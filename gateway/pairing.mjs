/**
 * Pairing engine for hana-remote-gw.
 *
 * Semantics (single active expiring token, per-device sessions, revocable
 * roster, 0600 JSON persistence) follow @linxin666/dsh-remote-web-ui's
 * src/pairing.ts (Apache-2.0), reimplemented compactly against plain Node so
 * the gateway carries no runtime dependency and no cordis coupling.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

export const DEFAULTS = {
  /** Lifetime of one pairing token/link. */
  tokenTtlMs: 10 * 60 * 1000,
  /** A device counts as online while lastSeenAt is newer than this. */
  offlineAfterMs: 25_000,
  /** Hard cap on paired devices; the oldest session is evicted when full. */
  maxDevices: 4,
  /** Sessions idle past this are deleted. */
  idleExpireMs: 30 * 24 * 60 * 60 * 1000,
  /** Cookie carrying the paired device id. */
  cookieName: 'hana_pair',
}

/** Throttle for the lastSeenAt-driven persist, in sweeps. */
const PERSIST_EVERY_MS = 60_000

function hex32() {
  return randomBytes(16).toString('hex')
}

/**
 * Turn a raw User-Agent into a short human label for the roster.
 * @param {string | undefined} raw
 * @returns {string | undefined}
 */
export function deviceLabel(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const ua = raw.slice(0, 256)
  const iOS = /iPhone|iPad|iPod/i.test(ua)
  const android = /Android/i.test(ua)
  if (iOS) return /iPad/i.test(ua) ? 'iPad' : 'iPhone'
  if (android) return 'Android 设备'
  if (/Windows NT/i.test(ua)) return 'Windows 电脑'
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS 电脑'
  if (/Linux/i.test(ua)) return 'Linux 电脑'
  return '未知设备'
}

export class PairingService {
  /** @type {Record<string, any>} */
  #config
  #file
  #devices = new Map()
  /** @type {{ token: string, expiresAt: number } | undefined} */
  #active
  #lanBases = []
  #publicBaseUrl
  #lastPersistedAt = 0
  #dirty = false
  #listeners = new Set()

  /**
   * @param {Partial<typeof DEFAULTS>} config
   * @param {{ file?: string, publicBaseUrl?: string }} options
   */
  constructor(config = {}, options = {}) {
    this.#config = { ...DEFAULTS, ...config }
    this.#file = options.file
    this.#publicBaseUrl = options.publicBaseUrl
    if (this.#file) this.#load()
  }

  get config() {
    return this.#config
  }

  set config(next) {
    this.#config = { ...this.#config, ...next }
  }

  setPublicBaseUrl(url) {
    this.#publicBaseUrl = url
  }

  get publicBaseUrl() {
    return this.#publicBaseUrl
  }

  /** @param {{address:string, base:string}[]} entries */
  setLanBases(entries) {
    this.#lanBases = entries
  }

  get lanAddresses() {
    return this.#lanBases.map(entry => entry.address)
  }

  /** The default base a link is built from: public first, else first LAN. */
  get defaultBase() {
    return this.#publicBaseUrl ?? this.#lanBases[0]?.base
  }

  baseFor(address) {
    if (address === undefined) return this.defaultBase
    return this.#lanBases.find(entry => entry.address === address)?.base
  }

  #load() {
    try {
      const saved = JSON.parse(readFileSync(this.#file, 'utf8'))
      const now = Date.now()
      for (const [deviceId, session] of Object.entries(saved)) {
        if (typeof deviceId !== 'string' || session === null || typeof session !== 'object') continue
        const { createdAt, lastSeenAt, userAgent, credentialId } = session
        if (typeof createdAt !== 'number' || typeof lastSeenAt !== 'number') continue
        this.#devices.set(deviceId, {
          createdAt,
          lastSeenAt,
          ...(typeof userAgent === 'string' ? { userAgent } : {}),
          ...(typeof credentialId === 'string' ? { credentialId } : {}),
        })
      }
      this.#evictIdle(now)
      void now
    } catch {
      // A missing or corrupt store is simply an empty roster.
    }
  }

  #persist() {
    if (!this.#file) return
    const payload = {}
    for (const [deviceId, session] of this.#devices) payload[deviceId] = session
    const temp = `${this.#file}.tmp-${process.pid}`
    try {
      mkdirSync(dirname(this.#file), { recursive: true })
      writeFileSync(temp, JSON.stringify(payload), { mode: 0o600 })
      renameSync(temp, this.#file)
      this.#dirty = false
      this.#lastPersistedAt = Date.now()
    } catch (error) {
      try {
        rmSync(temp, { force: true })
      } catch {}
      console.error(`hana-remote-gw: 设备名册写入失败 (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  #evictIdle(now) {
    let removed = false
    for (const [deviceId, session] of this.#devices) {
      if (now - session.lastSeenAt > this.#config.idleExpireMs) {
        this.#devices.delete(deviceId)
        removed = true
      }
    }
    return removed
  }

  /**
   * Mint (or re-mint) the one active pairing token.
   * @param {string} [address] - a LAN address whose base the link should use.
   * @returns {{ token: string, expiresAt: number, url: string | undefined }}
   */
  issue(address) {
    const now = Date.now()
    const token = hex32()
    const expiresAt = now + this.#config.tokenTtlMs
    this.#active = { token, expiresAt }
    const base = this.baseFor(address)
    const url = base === undefined ? undefined : `${base}/pair-accept?pair=${token}`
    this.#emit()
    return { token, expiresAt, ...(url !== undefined ? { url } : {}) }
  }

  /**
   * Redeem a token into a device session.
   * @param {string} token
   * @param {string} [userAgent]
   * @returns {{ ok: true, deviceId: string } | { ok: false, code: string }}
   */
  accept(token, userAgent) {
    const now = Date.now()
    const active = this.#active
    if (active === undefined) return { ok: false, code: 'no-token' }
    if (typeof token !== 'string' || token === '' || token !== active.token) {
      return { ok: false, code: token === '' || typeof token !== 'string' ? 'bad-payload' : 'expired' }
    }
    if (now > active.expiresAt) return { ok: false, code: 'expired' }
    const deviceId = hex32()
    const label = deviceLabel(userAgent)
    // The link stays usable inside its window so several devices can pair off
    // one QR, each getting its own session. Refuse when the roster is full:
    // evicting the oldest used to silently disconnect a real device whenever
    // another pairing came in over the cap.
    if (this.#devices.size >= this.#config.maxDevices) return { ok: false, code: 'device-limit' }
    this.#devices.set(deviceId, {
      createdAt: now,
      lastSeenAt: now,
      ...(label !== undefined ? { userAgent: label } : {}),
    })
    this.#persist()
    this.#emit()
    return { ok: true, deviceId }
  }

  /** Drop the active pairing token without touching the roster. */
  cancelToken() {
    const had = this.#active !== undefined
    this.#active = undefined
    this.#persist()
    this.#emit()
    return had
  }

  /** Revoke every device and drop the active token. */
  stop() {
    this.#active = undefined
    this.#devices.clear()
    this.#persist()
    this.#emit()
  }

  revoke(deviceId) {
    if (!this.#devices.delete(deviceId)) return false
    this.#persist()
    this.#emit()
    return true
  }

  hasDevice(deviceId) {
    const session = this.#devices.get(deviceId)
    if (session === undefined) return false
    return Date.now() - session.lastSeenAt <= this.#config.idleExpireMs
  }

  /** Refresh a session's lastSeenAt; throttled persist, sweep() flushes. */
  touch(deviceId) {
    const session = this.#devices.get(deviceId)
    if (session === undefined) return false
    session.lastSeenAt = Date.now()
    this.#dirty = true
    return true
  }

  heartbeat(deviceId) {
    return this.touch(deviceId)
  }

  /** Drop idle-expired sessions and flush a dirty roster. */
  sweep() {
    const now = Date.now()
    const removed = this.#evictIdle(now)
    if (removed) this.#persist()
    else if (this.#dirty && now - this.#lastPersistedAt > PERSIST_EVERY_MS) this.#persist()
    if (removed) this.#emit()
  }

  /**
   * The panel's view of the world.
   * @returns {Record<string, unknown>}
   */
  snapshot() {
    const now = Date.now()
    const active = this.#active
    const devices = [...this.#devices.entries()]
      .map(([deviceId, session]) => ({
        deviceId,
        label: session.userAgent ?? '未知设备',
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        online: now - session.lastSeenAt <= this.#config.offlineAfterMs,
      }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    return {
      ok: true,
      phase: active === undefined ? 'idle' : devices.length > 0 ? 'paired' : 'waiting',
      publicBaseUrl: this.#publicBaseUrl ?? null,
      lanAddresses: this.#lanBases.map(entry => entry.address),
      token: active !== undefined && active.expiresAt > now ? active.token : null,
      expiresAt: active?.expiresAt ?? null,
      url: active !== undefined && active.expiresAt > now && this.defaultBase !== undefined
        ? `${this.defaultBase}/pair-accept?pair=${active.token}`
        : null,
      devices,
      config: {
        tokenTtlMs: this.#config.tokenTtlMs,
        maxDevices: this.#config.maxDevices,
        offlineAfterMs: this.#config.offlineAfterMs,
        cookieName: this.#config.cookieName,
      },
    }
  }

  /**
   * Remember which Hanako device credential backs a paired device, so that
   * unpairing can revoke both sides (the gateway gate and Hanako's own ledger).
   * @param {string} deviceId
   * @param {string} credentialId
   */
  attachCredential(deviceId, credentialId) {
    const session = this.#devices.get(deviceId)
    if (session === undefined || typeof credentialId !== 'string') return
    session.credentialId = credentialId
    this.#persist()
  }

  /** @param {string} deviceId @returns {string | undefined} */
  credentialOf(deviceId) {
    return this.#devices.get(deviceId)?.credentialId
  }

  /** Ids of every currently paired device's Hanako credential. */
  credentialIds() {
    return [...this.#devices.values()].map(s => s.credentialId).filter(id => typeof id === 'string')
  }

  onState(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #emit() {
    const snapshot = this.snapshot()
    for (const listener of this.#listeners) {
      try {
        listener(snapshot)
      } catch {}
    }
  }
}
