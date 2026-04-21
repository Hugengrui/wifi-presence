# FAQ: MQTT 安装与配置

## `MQTT Connect error: not Authorized` 是什么问题

说明 broker 拒绝了认证。

在 Mosquitto 使用 `password_file` 时，必须同时提供：

- 用户名
- 密码

只填密码、不填用户名，会被拒绝。

## 如何确认 MQTT 用户名

如果创建密码文件时执行的是：

```bash
sudo mosquitto_passwd -c /etc/mosquitto/passwd wifi_presence
```

则用户名就是 `wifi_presence`。

也可以查看密码文件中的用户名：

```bash
sudo cut -d: -f1 /etc/mosquitto/passwd
```

## `Duplicate persistence_location value in configuration`

表示同一个全局配置项被定义了两次。

典型场景是：

- `/etc/mosquitto/mosquitto.conf` 已经定义了 `persistence_location`
- `conf.d/lan.conf` 又重复定义了一次

修复方式是删除 `lan.conf` 中重复的全局项，只保留监听与认证相关配置。

## `mosquitto.service` 启动失败并返回 `status=13`

这通常是权限问题，例如：

- `/etc/mosquitto/passwd` 无法被 `mosquitto` 服务用户读取
- 额外配置的日志文件不可写

建议检查：

```bash
sudo ls -l /etc/mosquitto/passwd
sudo -u mosquitto cat /etc/mosquitto/passwd
```

## OpenWrt 上的 `nc -vz` 为什么不能用

因为 BusyBox 版 `nc` 不支持这些参数。

在 Nwrt/OpenWrt 上应使用：

```sh
nc 192.168.123.60 1883
```

## 如何验证 retained 配置是否已经保存

订阅配置主题：

```bash
mosquitto_sub -h 127.0.0.1 -p 1883 -u wifi_presence -P 'YOUR_PASSWORD' \
  -t 'wifi-presence/config' -v
```

如果刚订阅就收到配置 JSON，说明 retained 配置已存在。

## 为什么重新发了一台设备后，之前那台不见了

因为 `wifi-presence/config` 的内容是覆盖式配置，不是追加式配置。

每次更新时，都应发布完整的 `devices` 列表。
