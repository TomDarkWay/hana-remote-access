# Hana 远程访问（v2 App）

> 交接文档：**[产品文档](docs/产品文档.md)**（定位、用户流程、决策记录、验收标准、已知问题） · **[技术文档](docs/技术文档.md)**（架构、文件地图、实现要点、端点、构建与验证、排障、安全）

把「用公网反向代理访问这台 HanaAgent」做成 HanaAgent 自己的一个应用：在**设置弹窗**里配置、启停、生成配对二维码、管理已配对设备，不再需要另外开一个面板网页。

## 它是什么

- 数据面是一个随应用启动的**受管运行时服务**（`ctx.runtime.start`，`profile: "local-machine"`），
  它监听本机端口，供 NAS 反向代理指向；对 HanaAgent 只走回环，并用回环 Host + owner token 铸钥匙。
- 控制面是本应用自己的后端路由 `/api/apps/hana-remote-access/routes/*`，
  设置页通过宿主的 App 路由鉴权调用它，因此不需要额外的公开面板页面。
- 扫码配对语义：一次性限时令牌 + 配对 cookie + 配对即铸设备钥匙；名册有上限，满了**拒绝**新配对而不是挤掉旧设备。
- 落地页默认 `pad`。原因：HanaAgent 自身的 `/mobile/` 客户端有缺陷（输入所有权标志从不置位，导致无法新建会话），
  而 `pad` 的闸门要求 `tools.run`+`plugins.use`，配对钥匙拿不到这两项 —— 所以 pad 需要用本地账号登录一次。

## 安装

安装包：`app-hana-remote-access-<版本>.zip`（官方 `scripts/extension-pack.mjs --kind app` 产物，
经 `scripts/validate-app.mjs --archive` 校验 0 error）。

在 HanaAgent 里：市场 → 已安装 → 「安装…」→ 选这个 zip → 在确认卡上核对声明的三项能力后确认。
也可以走宿主 API 安装（`POST /api/extensions/install`，`source.type:"local"` 指向该 zip，再 `staged/<id>/confirm`）。

首次装载后需要授权这三项：`app/runtime.execute`、`app/runtime.local-machine`、`app/runtime.network`。

## 配置项（设置弹窗 → 远程访问）

| 字段 | 说明 |
| --- | --- |
| 公网地址 | 反向代理对外的 origin，二维码与配对链接由它生成 |
| 网关端口 / 监听地址 | NAS 反代指向这里的端口；默认 `0.0.0.0:19388` |
| HanaAgent 端口 | 上游端口，默认 `31787`；运行时会以宿主 `server-info.json` 里的实际端口为准 |
| 允许的 Host | 逗号分隔；公网域名与内网地址都要列进来 |
| 扫码落地页 | `pad`（默认）/ `mobile` / `auto` |
| 配对钥匙权限 | `full`（一律桌面钥匙）/ `auto`（按设备收窄） |
| 名册上限 | 超出即拒绝新配对 |
| 名册与日志目录 | 留空用本应用数据目录；填已有网关的目录可**沿用已配对设备，不必重新扫码** |

前提：HanaAgent 处于「允许局域网设备」模式；`31787` 建议用防火墙限制为本机可访问。

## 目录结构

```
manifest.json          v2 清单：设置贡献（schema + 自定义页）、整页卡、能力声明
index.js               defineApp：读宿主设置 → 写 gateway.json → 启动受管服务
lib/state.js           设置→网关配置的映射，与 runtimeId 解析
routes/control.js      后端路由：status/config/start/stop/logs/doctor/pair/*
gateway/gw.mjs         数据面：配对门控、回环特权代理、WS 穿透、/api/pair/diag
gateway/pairing.mjs    配对令牌、设备名册、0600 落盘
gateway/web/*          配对落地页与手工输令牌页
ui/settings.html       设置页（配置 + 二维码 + 名册 + 体检 + 日志）
ui/assets/*            页面脚本、样式、离线二维码库、宿主 SDK 桥
sdk/                   随包分发的应用 SDK（不依赖宿主 node_modules）
```

## 卸载 / 回退

设置 → 扩展 → 卸载会停掉受管服务并摘树；`app-data/hana-remote-access` 保留。
名册目录若沿用旧网关目录，取消配对才会同时吊销宿主侧凭证。

## 验证记录（本机）

- 装载：`GET /api/apps` → `state:"loaded"`；能力 `app/runtime.execute` / `local-machine` / `network` 已在安装确认时授予。
- 托管服务：`/routes/status` → `service:{port:19388,state:"ready",id:"gateway"}`，`netstat` 显示 `0.0.0.0:19388` 在听。
- 穿透宿主：`GET /api/sessions` 200（22 个真实会话）、`POST /api/ws-ticket` 200、`GET /ws?wsTicket=…` → **101 Switching Protocols**。
- 门控：未配对流量 401 `unpaired`；`/api/pair/issue` 出公网配对链接；`/api/pair/cancel` 只作废令牌不动名册。
- 设置页：表单回填、二维码 SVG 渲染、体检 7 项、日志尾部、取消配对按钮、保存并重载 —— 均实测通过，无 console 报错。
- 名册目录沿用既有网关目录，已配对设备**不需要同步重扫**。
