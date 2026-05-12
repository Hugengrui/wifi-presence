# FAQ: 构建与部署

## 路由器已经通过 `opkg` 安装了 wifi-presence，还需要重装包吗

不一定。

如果只是为 Nwrt/QCA 做兼容修复，通常只需要：

- 保留 `/etc/config/wifi-presence`
- 保留 `/etc/init.d/wifi-presence`
- 替换 `/usr/bin/wifi-presence`

## 这次适配的二进制放在哪里

本地生成的 ARMv7 二进制位于：

```text
dist/wifi-presence-armv7
```

它适用于：

- `uname -m = armv7l`
- OpenWrt 架构为 `arm_cortex-a7_neon-vfpv4`

## 为什么要重新编译，而不是只改 UCI

因为 Nwrt/QCA 的 `hostapd STATUS` 输出里包含额外的统计段，而原版程序会在解析时直接报错退出。

这属于程序兼容性问题，不属于配置问题。

## 如何替换路由器上的二进制

```sh
/etc/init.d/wifi-presence stop
cp /usr/bin/wifi-presence /usr/bin/wifi-presence.bak
cp /tmp/wifi-presence /usr/bin/wifi-presence
chmod 755 /usr/bin/wifi-presence
/etc/init.d/wifi-presence start
```

## 如何回滚

```sh
/etc/init.d/wifi-presence stop
cp /usr/bin/wifi-presence.bak /usr/bin/wifi-presence
chmod 755 /usr/bin/wifi-presence
/etc/init.d/wifi-presence start
```

## 为什么本地测试没有把整个 `internal/hostapd` 测试包跑完

因为当前构建环境限制了 `unixgram` socket，导致依赖本地 Unix socket 的测试无法通过。

本次修复已补充并验证了解析层的针对性测试，覆盖了 Nwrt/QCA `STATUS` 扩展输出的兼容场景。

## 这台 Nwrt 路由器的 CPU 是如何调频的

本次现场确认：

- `cpufreq` 驱动是 `cpufreq-dt`
- 可选 governor 有 `conservative`、`ondemand`、`userspace`、`powersave`、`performance`
- 但系统只暴露了一个频率档位：`1008000 kHz`

所以虽然 governor 可切换，但实际上没有可切换的频率区间，效果等价于：

- CPU 固定运行在 `1008 MHz`

也就是说，这台机器当前**没有实际意义上的动态 CPU 调频**。

## 这台 Nwrt 路由器的性能加速现在是什么状态

本次现场已确认以下能力处于启用状态：

- `qca-nss-drv`
- `qca-nss-ecm`
- `ECM NSS IPv4` 前端
- `ECM NSS IPv6` 前端
- `dev.nss.ipv4cfg.ipv4_accel_mode = 1`
- `dev.nss.ipv6cfg.ipv6_accel_mode = 1`
- `dev.nss.pppoe.br_accel_mode = 1`
- `dev.nss.rps.enable = 1`
- `dev.nss.clock.auto_scale = 1`

可以认为常见的 QCA/NSS 加速链已经基本打开。

## 这台路由器还有什么值得优化的性能开关吗

从本次现场状态看，**没有明显的“立刻值得改”的安全优化项**。

更具体地说：

- 不建议再叠加通用软件流量加速方案，避免和 QCA NSS ECM 重复。
- 不建议把 governor 当成主要调优手段，因为只有单一频点，收益很小。
- `irqbalance` 当前没有运行，但关键 NSS 中断已经分布在两个 CPU 上。对于 2 核平台，没有压测基线时不建议盲目启用。

如果确实要继续挖性能，优先顺序建议是：

1. 先做明确的 WAN-LAN / IPv6 / Wi-Fi 吞吐基线测试
2. 再按测试结果决定是否调整中断亲和性
3. 最后才考虑更激进的 NSS 或内核网络参数微调
