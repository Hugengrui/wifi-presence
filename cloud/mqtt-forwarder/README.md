# MQTT Forwarder

一个极简 MQTT 消息转发服务：

- 订阅 `wifi/events`
- 接收上下线 JSON
- 也支持通过 HTTP `/ingest` 接收同样的 JSON
- 提供网页切换“直接转发”或“只写日志”
- 将最近事件写入 `logs/events.jsonl`
- 通过浏览器页面展示日志，并在“直接转发”模式下调用浏览器通知

## 环境变量

- `PORT`: HTTP 监听端口，默认 `15057`
- `MQTT_URL`: MQTT broker URL，例如 `mqtt://127.0.0.1:1883`
- `MQTT_TOPIC`: 默认 `wifi/events`
- `MQTT_USERNAME`
- `MQTT_PASSWORD`
- `INGEST_TOKEN`: 可选。设置后，HTTP `/ingest` 必须带 `Authorization: Bearer <token>`
- `LOG_DIR`: 默认 `./logs`

## 本地启动

```bash
npm install
MQTT_URL= npm start
```

打开：

```text
http://127.0.0.1:8080
```

## HTTP 接收模式

如果 MQTT broker 只在本地网络，不方便让云服务器直接访问，可以把云服务器改成只接收 HTTP：

```bash
PORT=15057
MQTT_URL=
INGEST_TOKEN=change-me
npm start
```

然后向云服务器发送：

```bash
curl -X POST http://127.0.0.1:15057/ingest \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer change-me' \
  -d '{"device_name":"iPhone","mac":"AA:BB:CC:DD:EE:FF","ip":"192.168.1.2","status":"online"}'
```

## 本地 MQTT -> 云服务器 HTTP 转发

可直接使用仓库里的本地转发脚本。这个脚本兼容 `wifi-presence` 实际发布的：

- `wifi-presence/station/<ap>/<mac>/state`
- `wifi-presence/station/<ap>/<mac>/attrs`

并把它们转换成云端 `/ingest` 需要的 JSON。

```bash
npm install
MQTT_URL=mqtt://127.0.0.1:1883 \
MQTT_USERNAME=your_user \
MQTT_PASSWORD=your_password \
HTTP_ENDPOINT=http://4.194.30.85:15057/ingest \
INGEST_TOKEN=change-me \
node local-forwarder.js
```
