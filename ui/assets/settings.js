import { hana } from './sdk.js'

const $ = id => document.getElementById(id)
const FIELDS = ['publicBaseUrl', 'port', 'listen', 'upstreamPort', 'trustedHosts', 'landingSurface', 'pairScopeProfile', 'maxDevices', 'dataDir']
const BOOLS = ['logRequests', 'enabled']

/** 宿主 iframe 里剪贴板可能被策略挡住：失败就退化为选中文本让人手动复制。 */
async function copyText(value, label) {
  if (!value) { setMsg(`${label}是空的`) ; return }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      setMsg(`${label}已复制`)
      return
    }
    throw new Error('no clipboard api')
  } catch {
    const el = label === '配对链接' ? $('pair-link') : $('pair-token')
    el.focus()
    el.select()
    try { document.execCommand('copy'); setMsg(`${label}已复制`) }
    catch { setMsg(`浏览器不让直接复制：${label}已选中，按 Ctrl+C 即可`, true) }
  }
}

async function api(path, init) {
  const res = await hana.api.fetch(path, init)
  const text = typeof res.text === 'function' ? await res.text() : (typeof res.body === 'string' ? res.body : '')
  try {
    return JSON.parse(text)
  } catch {
    if (res && typeof res.json === 'object' && res.json !== null) return res.json
    throw new Error(`响应不是 JSON（${String(res.status)}）：${text.slice(0, 120)}`)
  }
}

function setMsg(text, bad) {
  const el = $('save-msg')
  el.textContent = text
  el.className = bad ? 'bad' : ''
}

function fill(settings) {
  for (const f of FIELDS) {
    const value = settings[f]
    if ($(f) !== null) $(f).value = value === null || value === undefined ? '' : String(value)
  }
  for (const b of BOOLS) if ($(b) !== null) $(b).checked = settings[b] !== false
}

function collect() {
  const out = {}
  for (const f of FIELDS) {
    const raw = $(f).value
    if (f === 'port' || f === 'upstreamPort' || f === 'maxDevices') out[f] = Number(raw) || undefined
    else out[f] = raw.trim()
  }
  for (const b of BOOLS) out[b] = $(b).checked
  return out
}

