/* 远程访问面板逻辑（仅本机访问）。 */
const $ = (id) => document.getElementById(id)
let status = null
let selected = 'public'
let lastUrl = null

async function api(path, init) {
  const res = await fetch(path, init)
  return await res.json()
}

function toast(text) {
  const el = $('toast')
  el.textContent = text
  el.classList.add('show')
  setTimeout(() => el.classList.remove('show'), 1600)
}

async function copy(text, label) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const el = document.createElement('textarea')
    el.value = text
    document.body.appendChild(el)
    el.select()
    document.execCommand('copy')
    el.remove()
  }
  toast(`${label}已复制`)
}

function svgFor(text) {
  const qr = window.qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true })
}

function renderNets() {
  const box = $('nets')
  const options = []
  if (status.publicBaseUrl) options.push({ id: 'public', label: '公网地址', value: status.publicBaseUrl })
  for (const address of status.lanAddresses ?? []) options.push({ id: address, label: '局域网', value: address })
  if (!options.some(o => o.id === selected)) selected = options[0]?.id ?? 'public'
  box.innerHTML = ''
  if (options.length === 0) {
    box.innerHTML = '<span class="empty">没有可用网络地址（config.publicBaseUrl 未填且未检测到局域网网卡）</span>'
    return
  }
  for (const option of options) {
    const label = document.createElement('label')
    const input = document.createElement('input')
    input.type = 'radio'
    input.name = 'net'
    input.checked = option.id === selected
    input.onchange = async () => {
      selected = option.id
      await issue()
    }
    label.appendChild(input)
    const strong = document.createElement('span')
    strong.textContent = option.label
    const code = document.createElement('code')
    code.textContent = option.value
    label.appendChild(strong)
    label.appendChild(document.createTextNode(' '))
    label.appendChild(code)
    box.appendChild(label)
  }
}

function renderDevices() {
  const list = $('devices')
  const devices = status.devices ?? []
  if (devices.length === 0) {
    list.innerHTML = '<li class="empty">还没有已配对的设备。扫码或打开链接后会出现在这里。</li>'
    return
  }
  list.innerHTML = ''
  for (const device of devices) {
    const li = document.createElement('li')
    const left = document.createElement('span')
    const ago = Math.max(0, Math.round((Date.now() - device.lastSeenAt) / 1000))
    left.innerHTML = `<i class="dot ${device.online ? 'on' : ''}"></i>${escapeHtml(device.label)}`
      + ` <span class="meta">${device.online ? '在线' : `最后活动 ${humanAgo(ago)}`}</span>`
    const button = document.createElement('button')
    button.textContent = '取消配对'
    button.onclick = async () => {
      await api('/api/pair/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: device.deviceId }) })
      toast('已取消该设备')
      await poll()
    }
    li.appendChild(left)
    li.appendChild(button)
    list.appendChild(li)
  }
}

function humanAgo(seconds) {
  if (seconds < 60) return `${String(seconds)} 秒前`
  if (seconds < 3600) return `${String(Math.round(seconds / 60))} 分钟前`
  if (seconds < 86400) return `${String(Math.round(seconds / 3600))} 小时前`
  return `${String(Math.round(seconds / 86400))} 天前`
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

function render() {
  const hasPublic = Boolean(status.publicBaseUrl)
  $('mode-badge').innerHTML = hasPublic
    ? `<i class="dot on"></i>公网`
    : `<i class="dot warn"></i>仅局域网`
  const paired = (status.devices ?? []).some(d => d.online)
  $('state-badge').innerHTML = status.phase === 'idle'
    ? `<i class="dot"></i>未生成配对链接`
    : paired
      ? `<i class="dot on"></i>已连接`
      : `<i class="dot"></i>等待设备连接`

  $('link').value = status.url ?? ''
  $('token').value = status.token ?? ''
  if (status.url && status.url !== lastUrl) {
    lastUrl = status.url
    $('qr').innerHTML = svgFor(status.url)
  } else if (!status.url) {
    lastUrl = null
    $('qr').innerHTML = '<span class="empty">链接已过期，点“刷新二维码”重新生成</span>'
  }
  renderNets()
  renderDevices()
  tick()
}

function tick() {
  const el = $('count')
  if (!status?.expiresAt) {
    el.textContent = ''
    return
  }
  const left = status.expiresAt - Date.now()
  if (left <= 0) {
    el.textContent = '二维码已过期'
    return
  }
  const mm = String(Math.floor(left / 60000)).padStart(2, '0')
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0')
  el.textContent = `二维码有效至 ${mm}:${ss}`
}

async function issue() {
  const address = selected === 'public' ? '' : `?address=${encodeURIComponent(selected)}`
  const result = await api(`/api/pair/issue${address}`, { method: 'POST' })
  if (!result.ok) {
    toast('生成失败')
    return
  }
  await poll()
}

async function poll() {
  try {
    status = await api('/api/pair/status')
    render()
  } catch {
    $('state-badge').innerHTML = '<i class="dot warn"></i>网关未响应'
  }
}

$('copy-link').onclick = () => copy($('link').value, '配对链接')
$('copy-token').onclick = () => copy($('token').value, '配对令牌')
$('refresh').onclick = () => void issue()
$('stop').onclick = async () => {
  if (!confirm('停止会吊销全部已配对设备并让当前链接失效，继续？')) return
  await api('/api/pair/stop', { method: 'POST' })
  toast('已停止并吊销全部设备')
  await poll()
}

void (async () => {
  try {
    const health = await api('/healthz')
    $('health').textContent = `上游 ${health.upstream} · 令牌 ${health.ownerTokenLoaded ? '已加载' : '未加载'} · 监听 ${health.gateway.host}:${health.gateway.port}`
  } catch {
    $('health').textContent = '未知'
  }
  await poll()
  if (!status?.token) await issue()
  setInterval(tick, 1000)
  setInterval(() => void poll(), 2000)
})()
