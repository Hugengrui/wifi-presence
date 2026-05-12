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

## 8. 持久化保存重启原因与启动证据

Nwrt/OpenWrt 的 `logread` 和大部分运行时日志默认都在内存里。路由器如果异常重启，上一轮运行中的应用层日志通常会丢失。

在本次环境中，建议额外部署一个开机自启动的 `reboot-trace` 服务，把每次启动时的关键信息落到持久化的 `/overlay/reboot-trace/`：

- `reset_reason`
- `dmesg` 开头部分
- `watchdog` / `SSR` / `remoteproc` / `panic` 关键词
- 当前内存信息
- 上一次是否属于“非干净关机”

当前路由器已经按这个思路配置完成。查看方式：

```sh
ls -la /overlay/reboot-trace
readlink -f /overlay/reboot-trace/latest.log
sed -n '1,160p' /overlay/reboot-trace/latest.log
```

目录中重要文件说明：

- `boot-YYYYmmdd-HHMMSS.log`
  每次启动生成一份启动证据快照
- `latest.log`
  指向最近一次快照
- `dirty`
  当前运行中的“未正常关机标记”
- `last-clean-shutdown.log`
  上一次正常关机/重启时留下的标记

说明：

- 如果系统是异常断电、卡死或被 watchdog 拉起，通常来不及在重启前写日志
- 这种情况下，最有效的办法是在**下一次开机后立即读取启动早期的 `reset_reason` 和 `dmesg`**
- 因此这个方案本质上是“启动后补捉上一次重启的证据”，而不是保证“内核崩溃前一定能落盘”

如果需要检查服务本身：

```sh
/etc/init.d/reboot-trace enabled
ls -l /etc/rc.d/*reboot-trace*
sed -n '1,220p' /etc/init.d/reboot-trace
```

本次适配说明：

- Nwrt 的 `hostapd` control socket 可以直接被 `wifi-presence` 使用
- 需要显式配置 `hostapdSocks`
- 需要使用兼容 QCA `STATUS` 扩展输出的二进制
- MQTT 设备配置应通过 retained 消息统一维护

现场运行经验：

- 如果出现 `bind: address already in use`，通常是 `/tmp/wp.*` 这类本地 `unixgram` socket 残留。建议同时保留 init 脚本清理和修复后的二进制，双重避免残留 socket 抢占路径。
- 本次现场里，Wi-Fi 压力测试下的整机重启最终确认是**供电问题**。更换电源后，稳定性恢复，因此不要把所有 `SSR` / `remoteproc` / `hostapd` 异常都直接归因到 `wifi-presence`。
- 本次现场里，WAN IPv6 PD 之前无法正常下发，后续在更换 MAC 地址后恢复。这个现象更偏向运营商或上游网络侧绑定策略，建议单独记录，不要和 `wifi-presence` 故障混淆。

## 9. CPU 调频与性能加速现状

本次现场路由器的 CPU 调频状态为：

- `cpufreq` 驱动是 `cpufreq-dt`
- 当前 governor 是 `performance`
- 可选 governor 包括 `conservative`、`ondemand`、`userspace`、`powersave`、`performance`
- 但实际只暴露了一个频率档位：`1008000 kHz`

这意味着：

- 即使切换 governor，CPU 也没有可切换的频率档位
- 当前效果等价于 CPU 固定运行在 `1008 MHz`
- `powerctl` 脚本虽然存在，但对这台 `cmcc,rax3000qy` 没有带来实际的动态调频收益

本次现场性能加速链路的状态为：

- `qca-nss-drv` 已加载
- `qca-nss-ecm` 已启用
- `ECM NSS IPv4` / `ECM NSS IPv6` 前端目录存在
- `dev.nss.ipv4cfg.ipv4_accel_mode = 1`
- `dev.nss.ipv6cfg.ipv6_accel_mode = 1`
- `dev.nss.pppoe.br_accel_mode = 1`
- `dev.nss.rps.enable = 1`
- `dev.nss.clock.auto_scale = 1`

可以认为，这台机子当前常见的 QCA/NSS 加速项已经基本到位。

调优建议：

- **不建议**再额外叠加通用软件流量加速方案，尤其是在已经使用 QCA NSS ECM 的情况下，避免和现有加速链重叠。
- **不建议**为了“省电”去反复切 governor。由于只有单一频点，这类改动几乎没有实际收益。
- `irqbalance` 当前没有运行，但 NSS 关键中断已经有明确的亲和性分布，例如 `nss_queue0` 主要在 CPU0、`nss_queue1` 主要在 CPU1。对这种 2 核平台，不建议在没有压测对比的前提下盲目引入 `irqbalance`。
- 如果后续确实要继续调优，优先做**有基线的吞吐/延迟压测**，再考虑中断亲和性或 NSS 相关参数微调，而不是先改系统开关。

进一步的问题可以参考：

- [MQTT 安装与配置](./mqtt.md)
- [Hostapd FAQ](./faq-hostapd.md)
- [MQTT FAQ](./faq-mqtt.md)
- [构建与部署 FAQ](./faq-build-and-deploy.md)
