# FAQ: Hostapd 与 Nwrt 适配

## `wifi status` 返回 `{}`，是不是说明路由器没有 Wi-Fi

不一定。

在本次 Nwrt/QCA 环境里，Wi-Fi 实际可用，但并不通过标准 OpenWrt 的 `wifi status` 输出暴露完整状态。真正决定 `wifi-presence` 是否可用的是：

- `hostapd` 是否在运行
- 是否存在 per-interface control socket
- `hostapd_cli -p ... -i ... ping` 是否返回 `PONG`

## `/var/run/hostapd` 里只有 `global`，是不是不能用

不能只看 `/var/run/hostapd`。

本次 Nwrt 环境的实际 socket 位于：

- `/var/run/hostapd-wifi0/ath0`
- `/var/run/hostapd-wifi1/ath1`

`global` 不是 `wifi-presence` 需要的接口 socket。

## `hostapd_cli status` 返回 `Selected interface 'global'` 然后 `FAIL`

这是因为命令没有指定具体接口，默认落到了 `global`。

应使用：

```sh
hostapd_cli -p /var/run/hostapd-wifi0 -i ath0 status
hostapd_cli -p /var/run/hostapd-wifi1 -i ath1 status
```

## `invalid status response line "---- TOTAL PACKET COUNT -----------"` 是什么问题

这是 QCA/Nwrt 的 `hostapd STATUS` 输出比上游多了一段统计信息，而原版 `wifi-presence` 的解析器过于严格，错误地把这类扩展行当成格式错误。

这不是 MQTT 配错，也不是 `hostapdSocks` 配错，而是程序兼容性问题。

## `all_sta` 能看到设备，为什么还需要修补程序

因为 `wifi-presence` 启动时会先调用 `STATUS` 拿 SSID/BSSID/信道等基础信息。

即使 `all_sta` 是正常的，只要 `STATUS` 解析报错，程序仍然会退出。

## 为什么只看到第一次 `connected`

第一次 `connected` 很可能来自配置下发后的在线设备补发：

- 程序收到 `wifi-presence/config`
- 通过 `all_sta` 发现设备当前已在线
- 于是立即发布一条 `connected`

这不一定说明实时 `AP-STA-CONNECTED` / `AP-STA-DISCONNECTED` 事件链路已经完全正常。

## 如何直接观察 hostapd 事件

```sh
hostapd_cli -p /var/run/hostapd-wifi1 -i ath1
```

进入交互后执行：

```text
attach
```

然后手动让手机断开或重连 Wi-Fi，观察原始事件输出。

## `unable to connect to hostapd control socket ... bind: address already in use` 是什么问题

这是 `wifi-presence` 本地 `unixgram` socket 残留导致的。

程序连接 `hostapd` 时，会在本地创建类似下面的 socket：

- `/tmp/wp.ath0`
- `/tmp/wp.ath1`
- `/tmp/wp-attach.ath0`

如果路由器异常重启、`hostapd` 重载，或进程被强制终止，这些本地 socket 文件可能残留。之后新进程再绑定同一路径时，就会报：

```text
bind: address already in use
```

本次适配里，建议同时做两层处理：

- init 脚本启动前清理：

```sh
rm -f /tmp/wp.*
```

- 使用已修复的 `wifi-presence` 二进制。修复后的程序会在创建本地 `unixgram` socket 前，先删除旧的残留 socket 文件。

如果现场要临时恢复：

```sh
/etc/init.d/wifi-presence stop
rm -f /tmp/wp.*
/etc/init.d/wifi-presence start
```

## Wi-Fi 压力测试导致路由器重启，一定是脚本或 `wifi-presence` 的问题吗

不一定。

本次现场最终确认，反复在高负载 Wi-Fi 传输下重启，**根因是供电问题**。更换电源后，整机稳定性明显恢复。

这类现象很容易和以下软件层症状混在一起：

- `remoteproc` / `SSR` 日志
- `hostapd` 重建
- `wifi-presence` 掉线
- `S95done` 恢复脚本报错

但如果更换更稳的电源适配器后问题消失，就应优先把根因归到供电，而不是继续把 `wifi-presence` 或 QCA 恢复脚本当成主因。

## IPv6 之前拿不到 PD，为什么换了 MAC 后恢复了

本次现场里，WAN 侧 IPv6 PD 之前一直无法正常下发，后续在更换 MAC 地址后恢复。

这通常说明问题更偏向上游网络策略、认证或运营商侧的地址绑定，而不是 `wifi-presence` 本身。

如果你在类似环境里遇到：

- IPv6 地址能起来
- 但 PD 一直没有正常下发

可以把 WAN MAC 地址的历史变更记录下来，作为排查线索之一。

## 路由器经常重启，但 `logread` 里看不到上一次的原因，怎么办

因为 OpenWrt/Nwrt 默认很多日志都在内存里，异常重启后会丢失。

在本次环境里，推荐额外部署一个启动时抓证据的服务，把信息写入持久化的 `/overlay/reboot-trace/`。重点看：

```sh
ls -la /overlay/reboot-trace
sed -n '1,160p' /overlay/reboot-trace/latest.log
```

里面通常会包含：

- `reset_reason`
- `watchdog`
- `remoteproc`
- `SSR`
- `panic` / `Oops` / `Call Trace`

如果 `latest.log` 里出现类似：

- `qti_scm_restart_reason ... reset_reason : [0xFAF1080D]`
- `ol_ath_wifi_ssr: SSR event ...`
- `remoteproc ... stopped`

这更像是底层 QCA Wi-Fi / firmware / watchdog 方向的问题，而不是 `wifi-presence` 自身导致的整机重启。
