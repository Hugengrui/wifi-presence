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
