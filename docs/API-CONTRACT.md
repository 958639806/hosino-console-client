# API 契约

核对基线：`hosino-console@1bcb35f928ad6f0ce46b32d38bccacea255ef170`。本次移动扩展需要配套服务端代码，不能假设已部署。JSON 成功响应沿用各接口原始对象，不统一增加 `data` 包装。凭据日期、请求时间和运行时间均为 Unix epoch **毫秒**。

## 基线中已有的接口

| 方法与路径 | 请求与主要返回 | 客户端处理 |
| --- | --- | --- |
| `GET /api/me` | `{authed,isOwner}` | 原网页身份查询；移动设备使用 Bearer 认证。 |
| `POST /api/login` | `{password}` → `{ok:true}`，设置 Cookie | 仅保留原网页兼容，不用于保存 Android 登录。 |
| `POST /api/logout` | 清除网页 Cookie 会话 | Android 使用下文设备撤销接口。 |
| `GET /api/overview` | `{info,health,status,host,gw,server}` | 远程服务与主机状态。 |
| `GET /api/sessions?offset=0&q=...` | `{sessions,totalCount,defaults}` | 后端取一页后筛选 q；不能据此假定为全库搜索。 |
| `GET /api/history?key=...&limit=60&before=...` | `{messages,hasMore,nextBefore,gatewayHasMore,windowCount,...}` | limit 为 1–200；before 为消息 ID 或序号。网关最多取 1000 条后本地切片，`hasMore` 不保证存在可继续读取的游标。 |
| `POST /api/send` | `{key,message,deliver,attachments?}` → 网关结果，可含 runId | 原基线每次生成新幂等键；移动扩展增加 requestId，见下文。默认 `deliver:false` 为控制台对话。 |
| `POST /api/abort` | `{key}` | 显式停止聊天；读取超时、关闭页面与取消请求不是停止。 |
| `GET /api/models` | `{models:[...]}` | 可用性可能为 available/unavailable/unknown。 |
| `GET /api/logs?limit=200&level=...` | 现有日志响应 | 使用服务器实际返回，失败不能伪装成空日志。 |
| `GET /api/uploads/limits` | `{maxBytes,maxPerMessage,ttlDays,chat,cli}` | 以服务器限制为准，不固定附件上限。 |
| `POST /api/uploads?scope=chat&session=...&name=...` | `application/octet-stream` 原始字节 → 附件元数据 | 不是 multipart。CLI 使用 scope=cli。 |
| `GET /api/uploads/:id` | 鉴权二进制附件 | 先带授权获取 Blob，再预览或下载。 |
| `DELETE /api/uploads/:id` | 删除上传附件 | 写请求也携带 X-HS。 |
| `GET /api/media?...` | 既有媒体定位参数 → 鉴权图片/音频 | 不把 accessToken/refreshToken 拼入 URL。 |
| `GET /api/cli/tools` | 工具能力 | 仍需设备 CLI 授权。 |
| `GET/POST /api/cli/sessions` | 查询列表；创建 `{tool,title?,model?}` | CLI 界面属于后续管理阶段。 |
| `GET /api/cli/sessions/:id` | 会话、history、running；扩展增加运行摘要 | 断流后查询既有会话。 |
| `POST /api/cli/sessions/:id/run` | `{prompt,attachments?,requestId}` → POST + SSE | 增量输出单独实现，不能依赖普通原生 HTTP 的完整响应。 |
| `POST /api/cli/sessions/:id/cancel` | 显式取消任务 | 与终止 SSE 读取分开。 |

