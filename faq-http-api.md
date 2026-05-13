# FAQ: HTTP API

## 当前云端服务是否暴露了 HTTP API

是。

当前 `mqtt-forwarder` 服务会暴露一组 HTTP 接口，用于：

- 查看当前模式与最近事件
- 切换网页通知模式
- 获取实时事件流
- 接收本地转发器推送的设备上下线消息

当前部署实例的监听端口是：

```text
http://4.194.30.85:15057
```

## 当前有哪些接口

### `GET /`

返回网页面板。

用途：

- 浏览最近事件
- 查看当前模式
- 配合前端页面进行实时展示

### `GET /api/status`

返回当前服务状态的 JSON。

示例响应结构：

```json
{
  "mode": "notify",
  "mqtt": {
    "url": "",
    "topic": "wifi/events"
  },
  "recent_events": []
}
```

说明：

- `mode` 取值为 `notify` 或 `log`
- `mqtt.url` 在 HTTP ingest 模式下可以为空字符串
- `recent_events` 是最近缓存的事件列表

### `POST /api/mode`

修改当前模式。

请求体：

```json
{
  "mode": "notify"
}
```

允许值：

- `notify`
- `log`

成功响应：

```json
{
  "mode": "notify"
}
```

错误响应：

```json
{
  "error": "invalid_mode"
}
```

### `GET /api/events`

返回 SSE（Server-Sent Events）实时事件流。

服务会推送两类事件：

- `mode`
- `event`

示例：

```text
event: mode
data: {"mode":"notify"}

event: event
data: {"device_name":"iPhone","mac":"AA:BB:CC:DD:EE:FF","status":"online"}
```

说明：

- 这个接口更适合网页端仪表盘
- 如果后续做微信小程序，通常更适合先用 `GET /api/status` 或 `GET /logs` 轮询，而不是直接依赖 SSE

### `GET /logs`

返回最近事件列表的 JSON 数组。

示例响应结构：

```json
[
  {
    "topic": "wifi/events",
    "device_name": "iPhone",
    "mac": "AA:BB:CC:DD:EE:FF",
    "ip": "192.168.1.2",
    "status": "online",
    "message": "设备上线：iPhone (AA:BB:CC:DD:EE:FF) - 192.168.1.2",
    "received_at": "2026-05-13T04:00:00.000Z",
    "connected_at": "",
    "disconnected_at": "",
    "connected_for": null,
    "disconnected_for": null,
    "ap_name": "Nwrt",
    "ssid": "PDCN_5G",
    "bssid": "00:03:7f:12:da:da",
    "mode": "notify",
    "source": "http"
  }
]
```

### `POST /ingest`

接收外部推送的设备事件。

当前本地转发器就是通过这个接口，把本地 MQTT 里的设备上下线消息转发到云端。

请求体示例：

```json
{
  "device_name": "iPhone",
  "mac": "AA:BB:CC:DD:EE:FF",
  "ip": "192.168.1.2",
  "status": "online",
  "connected_at": "2026-05-13T12:00:00+08:00",
  "ap_name": "Nwrt",
  "ssid": "PDCN_5G",
  "bssid": "00:03:7f:12:da:da"
}
```

字段要求：

- `status` 必须是：
  - `online`
  - `offline`

其余字段中，真正关键的是：

- `device_name`
- `mac`
- `status`

成功响应：

```json
{
  "ok": true,
  "event": {
    "topic": "wifi/events",
    "device_name": "iPhone",
    "mac": "AA:BB:CC:DD:EE:FF",
    "ip": "192.168.1.2",
    "status": "online",
    "message": "设备上线：iPhone (AA:BB:CC:DD:EE:FF) - 192.168.1.2",
    "received_at": "2026-05-13T04:00:00.000Z"
  }
}
```

错误响应：

```json
{
  "error": "unauthorized"
}
```

或：

```json
{
  "error": "invalid_json"
}
```

或：

```json
{
  "error": "invalid_payload"
}
```

## 这些接口的鉴权怎么做

当前是两套 token 鉴权。

### 1. 面板/API 访问鉴权

用于这些接口：

- `GET /`
- `GET /api/status`
- `POST /api/mode`
- `GET /api/events`
- `GET /logs`

支持以下几种带 token 的方式：

- `Authorization: Bearer <ACCESS_TOKEN>`
- 请求头：`X-Access-Token: <ACCESS_TOKEN>`
- 查询参数：`?token=<ACCESS_TOKEN>`
- 浏览器首次验证成功后，服务端会下发 `access_token` cookie

说明：

- 文档里不记录真实 token 值
- 这套方式适合管理员面板访问
- 不适合把长期共享 token 直接硬编码到小程序前端

### 2. `/ingest` 写入鉴权

用于：

- `POST /ingest`

当前只接受：

- `Authorization: Bearer <INGEST_TOKEN>`

说明：

- 这套 token 应只给“可信写入端”，例如本地转发器
- 不建议直接暴露给浏览器前端或小程序前端

## 未授权时会返回什么

非 `/ingest` 接口：

- 如果访问 `GET /` 且 token 不对，会返回一个登录页
- 其他受保护接口会返回：

```json
{
  "error": "unauthorized"
}
```

`/ingest`：

- token 不正确时返回：

```json
{
  "error": "unauthorized"
}
```

## 这个 API 适合直接给微信小程序用吗

不建议直接把现有共享 token 方案原样给小程序前端。

更推荐的方式是：

1. 保留当前 `/ingest` 给本地转发器写入
2. 新增一层面向小程序的业务 API
3. 由你自己的后端去读取：
   - `GET /api/status`
   - `GET /logs`
   - 或服务端内部直接读取日志文件

原因：

- 当前是共享 token，不是用户体系
- 小程序前端不适合长期持有高权限共享 token
- 读接口和写接口应该继续分离

## 如果后续要给小程序做 API，建议最小怎么拆

可以考虑保留现有服务不动，在外面再包一层：

- `GET /mini/status`
- `GET /mini/events`

由你自己的业务服务去完成：

- 小程序身份校验
- 用户级权限控制
- 对内部 `ACCESS_TOKEN` 的保管

这样后面即使更换 token，也不需要改小程序前端。
