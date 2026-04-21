# 在 Nwrt 路由器上的适配指南

本文档面向使用 Nwrt 或其他 QCA 分支固件的路由器，整理 `wifi-presence` 在该环境中的安装、适配、配置与验证流程。

## 背景

标准 OpenWrt 上，`wifi-presence` 默认会从 `/var/run/hostapd/` 自动发现 `hostapd` 的控制 socket。

在本次适配的 Nwrt 环境中，Wi-Fi 仍然由 `hostapd` 管理，但控制 socket 路径不是标准 OpenWrt 的默认位置，而是：

- `/var/run/hostapd-wifi0/ath0`
- `/var/run/hostapd-wifi1/ath1`

同时，这个 QCA `hostapd` 的 `STATUS` 输出比上游实现多了一段统计信息，例如：

```text
---- TOTAL PACKET COUNT -----------
```

原版 `wifi-presence` 会把这类非 `key=value` 行当成错误，因此需要使用兼容过的二进制。

## 适配目标

在 Nwrt 路由器上完成以下目标：

- 正常连接 `hostapd` 的 per-interface control socket
- 正常连接内网 MQTT broker
- 通过 retained MQTT 配置持久化设备追踪列表
- 正常发布设备的 `connected` / `not_connected` 状态与属性

## 1. 验证 Nwrt 上的 hostapd 接口

先确认 `hostapd` 进程存在：

```sh
ps | grep '[h]ostapd'
```

确认具体接口的 control socket：

```sh
find /var/run -type s | grep -E 'hostapd|wpa|wifi|ap'
```

在本次适配环境中，可用 socket 为：

- `/var/run/hostapd-wifi0/ath0`
- `/var/run/hostapd-wifi1/ath1`

分别测试连通性：

```sh
hostapd_cli -p /var/run/hostapd-wifi0 -i ath0 ping
hostapd_cli -p /var/run/hostapd-wifi1 -i ath1 ping
```

应返回：

```text
PONG
```

分别测试状态接口：

```sh
hostapd_cli -p /var/run/hostapd-wifi0 -i ath0 status
hostapd_cli -p /var/run/hostapd-wifi1 -i ath1 status
```

分别测试在线设备枚举：

```sh
hostapd_cli -p /var/run/hostapd-wifi0 -i ath0 all_sta
hostapd_cli -p /var/run/hostapd-wifi1 -i ath1 all_sta
```

## 2. 安装 wifi-presence

如果路由器上已通过 `opkg` 安装，可直接检查：

```sh
opkg files wifi-presence
```

本次环境中的安装结果为：

- `/etc/config/wifi-presence`
- `/usr/bin/wifi-presence`
- `/etc/init.d/wifi-presence`

如果使用的是为 Nwrt 兼容后重新编译的二进制，可直接替换：

```sh
/etc/init.d/wifi-presence stop
cp /usr/bin/wifi-presence /usr/bin/wifi-presence.bak
cp /tmp/wifi-presence /usr/bin/wifi-presence
chmod 755 /usr/bin/wifi-presence
/etc/init.d/wifi-presence start
```

需要回滚时：

```sh
/etc/init.d/wifi-presence stop
cp /usr/bin/wifi-presence.bak /usr/bin/wifi-presence
chmod 755 /usr/bin/wifi-presence
/etc/init.d/wifi-presence start
```

## 3. 配置 `/etc/config/wifi-presence`

Nwrt 环境下最关键的是显式指定 `hostapdSocks`，不要依赖默认自动发现。

推荐配置：

```uci
config wifi-presence 'main'
        option hostapdSocks '/var/run/hostapd-wifi0/ath0:/var/run/hostapd-wifi1/ath1'
        option sockDir '/tmp'
        option apName 'Nwrt'
        option mqttAddr 'tcp://192.168.123.60:1883'
        option mqttUsername 'wifi_presence'
        option mqttPassword 'YOUR_PASSWORD'
        option mqttPrefix 'wifi-presence'
        option hassAutodiscovery '1'
        option hassPrefix 'homeassistant'
        option debounce '10s'
```

也可以用 `uci` 命令修改：

```sh
uci set wifi-presence.main.hostapdSocks='/var/run/hostapd-wifi0/ath0:/var/run/hostapd-wifi1/ath1'
uci set wifi-presence.main.sockDir='/tmp'
uci set wifi-presence.main.apName='Nwrt'
uci set wifi-presence.main.mqttAddr='tcp://192.168.123.60:1883'
uci set wifi-presence.main.mqttUsername='wifi_presence'
uci set wifi-presence.main.mqttPassword='YOUR_PASSWORD'
uci set wifi-presence.main.mqttPrefix='wifi-presence'
uci set wifi-presence.main.hassAutodiscovery='1'
uci set wifi-presence.main.hassPrefix='homeassistant'
uci set wifi-presence.main.debounce='10s'
uci commit wifi-presence
```

## 4. 启动与验证

重启服务：

```sh
/etc/init.d/wifi-presence restart
```

查看日志：

```sh
logread -e wifi-presence
```

正常情况下，MQTT 订阅端应至少能看到：

```text
wifi-presence/nwrt/status online
```

## 5. 通过 MQTT 配置要追踪的设备

`wifi-presence` 不是从本地配置文件里读取设备列表，而是订阅 MQTT 里的 `wifi-presence/config`。

示例：

```json
{
  "devices": [
    {
      "name": "k70-ultra",
      "mac": "FC:5B:8C:F6:3E:98"
    },
    {
      "name": "yuqing-iphone",
      "mac": "4A:9B:EC:D6:16:68"
    }
  ]
}
```

发布 retained 配置：

```sh
mosquitto_pub -h 127.0.0.1 -p 1883 -u wifi_presence -P 'YOUR_PASSWORD' \
  -t 'wifi-presence/config' -r \
  -m '{"devices":[{"name":"k70-ultra","mac":"FC:5B:8C:F6:3E:98"},{"name":"yuqing-iphone","mac":"4A:9B:EC:D6:16:68"}]}'
```

说明：

- 配置消息是覆盖式的，不是追加式的
- 想持久化多台设备，必须一次性发布完整列表
- 因为使用了 `-r`，broker 会保留这份配置，服务重启后仍然有效

## 6. 运行时验证

在 MQTT 服务器上订阅：

```sh
mosquitto_sub -h 127.0.0.1 -p 1883 -u wifi_presence -P 'YOUR_PASSWORD' \
  -t 'wifi-presence/#' -v
```

期望看到：

- `wifi-presence/nwrt/status online`
- `wifi-presence/config ...`
- `wifi-presence/station/nwrt/<mac>/state connected`
- `wifi-presence/station/nwrt/<mac>/attrs ...`

设备断开后，默认会经过 `10s` 防抖，再发布 `not_connected`。

## 7. Nwrt 适配结论

本次适配说明：

- Nwrt 的 `hostapd` control socket 可以直接被 `wifi-presence` 使用
- 需要显式配置 `hostapdSocks`
- 需要使用兼容 QCA `STATUS` 扩展输出的二进制
- MQTT 设备配置应通过 retained 消息统一维护

进一步的问题可以参考：

- [MQTT 安装与配置](./mqtt.md)
- [Hostapd FAQ](./faq-hostapd.md)
- [MQTT FAQ](./faq-mqtt.md)
- [构建与部署 FAQ](./faq-build-and-deploy.md)