基线来源：[public/api.js](https://github.com/958639806/hosino-console/blob/1bcb35f928ad6f0ce46b32d38bccacea255ef170/public/api.js)、[核心 JSON 路由](https://github.com/958639806/hosino-console/blob/1bcb35f928ad6f0ce46b32d38bccacea255ef170/server.mjs#L474)、[上传路由](https://github.com/958639806/hosino-console/blob/1bcb35f928ad6f0ce46b32d38bccacea255ef170/server.mjs#L1330)、[认证入口](https://github.com/958639806/hosino-console/blob/1bcb35f928ad6f0ce46b32d38bccacea255ef170/server.mjs#L1829)。历史 `API-v2-proposal.md` 不作为契约来源。

## 本次新增的移动接口

所有写请求携带 `X-HS: 1`。登录、刷新之外的受保护接口使用 `Authorization: Bearer <accessToken>`，移动请求不依赖跨站 Cookie。刷新令牌只在刷新 JSON 请求体内发送。

| 方法与路径 | 请求 | 返回/语义 |
| --- | --- | --- |
| `GET /api/mobile/capabilities` | 无需登录；登录后可携带 Bearer | `{apiVersion:1,build:'mobile-v1',auth:['device-bearer'],modules,permissions,limits}`。modules 含 overview/sessions/chat/uploads/cli/management；当前 management=false。permissions.cli 仅在设备已认证且服务端启用 CLI 时为 true。limits 含 uploadMaxBytes、maxPerMessage；详细上传限制继续查询原接口。 |
| `POST /api/mobile/login` | `{password,deviceName}` | `{device:{id,name},accessToken,refreshToken,accessExpiresAt,refreshExpiresAt}`；设备映射现有 owner。 |
| `POST /api/mobile/refresh` | `{refreshToken}` | 与登录相同的新凭据对；旧 accessToken 和 refreshToken 立即失效。客户端按设备串行刷新。 |
| `POST /api/mobile/logout` | Bearer，空 JSON | `{ok:true}`；撤销当前设备，access/refresh 均失效。 |
| `GET /api/mobile/devices` | 已登录 owner（网页 Cookie 或设备 Bearer） | `{devices:[{id,name,createdAt,updatedAt?,revokedAt}]}`，不返回令牌。 |
| `DELETE /api/mobile/devices/:id` | 已登录 owner，X-HS | `{ok:true}`；撤销指定设备。当前 Android 页面不等于已提供完整设备管理界面。 |
| `GET /api/mobile/requests/:requestId` | Bearer | `{requestId,operation,session,state,createdAt,updatedAt,status?,result?,error?,code?}`；state 为 pending/unknown/completed/failed。不存在时返回 404，不能把不可达或查询失败解释为“未执行”。 |

服务端默认仅允许 Android 本地 Origin `https://localhost`。测试用其他来源通过 `HS_MOBILE_ORIGINS` 精确配置；预检允许 Authorization、Content-Type、X-HS、Range、X-Filename 等明确列出的头，不反射任意 Origin。公网 HTTPS 终结与反向代理由测试部署环境提供。

## 幂等和恢复

移动 `POST /api/send` 必须增加稳定的 requestId；CLI `/run` 同样要求。ID 为 8–128 个字母、数字、下划线或连字符，首位为字母或数字。客户端在发送前持久化请求，连接切换不会复用其他连接的记录。

服务端按 owner + requestId 保存回执，并对操作、目标和内容计算指纹，在下游调用前提交持久化记录。相同 ID、相同内容返回已保存的提交响应；不同内容返回 `409 request_conflict`。未完成请求返回 `409 request_pending`，无法确认的请求返回 `409 request_unknown`。这些分支都不会再次派发执行。响应丢失、网络切换和服务器重启后先查询，不能通过换 ID 自动重发。

`completed` 只说明**原执行请求已获得提交响应并被记录**，不是模型已输出完成或 CLI 进程已退出。聊天运行状态继续从会话/历史读取；CLI 会话新增 `activeRun`、`lastRun`，含 sessionId、runId、requestId、state、startedAt 及可选 finishedAt/exitCode/reason。运行 state 为 running/completed/failed/cancelled/interrupted。

服务端重启将未完成请求标记 unknown，既有 running CLI 标记 interrupted；不会自动启动替代任务。当前持久化实现由单个服务进程拥有，不是多副本分布式执行方案；也不承诺外部 QQ 等副作用的“恰好一次投递”。

## 错误分类

| 情况 | 处理原则 |
| --- | --- |
| `401 AUTH_EXPIRED` | 使用可用刷新凭据恢复；刷新失败按实际原因显示，不因普通网络错误删除凭据。 |
| `401 AUTH_REVOKED` | 已失效、撤销或轮换的凭据，要求重新认证。 |
| `403 FORBIDDEN` 或原接口 forbidden | 权限/来源拒绝，与未登录区分。 |
| 404 | API/资源不存在；缺少移动能力应提示版本不兼容，不能伪造可用能力。 |
| 409 | 请求冲突、仍在执行或结果未知，依 code 显示并查询既有记录。 |
| 413 / 上传限制 | 显示服务器返回限制与原因。 |
| 429 | 限流，保留 requestId，不自动循环执行。 |
| 5xx、超时、离线 | 读取失败可再次查询；执行结果可能未知，禁止自动重发。 |

普通 JSON、SSE、二进制上传及鉴权 Blob 下载分别验证。严格 Mock 的接口覆盖不能证明真实服务或 Android WebView 行为。

当前 SDK 不自动重试，也不自动刷新；认证协调层负责串行刷新。JSON/SSE/媒体使用 WebView fetch 与 ReadableStream，上传使用原始字节 XHR；未启用普通原生 HTTP 的全局 fetch 补丁。fetch 拒绝重定向，XHR 无法在浏览器跟随重定向前拦截；测试服务应提供无跳转的最终 HTTPS API，并在 Android 实测上传跨源行为。
