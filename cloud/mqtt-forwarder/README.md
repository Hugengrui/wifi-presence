# MQTT Forwarder

一个极简 MQTT 消息转发服务：

- 订阅 `wifi/events`
- 接收上下线 JSON
- 提供网页切换“直接转发”或“只写日志”
- 将最近事件写入 `logs/events.jsonl`
- 通过浏览器页面展示日志，并在“直接转发”模式下调用浏览器通知

## 环境变量

- `PORT`: HTTP 监听端口，默认 `8080`
- `MQTT_URL`: MQTT broker URL，例如 `mqtt://127.0.0.1:1883`
- `MQTT_TOPIC`: 默认 `wifi/events`
- `MQTT_USERNAME`
- `MQTT_PASSWORD`
- `LOG_DIR`: 默认 `./logs`

## 本地启动

```bash
npm install
MQTT_URL=mqtt://127.0.0.1:1883 npm start
```

打开：

```text
http://127.0.0.1:8080
```
