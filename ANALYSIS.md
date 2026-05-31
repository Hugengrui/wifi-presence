# wifi-presence 项目完整分析文档

## 目录

1. [分支分析](#分支分析)
2. [工作原理](#工作原理)
3. [从零开始的部署方法](#从零开始的部署方法)
4. [文件逐个讲解](#文件逐个讲解)

---

## 分支分析

本仓库当前只有一个分支：

| 分支名 | 说明 |
|--------|------|
| `main` | 主分支，包含所有核心源代码、文档和 CI 配置 |

> 注意：README 中提到了一个 `openwrt` 分支（位于原作者仓库 `awilliams/wifi-presence`），
> 该分支包含 OpenWrt 的打包脚本和构建配置，但本 fork 中未包含。

---

## 工作原理

### 一句话总结

**wifi-presence 是一个运行在 OpenWrt 路由器上的守护进程，通过监听 hostapd 的控制接口
获取 WiFi 客户端的连接/断开事件，然后将这些事件发布到 MQTT broker，
从而让 Home Assistant 实现基于 WiFi 的人员在离家检测。**

### 架构图（数据流）

```
┌─────────────────────┐
│   手机/WiFi设备      │
│  连接/断开 WiFi      │
└──────────┬──────────┘
           │ WiFi 事件
           ▼
┌─────────────────────┐
│     hostapd          │
│ (OpenWrt AP 的WiFi   │
│  管理守护进程)        │
│                      │
│  ctrl_interface      │
│  Unix Domain Socket  │
└──────────┬──────────┘
           │ AP-STA-CONNECTED / AP-STA-DISCONNECTED
           ▼
┌─────────────────────┐
│   wifi-presence      │
│                      │
│  1. 监听hostapd事件  │
│  2. 防抖处理         │
│  3. 发布MQTT消息     │
└──────────┬──────────┘
           │ MQTT Publish
           ▼
┌─────────────────────┐
│    MQTT Broker       │
│   (如 Mosquitto)     │
└──────────┬──────────┘
           │ MQTT Subscribe
           ▼
┌─────────────────────┐
│   Home Assistant     │
│  自动发现设备追踪器   │
│  显示在家/离家状态    │
└─────────────────────┘
```


### 详细工作流程

#### 1. 启动阶段

1. 解析命令行参数（AP名称、MQTT地址、hostapd socket路径等）
2. 连接到 MQTT broker，发布 "online" 状态消息
3. 设置 MQTT 遗嘱消息（Will），确保异常断开时自动发布 "offline"
4. 连接到每个 hostapd 控制接口 socket（一个 radio 一个 socket）
5. 发送 `PING` 命令验证连接
6. 发送 `STATUS` 命令获取 AP 信息（SSID、BSSID、Channel 等）

#### 2. 运行阶段

程序启动后并行执行三个核心任务：

**任务A - 配置订阅：**
- 订阅 MQTT 的 `wifi-presence/config` topic
- 当收到 JSON 配置（包含要追踪的设备 MAC 列表）时：
  - 对比新旧配置，计算差异（新增/删除/更新）
  - 对新增设备：查询 hostapd 获取当前连接状态
  - 向 Home Assistant 发布设备发现消息
  - 发布初始连接状态

**任务B - 事件监听：**
- 通过 `ATTACH` 命令订阅 hostapd 的实时事件
- 收到 `AP-STA-CONNECTED` 事件 → 标记设备为"在家"
- 收到 `AP-STA-DISCONNECTED` 事件 → 经过防抖延迟后标记设备为"离家"
- 收到 `CTRL-EVENT-TERMINATING` → 程序退出

**任务C - 连接监控：**
- 监控 MQTT 连接是否断开
- 断开时终止程序

#### 3. 防抖机制（Debounce）

WiFi 设备可能频繁短暂断开再重连（如信号波动）。防抖机制的作用：
- 收到断开事件后，不立即发布"离家"状态
- 等待一段时间（默认10秒）
- 如果在此期间设备重新连接，则取消"离家"发布
- 如果超时仍未重连，才发布"离家"

#### 4. MQTT Topic 结构

| Topic | 用途 |
|-------|------|
| `wifi-presence/<AP_NAME>/status` | wifi-presence 自身在线状态 |
| `wifi-presence/config` | 接收配置（要追踪的设备列表） |
| `homeassistant/device_tracker/<AP_NAME>/<MAC>/config` | HA 自动发现配置 |
| `wifi-presence/station/<AP_NAME>/<MAC>/state` | 设备状态（connected/not_connected） |
| `wifi-presence/station/<AP_NAME>/<MAC>/attrs` | 设备属性（JSON，含SSID等） |

---


## 从零开始的部署方法

### 前提条件

- 一台运行 OpenWrt 的路由器（作为 WiFi AP）
- 一个 MQTT Broker（如 Mosquitto）
- （可选）Home Assistant 实例，与 MQTT broker 连接

### 步骤一：安装 MQTT Broker

如果还没有 MQTT broker，可以在任意 Linux 机器上安装 Mosquitto：

```bash
# Ubuntu/Debian
sudo apt install mosquitto mosquitto-clients

# 启动服务
sudo systemctl enable mosquitto
sudo systemctl start mosquitto
```

或者使用 Docker：

```bash
docker run -d --name mosquitto -p 1883:1883 eclipse-mosquitto
```

### 步骤二：在 OpenWrt 路由器上安装 wifi-presence

**方法A：通过 opkg 包管理器安装（推荐）**

```bash
# SSH 登录到路由器
ssh root@192.168.1.1

# 添加公钥
wget https://wifi-presence.s3.us-east-2.amazonaws.com/public.key
opkg-key add public.key

# 添加自定义源
echo "src/gz wifi-presence http://wifi-presence.s3-website.us-east-2.amazonaws.com" \
  >> /etc/opkg/customfeeds.conf

# 更新包列表并安装
opkg update
opkg install wifi-presence
```

**方法B：手动下载安装**

从 [GitHub Releases](https://github.com/awilliams/wifi-presence/releases/latest)
下载对应架构的 .ipk 包，然后：

```bash
opkg install wifi-presence_*.ipk
```

**方法C：从源码编译**

```bash
# 在开发机上（需要 Go 1.19+）
git clone https://github.com/awilliams/wifi-presence.git
cd wifi-presence

# 交叉编译为路由器架构（以 mipsel 为例）
GOOS=linux GOARCH=mipsle go build -o wifi-presence ./cmd/wifi-presence

# 拷贝到路由器
scp wifi-presence root@192.168.1.1:/usr/bin/
```


### 步骤三：配置 wifi-presence

编辑 OpenWrt 上的配置文件 `/etc/config/wifi-presence`：

```
config wifi-presence
    option mqttAddr 'tcp://192.168.1.100:1883'
    option apName 'my-router'
    option verbose '0'
    option hassAutodiscovery '1'
```

关键配置项说明：
- `mqttAddr`：MQTT broker 的地址和端口
- `apName`：此 AP 的名称，用于 MQTT topic 中区分多个 AP
- `hassAutodiscovery`：是否启用 Home Assistant 自动发现

### 步骤四：启动服务

```bash
# 启用开机自启
/etc/init.d/wifi-presence enable

# 启动服务
/etc/init.d/wifi-presence start
```

如果是手动编译的二进制，可以直接运行：

```bash
wifi-presence \
  -mqtt.addr "tcp://192.168.1.100:1883" \
  -apName "my-router" \
  -hostapd.socks "/var/run/hostapd/wlan0:/var/run/hostapd/wlan1" \
  -verbose
```

### 步骤五：发布配置（要追踪的设备）

通过 MQTT 发布要追踪的设备列表：

```bash
# 创建配置文件 devices.json
cat > devices.json << 'EOF'
{
  "devices": [
    {"name": "我的手机", "mac": "AA:BB:CC:DD:EE:FF"},
    {"name": "家人手机", "mac": "11:22:33:44:55:66"}
  ]
}
EOF

# 发布到配置 topic（-r 表示 retained，重启后仍有效）
mosquitto_pub -h 192.168.1.100 -t 'wifi-presence/config' -r -f devices.json
```

### 步骤六：验证

```bash
# 订阅所有 wifi-presence 相关消息
mosquitto_sub -h 192.168.1.100 -t 'wifi-presence/#' -v
```

应该能看到类似输出：
```
wifi-presence/my-router/status online
wifi-presence/station/my-router/aa-bb-cc-dd-ee-ff/state connected
```

### 步骤七：Home Assistant 集成

如果 Home Assistant 已配置 MQTT 集成，并且 `hassAutodiscovery` 已启用，
HA 会自动发现被追踪的设备并显示在设备追踪器中。

无需额外配置，设备会自动出现在：
- **设备与服务** → **MQTT** → 对应设备
- **人员** 页面可以关联这些设备追踪器

### 可选：安装完整版 hostapd

默认的 OpenWrt hostapd 是精简版，不支持查询已连接设备列表。
安装完整版后，wifi-presence 启动时可以立即获取所有已连接设备的状态：

```bash
opkg remove wpad-basic-mbedtls
opkg install wpad-mbedtls
```

---


## 文件逐个讲解

### 顶层文件

#### `go.mod`
Go 模块定义文件。模块路径为 `github.com/awilliams/wifi-presence`，使用 Go 1.19。
依赖两个外部包：
- `github.com/eclipse/paho.mqtt.golang`：Eclipse Paho MQTT 客户端库，用于与 MQTT broker 通信
- `golang.org/x/sync`：提供 `errgroup` 等并发原语

#### `go.sum`
Go 模块的校验和文件，确保依赖的完整性和不可篡改性。

#### `.gitignore`
Git 忽略规则文件。

#### `LICENSE`
项目开源许可证。

#### `README.md`
项目主要文档，包含项目介绍、快速开始指南、配置说明、安装方法等。

#### `CHANGELOG.md`
版本变更日志，记录每个版本的新特性、修复和变更：
- v0.3.0：修复 hostapd 新版 `AP-STA-CONNECTED` 消息处理
- v0.2.0：修复含非 ASCII 字符的 SSID 解码
- v0.1.x：添加 HA 自动发现支持、hostapd-mini 兼容等
- v0.0.x：初始版本

---

### `cmd/wifi-presence/` - 程序入口

#### `cmd/wifi-presence/main.go`
**这是整个程序的入口文件**，包含 `main()` 函数和核心 `run()` 函数。

主要逻辑：
1. **信号处理**：监听 `SIGINT`/`SIGTERM` 实现优雅退出
2. **参数解析**：使用 `flag` 包定义所有命令行参数
3. **参数验证**：确保必要参数（如 mqtt.addr、hostapd.socks）不为空
4. **MQTT 连接**：创建 MQTT 客户端并连接 broker
5. **Hostapd 连接**：连接到每个 hostapd 控制接口 socket
6. **Daemon 创建**：组装所有配置项创建 Daemon 实例
7. **并发运行**：使用 `errgroup` 并发运行 MQTT 监控和 Daemon

`findUnixSockets()` 辅助函数：扫描 `/var/run/hostapd/` 目录，
自动发现所有 hostapd socket 文件（排除 `global` socket）。

#### `cmd/wifi-presence/version.go`
使用 Go 1.16 的 `//go:embed` 特性将 VERSION 文件内容嵌入到二进制中，
在 `init()` 函数中去除空白字符。

#### `cmd/wifi-presence/VERSION`
纯文本文件，当前版本号：`0.3.0`

---


### `internal/hostapd/` - hostapd 控制接口客户端

这个包实现了与 hostapd 控制接口的完整通信逻辑。

#### `internal/hostapd/doc.go`
包文档，说明此包用于与 hostapd 的控制接口交互。

#### `internal/hostapd/conn.go`
**底层 Unix Socket 连接封装。**

- `newUnixSocketConn(localPath, remotePath)`：创建到 hostapd socket 的 unixgram 连接
  - `localPath`：本地 socket 路径（临时目录中）
  - `remotePath`：hostapd 的 ctrl_interface socket 路径
- `conn` 结构体：封装 `net.UnixConn`，添加了：
  - `setReadDeadline/unsetReadDeadline`：读超时管理
  - `setWriteDeadline`：写超时管理
  - `Close()`：关闭连接并清理本地 socket 文件

#### `internal/hostapd/ctrl.go`
**hostapd 控制协议实现，核心通信层。**

定义了 hostapd 控制接口的所有命令和响应常量：
- `PING`/`PONG`：心跳检测
- `STATUS`：获取 AP 状态
- `STA-FIRST`/`STA-NEXT`：遍历已连接设备（链表式）
- `ATTACH`/`DETACH`：订阅/取消订阅实时事件

核心方法：
- `cmd()`：线程安全的命令发送+响应接收，使用互斥锁保护
- `ping()`：验证 hostapd 是否响应
- `status()`：获取 AP 状态信息
- `stationFirst()`/`stationNext(mac)`：遍历连接的设备
- `attach(ctx, callback)`：**关键方法** - 订阅实时事件流
  - 发送 ATTACH 命令后进入阻塞读取循环
  - 收到事件后调用回调函数
  - 支持通过 context 取消
  - 自动处理 DETACH 清理

`detacher()` 方法实现了安全的分离逻辑，确保只执行一次 DETACH。

#### `internal/hostapd/client.go`
**对外暴露的高层客户端 API。**

- `NewClient(localSockDir, ctrlSock)`：创建客户端，验证 socket 路径合法性
- `Client` 结构体方法：
  - `Close()`：关闭连接
  - `Status()`：获取 AP 状态
  - `Stations()`：获取所有已连接设备列表
  - `Attach(ctx, events)`：订阅事件流（创建独立的 socket 连接以避免冲突）

`isValidSocketPath()`：检查 macOS 上 socket 路径长度限制（104字符）。

#### `internal/hostapd/event.go`
**hostapd 事件解析器。**

定义了四种事件类型：
- `EventStationConnect`：设备连接事件，包含 MAC 地址
- `EventStationDisconnect`：设备断开事件，包含 MAC 地址
- `EventTerminating`：hostapd 正在退出（如 WiFi 设置变更导致重启）
- `EventUnrecognized`：未识别的事件（忽略处理）

`parseEvent(msg)` 函数解析原始消息字符串：
- 去除优先级前缀（如 `<3>`）
- 根据前缀匹配事件类型
- 提取 MAC 地址并验证格式

#### `internal/hostapd/station.go`
**WiFi 站点（客户端设备）信息解析。**

`Station` 结构体包含：
- `MAC`：设备 MAC 地址
- `Associated`：是否关联（真正连接）
- `RxBytes/TxBytes`：收发字节数
- `Connected`：连接时长
- `Inactive`：不活跃时长
- `Signal`：信号强度

`parse()` 方法解析 hostapd 返回的 key=value 格式响应。

#### `internal/hostapd/status.go`
**AP 状态信息解析。**

`Status` 结构体包含：
- `State`：AP 状态（如 ENABLED）
- `Channel`：无线信道
- `MaxTxPower`：最大发射功率
- `SSID`：网络名称
- `BSSID`：AP 的 MAC 地址

`decodeSSID()` 函数处理 hostapd 的特殊 SSID 编码：
- 支持转义字符：`\"`, `\\`, `\e`, `\n`, `\r`, `\t`
- 支持十六进制编码：`\xHH`

#### `internal/hostapd/mac.go`
MAC 地址验证工具，使用正则表达式验证 `XX:XX:XX:XX:XX:XX` 格式。

---


### `internal/hass/` - Home Assistant MQTT 集成

这个包实现了与 Home Assistant 通过 MQTT 协议的集成。

#### `internal/hass/doc.go`
包文档，说明此包通过 MQTT Device Tracker API 与 Home Assistant 集成。

#### `internal/hass/mqtt.go`
**MQTT 客户端封装，核心通信模块。**

常量定义：
- `PayloadHome = "connected"`：设备在家
- `PayloadNotHome = "not_connected"`：设备不在家
- `StatusOnline/StatusOffline`：wifi-presence 自身状态

`MQTTOpts` 配置结构体包含 broker 地址、认证信息、topic 前缀等。

`NewMQTT()` 函数：
- 创建 MQTT 客户端，配置遗嘱消息（Will）
- 禁用自动重连（出错时直接终止程序）
- 设置连接丢失回调

`MQTT` 结构体的关键方法：
- `StatusOnline/StatusOffline()`：发布自身状态
- `RegisterDeviceTracker()`：向 HA 发布设备发现配置
  - 生成 `device_id`、`unique_id`
  - 包含设备名称、MAC、制造商等信息
- `UnregisterDeviceTracker()`：取消设备追踪（发送空消息）
- `StationHome/StationNotHome()`：发布设备在家/离家状态
- `StationAttributes()`：发布设备详细属性（JSON）
- `SubscribeConfig()`：订阅配置更新
- `OnConnectionLost()`：监控连接断开

QoS 使用 `ExactlyOnce (2)` 确保消息可靠送达。

#### `internal/hass/topics.go`
**MQTT Topic 路径生成器。**

`MQTTTopics` 结构体生成各种标准化的 topic 路径：
- `Will()`：`<prefix>/<ap_name>/status`
- `Config()`：`<prefix>/config`
- `DeviceDiscovery(mac)`：`<hass_prefix>/device_tracker/<ap_name>/<mac>/config`
- `DeviceState(mac)`：`<prefix>/station/<ap_name>/<mac>/state`
- `DeviceJSONAttrs(mac)`：`<prefix>/station/<ap_name>/<mac>/attrs`

辅助函数：
- `sanitizeTopic()`：去除特殊字符，转小写（满足 MQTT/HA topic 规范）
- `sanitizeMACTopic()`：将 MAC 中的 `:` 替换为 `-`

#### `internal/hass/messages.go`
**MQTT 消息的数据结构定义。**

- `Configuration`：运行时配置，包含要追踪的设备列表
- `TrackConfig`：单个追踪设备（name + mac）
- `DeviceTracker`：HA 设备发现的完整配置（符合 HA MQTT Discovery 规范）
- `Device`：设备信息（名称、连接、制造商）
- `Attrs`：设备属性（连接时间、SSID、BSSID、在线状态等）

#### `internal/hass/vendors.go`
**MAC 地址到设备厂商的映射表。**

`VendorByMAC(mac)` 函数通过 MAC 地址前三字节（OUI）识别设备制造商。
目前包含 Apple、Google、Samsung 三个厂商的大量 OUI 前缀。
这让 Home Assistant 中可以显示设备的制造商信息。

---


### `internal/presence/` - 核心业务逻辑

这是程序的核心业务层，将 hostapd 事件转化为 MQTT 状态更新。

#### `internal/presence/doc.go`
包文档，说明此包提供 wifi-presence 应用的核心功能。

#### `internal/presence/daemon.go`
**核心守护进程，整个程序的"大脑"。**

使用 Option 模式配置：
- `WithAPName()`：设置 AP 名称
- `WithHassOpt()`：注入 MQTT 客户端
- `WithHostAPD()`：注入 hostapd 客户端（可多个）
- `WithLogger()`：注入日志器
- `WithDebounce()`：设置防抖时间
- `WithHASSAutodiscovery()`：是否启用 HA 自动发现

`Daemon` 结构体核心字段：
- `stations map[MAC]station`：当前追踪的所有设备状态
- `haps []hap`：所有 hostapd 连接
- `db *debouncer`：防抖器

`Run()` 方法：使用 `errgroup` 并发运行：
1. MQTT 连接监控
2. 配置订阅处理
3. 每个 hostapd 的事件监听

`onConfigChange()` 方法 - 配置变更处理：
- 计算新旧配置差异（新增/删除/更新/无变化）
- 对新增设备：查询 hostapd 获取当前连接状态
- 对更新设备：更新 HA 发现配置
- 对删除设备：取消 HA 设备追踪

`onHostapdEvent()` 方法 - 事件处理：
- **连接事件**：
  - 验证是否为被追踪设备
  - 取消可能存在的断开防抖
  - 发布"在家"状态和属性
  - 智能处理多AP间漫游（忽略旧 BSSID 的延迟断开事件）
- **断开事件**：
  - 验证是否为被追踪设备
  - 智能判断：如果设备已连接到其他 BSSID，忽略此事件
  - 通过防抖器延迟发布"离家"状态

#### `internal/presence/debounce.go`
**防抖器实现。**

设计目的：防止 WiFi 信号波动导致的频繁状态翻转。

`debouncer` 结构体：
- `debounce time.Duration`：等待时长
- `queue map[MAC]*time.Timer`：每个 MAC 地址对应的定时器

两个核心方法：
- `enqueue(mac, callback)`：入队一个延迟回调
  - 如果该 MAC 已有回调在队列中，不做任何操作（保留先前的）
  - 否则创建定时器，到期后执行回调
- `cancel(mac)`：取消某 MAC 的等待中回调
  - 停止定时器
  - 从队列中删除
  - 返回是否成功取消（用于日志）

#### `internal/presence/mac.go`
**MAC 地址类型定义。**

`MAC [6]byte` 类型提供：
- `String()`：格式化为 `XX:XX:XX:XX:XX:XX`（大写）
- `Decode(s)`：从字符串解码
- `MarshalJSON()`/`UnmarshalJSON()`：JSON 序列化/反序列化

---


### `internal/hostapd/hostapdtest/` - hostapd 模拟框架

用于测试的 hostapd 模拟服务器。

#### `internal/hostapd/hostapdtest/doc.go`
包文档。

#### `internal/hostapd/hostapdtest/hostapd.go`
**模拟 hostapd socket 服务器。**

`NewHostAPD(sockPath)` 创建一个监听 Unix socket 的模拟 hostapd。
`Serve(handler)` 方法处理请求循环：
- 接收命令 → 调用 Handler 对应方法 → 返回响应
- 支持所有 hostapd 命令：PING、STATUS、STA-FIRST、STA-NEXT、ATTACH、DETACH

特别处理 ATTACH：启动 goroutine 将事件 channel 中的消息推送给客户端。

#### `internal/hostapd/hostapdtest/handler.go`
**可编程的请求处理器。**

`Handler` 结构体提供回调注册接口：
- `OnPing()`：自定义 PING 响应
- `OnStatus()`：自定义 STATUS 响应
- `OnStationFirst()`/`OnStationNext()`：自定义设备列表响应
- `OnAttach()`：返回事件 channel
- `OnDetach()`：断开通知

`DefaultHostAPDHandler()` 便捷构造函数：接受状态和设备列表参数，
创建标准行为的 Handler。

`StatusResp` 和 `StationResp` 提供 `encode()` 方法，
将结构体编码为 hostapd 控制接口的 key=value 格式。

---

### `test/` - 集成测试

#### `test/integration_test.go`
**端到端集成测试。**

测试完整的 wifi-presence 工作流程：
1. 创建模拟 hostapd（两个radio，模拟多AP场景）
2. 配置设备追踪列表
3. 启动 wifi-presence
4. 验证初始状态：已连接的设备报告"connected"，未连接的报告"not_connected"
5. 模拟断开事件，验证状态变更
6. 测试配置更新（移除设备）
7. 测试 hostapd 终止事件处理

需要外部 MQTT broker 才能运行（通过 `-mqttAddr` flag 指定）。

#### `test/helper_test.go`
**测试辅助函数。**

- `newIntTest()`：搭建完整测试环境
  - 创建模拟 hostapd 实例
  - 编译 wifi-presence 二进制
  - 配置 MQTT 客户端
- `intTest` 结构体提供：
  - `startWifiPresence()`：启动并等待 online 状态
  - `waitMessage()`：带超时的消息等待
  - `subTopic()`：订阅 MQTT topic
  - `pubTopic()`：发布 MQTT 消息
- `wifiPresenceExec`：管理 wifi-presence 进程的编译和执行

#### `test/docker-compose.yml`
用于本地开发的 Docker Compose 配置：
- `homeassistant`：Home Assistant 2022.2.9 实例
- `mosquitto`：Eclipse Mosquitto MQTT broker

#### `test/mosquitto.conf`
Mosquitto 配置文件（用于测试环境）。

#### `test/ha.yaml`
Home Assistant 的最小配置文件（用于测试环境）。

#### `test/Makefile`
测试环境管理的 Makefile。

#### `test/hostap-ctrl/main.go`
**交互式 hostapd 模拟工具。**

这是一个独立的命令行工具，用于手动测试 wifi-presence：
- 启动一个模拟 hostapd socket
- 提供交互式菜单：
  - `1`：发送设备连接事件
  - `2`：发送设备断开事件
  - `3`：发送终止事件
  - `q`：退出

使用方法：
```bash
go run ./test/hostap-ctrl -sockPath /tmp/test-hostapd.sock -mac "BE:EF:00:00:FA:CE"
```

---


### `.github/workflows/` - CI/CD

#### `.github/workflows/main.yml`
GitHub Actions CI 工作流：
- 触发条件：所有 push 和 pull request
- 运行环境：`ubuntu-latest`
- 步骤：
  1. checkout 代码
  2. 安装 Go (^1.16)
  3. 运行测试 `go test -race ./...`（含竞态检测）
  4. 运行代码检查 `go vet ./...`

---

### `docs/` - 文档资源

#### `docs/diagram.png`
项目架构图，展示 wifi-presence 在 AP、MQTT、Home Assistant 之间的位置关系。

#### `docs/wifi-presence.drawio`
架构图的源文件（draw.io 格式），可以用 draw.io 编辑。

---

### `vendor/` - 依赖缓存

Go vendor 目录，包含所有第三方依赖的源代码副本，确保构建的可重复性。
主要包含：
- `github.com/eclipse/paho.mqtt.golang`：MQTT 客户端
- `github.com/gorilla/websocket`：WebSocket 支持（paho MQTT 的依赖）
- `golang.org/x/net`：网络工具库
- `golang.org/x/sync`：同步原语（errgroup）

---

## 总结

wifi-presence 是一个设计精良的 Go 项目，具有以下特点：

1. **事件驱动**：直接对接 hostapd 控制接口，实时获取连接/断开事件，
   无需轮询，响应迅速且资源占用极低

2. **防抖设计**：通过可配置的防抖机制避免 WiFi 信号波动导致的误报

3. **多AP支持**：可同时监控多个无线接口（如 2.4G 和 5G），
   并智能处理设备在 AP 间漫游的情况

4. **标准集成**：完全符合 Home Assistant MQTT Discovery 规范，
   即插即用

5. **优雅容错**：支持 hostapd 精简版降级运行、MQTT 连接丢失检测、
   hostapd 重启处理等

6. **测试完善**：包含单元测试、集成测试和模拟 hostapd 框架，
   覆盖核心逻辑