function renderRoster(devices) {
  const list = $('roster')
  list.textContent = ''
  if (!Array.isArray(devices) || devices.length === 0) {
    const li = document.createElement('li')
    li.textContent = '还没有已配对设备。生成二维码，用手机浏览器扫一下即可。'
    list.append(li)
    return
  }
  for (const d of devices) {
    const li = document.createElement('li')
    const dot = document.createElement('span')
    dot.className = d.online ? 'dot' : 'dot off'
    const meta = document.createElement('span')
    meta.className = 'meta'
    const title = document.createElement('b')
    title.textContent = d.label || '未命名设备'
    const sub = document.createElement('span')
    sub.textContent = `${d.online ? '在线' : '离线'} · 最近活动 ${new Date(d.lastSeenAt).toLocaleString()} · ${d.deviceId.slice(0, 8)}`
    meta.append(title, sub)
    const btn = document.createElement('button')
    btn.textContent = '取消配对'
    btn.onclick = async () => {
      await api('/pair/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: d.deviceId }) })
      await loadPairing()
    }
    li.append(dot, meta, btn)
    list.append(li)
  }
}

function drawQr(link) {
  const wrap = $('qr-wrap')
  wrap.textContent = ''
  const make = window.qrcode
  if (typeof make !== 'function') {
    const p = document.createElement('p')
    p.className = 'hint'
    p.textContent = '二维码库未加载，请直接复制下面的配对链接。'
    wrap.append(p)
    return
  }
  const qr = make(0, 'M')
  qr.addData(link)
  qr.make()
  wrap.innerHTML = qr.createSvgTag(4, 0)
}

let ttlTimer = null
async function loadPairing() {
  const status = await api('/pair/status')
  const devices = status.devices ?? []
  renderRoster(devices)
  if (status.token && status.url) {
    $('pair-link').value = status.url
    $('pair-token').value = status.token
    drawQr(status.url)
    startTtl(status.expiresAt)
  } else {
    $('pair-link').value = ''
    $('pair-token').value = ''
    $('qr-wrap').textContent = ''
    $('ttl').textContent = '当前没有有效配对令牌，点「生成配对二维码」。'
  }
}

function startTtl(expiresAt) {
  if (ttlTimer !== null) clearInterval(ttlTimer)
  const tick = () => {
    const left = Math.max(0, Math.round((Number(expiresAt) - Date.now()) / 1000))
    $('ttl').textContent = left > 0 ? `令牌有效，剩余 ${String(Math.floor(left / 60))}:${String(left % 60).padStart(2, '0')}` : '令牌已过期，点「换一个令牌」'
  }
  tick()
  ttlTimer = setInterval(tick, 1000)
}

async function issue() {
  const issued = await api('/pair/issue', { method: 'POST' })
  if (issued?.token !== undefined) {
    $('pair-token').value = issued.token
    const link = issued.url ?? `${issued.publicBaseUrl ?? ''}/pair-accept?pair=${issued.token}`
    $('pair-link').value = link
    drawQr(link)
    startTtl(issued.expiresAt)
    setMsg('二维码已生成，有效期内可反复扫描')
  } else {
    setMsg(`生成失败：${JSON.stringify(issued)}`, true)
  }
  await loadPairing()
}

async function refreshStatus() {
  const s = await api('/status')
  fill(s.settings ?? s.config ?? {})
  $('status-line').textContent = s.running
    ? `网关运行中 · http://${s.config.listen}:${s.config.port} · 已配对 ${String(s.paired)} 台 · 公网 ${s.config.publicBaseUrl ?? '未配置'}`
    : `网关未运行${s.lastStartError ? `（${s.lastStartError}）` : ''} · 目标端口 ${String(s.config.port)}`
  $('status-line').style.color = s.running ? '' : '#d13438'
  return s
}

$('save').onclick = async () => {
  setMsg('保存中…')
  try {
    const r = await api('/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(collect()) })
    if (r.ok) { setMsg('已保存并重载'); await refreshStatus(); await loadPairing() } else setMsg(`保存失败：${r.error}`, true)
  } catch (error) { setMsg(String(error.message ?? error), true) }
}
$('start').onclick = async () => { setMsg('启动中…'); const r = await api('/start', { method: 'POST' }); setMsg(r.ok ? '已启动' : `启动失败：${r.error}`, !r.ok); await refreshStatus() }
$('stop').onclick = async () => { const r = await api('/stop', { method: 'POST' }); setMsg(r.ok ? '已停止' : `停止失败：${r.error}`, !r.ok); await refreshStatus() }
$('issue').onclick = () => issue().catch(e => setMsg(String(e.message ?? e), true))
$('refresh').onclick = () => issue().catch(e => setMsg(String(e.message ?? e), true))
$('copy-link').onclick = () => copyText($('pair-link').value, '配对链接')
$('copy-token').onclick = () => copyText($('pair-token').value, '令牌')
$('cancel-token').onclick = async () => { await api('/pair/cancel', { method: 'POST' }); await loadPairing(); setMsg('当前二维码已作废') }
$('unpair-all').onclick = async () => { await api('/pair/stop', { method: 'POST' }); await loadPairing(); await refreshStatus(); setMsg('已解除全部配对') }
$('doctor').onclick = async () => {
  const r = await api('/doctor')
  const list = $('doctor-list')
  list.textContent = ''
  for (const c of r.checks) {
    const li = document.createElement('li')
    li.className = c.ok ? 'ok' : 'bad'
    const b = document.createElement('b')
    b.textContent = c.name
    const note = document.createElement('span')
    note.className = 'note'
    note.textContent = ` — ${c.detail}`
    li.append(b, note)
    list.append(li)
  }
}
$('logs').onclick = async () => { const r = await api('/logs'); $('log-box').textContent = r.text || '（暂无日志）' }

try {
  await hana.ready()
} catch (error) {
  $('status-line').textContent = `宿主桥接未就绪：${error instanceof Error ? error.message : String(error)}（下面按钮可能不可用）`
  $('status-line').style.color = '#d13438'
}
await refreshStatus().catch(error => setMsg(`读取状态失败：${error.message}`, true))
await loadPairing().catch(error => setMsg(`读取名册失败：${error.message}`, true))
$('logs').click()
