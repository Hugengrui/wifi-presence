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
