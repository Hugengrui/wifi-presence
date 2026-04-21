# MQTT 安装与配置

本文档整理内网 MQTT broker 的安装、开机自启动、认证配置、调试和与 `wifi-presence` 的对接方式。

## 推荐部署方式

对于 `wifi-presence` 场景，推荐把 MQTT broker 放在内网服务器上，而不是云服务器上。

原因：

- 路由器和 `wifi-presence` 都在局域网内，链路更短
- 外网中断时，本地 presence 仍可继续工作
- Home Assistant 之类的本地自动化系统更容易直接接入

## 1. 安装 Mosquitto

以 Debian/Ubuntu 为例：

```bash
sudo apt update
sudo apt install -y mosquitto mosquitto-clients
```

设置开机自启动并立即启动：

```bash
sudo systemctl enable --now mosquitto
```

检查状态：

```bash
systemctl status mosquitto
ss -lntp | grep 1883
```

## 2. 创建认证账号

创建一个用于 `wifi-presence` 的用户名和密码：

```bash
sudo mosquitto_passwd -c /etc/mosquitto/passwd wifi_presence
```

注意：

- `wifi_presence` 就是 MQTT 用户名
- 路由器侧必须同时配置 `mqttUsername` 和 `mqttPassword`
- 只配置密码、不配置用户名，会被 broker 拒绝并返回 `not Authorized`

为了让 `mosquitto` 服务用户能读取密码文件，推荐：

```bash
sudo chown root:mosquitto /etc/mosquitto/passwd
sudo chmod 640 /etc/mosquitto/passwd
```

## 3. 添加局域网监听配置

新建 `/etc/mosquitto/conf.d/lan.conf`：

```conf
listener 1883 0.0.0.0
allow_anonymous false
password_file /etc/mosquitto/passwd
```

说明：

- `listener 1883 0.0.0.0` 允许内网其他机器访问
- `allow_anonymous false` 禁止匿名接入
- `password_file` 指向认证文件

不要在 `lan.conf` 里重复定义 Ubuntu 默认主配置里已经写过的全局项，例如：

- `persistence_location`
- 其他已经在 `/etc/mosquitto/mosquitto.conf` 中声明的全局配置

## 4. 重启与验证

重启服务：

```bash
sudo systemctl restart mosquitto
sudo systemctl status mosquitto --no-pager
```

查看日志：

```bash
sudo journalctl -u mosquitto -n 100 --no-pager
```

## 5. 本机联调

先在一个终端里订阅：

```bash
mosquitto_sub -h 127.0.0.1 -p 1883 -u wifi_presence -P 'YOUR_PASSWORD' -t 'test/#' -v
```

再在另一个终端里发布：

```bash
mosquitto_pub -h 127.0.0.1 -p 1883 -u wifi_presence -P 'YOUR_PASSWORD' -t 'test/hello' -m 'world'
```

如果订阅窗口收到：

```text
test/hello world
```

则说明 broker 正常工作。

## 6. 路由器连通性验证

在 Nwrt 路由器上，BusyBox 自带的 `nc` 语法是：

```sh
nc 192.168.123.60 1883
```

它不支持常见 Linux 发行版里的 `-vz` / `-vc` 参数。

如果命令执行后直接挂起，通常表示 TCP 已连通。

更推荐的验证方法是直接看 broker 是否收到 `wifi-presence` 的状态消息。

## 7. 与 wifi-presence 对接

路由器侧配置：

```uci
option mqttAddr 'tcp://192.168.123.60:1883'
option mqttUsername 'wifi_presence'
option mqttPassword 'YOUR_PASSWORD'
```

服务器侧订阅：

```bash
mosquitto_sub -h 127.0.0.1 -p 1883 -u wifi_presence -P 'YOUR_PASSWORD' -t 'wifi-presence/#' -v
```

如果服务正常接入，应看到：

```text
wifi-presence/nwrt/status online
```

## 8. 持久化设备配置

设备追踪列表通过 retained topic 保存：

```bash
mosquitto_pub -h 127.0.0.1 -p 1883 -u wifi_presence -P 'YOUR_PASSWORD' \
  -t 'wifi-presence/config' -r \
  -m '{"devices":[{"name":"k70-ultra","mac":"FC:5B:8C:F6:3E:98"},{"name":"yuqing-iphone","mac":"4A:9B:EC:D6:16:68"}]}'
```

删除 retained 配置：

```bash
mosquitto_pub -h 127.0.0.1 -p 1883 -u wifi_presence -P 'YOUR_PASSWORD' \
  -t 'wifi-presence/config' -r -n
```

## 9. 运行时观察

建议同时关注：

- `wifi-presence/nwrt/status`
- `wifi-presence/config`
- `wifi-presence/station/nwrt/<mac>/state`
- `wifi-presence/station/nwrt/<mac>/attrs`

相关 FAQ：

- [MQTT FAQ](./faq-mqtt.md)
- [Hostapd FAQ](./faq-hostapd.md)
- [构建与部署 FAQ](./faq-build-and-deploy.md)
