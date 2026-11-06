**简体中文** | [English](README.en.md)

# @huangxm168/ip-geo

IP 地区解析：**中国境内用 [ip2region](https://github.com/lionsoul2014/ip2region)，海外与港澳台用 [MaxMind GeoLite](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data) 补齐城市与运营商。** 全部在本机查询，不调用任何在线接口。

```
114.114.114.114 → 中国 · 江苏省 · 南京市                      （ip2region）
203.80.96.10    → 中国香港 · 香港特别行政区 · Kowloon Bay · 香港宽频（ip2region＋MaxMind）
210.196.3.183   → 日本 · Tokyo · Azusawa · KDDI CORPORATION           （MaxMind）
```

## 为什么是两份数据

- ip2region 对中国境内最准（省、市、运营商），但对海外只给英文的州、城市多为空；港澳台只到「香港特别行政区」一级
- MaxMind GeoLite 对海外最好，但对中国境内不准（实测南京信风的公共 DNS 查不到省市，阿里的地址给的运营商是一家美国公司）
- 所以：**国内外按 ip2region 判，中国大陆取 ip2region，海外以 MaxMind 为准，港澳台两者结合**；一个地点（国家、州、城市）只取一家，不跨来源拼层级。规则逐条见 [docs/rules.md](docs/rules.md)

## 特点

- **永不抛错**：数据缺失、文件损坏、输入非法，都只退回粗结果或空结果
- **换数据不重启**：MaxMind 文件被 `geoipupdate` 替换后，下一次检查（缺省 1 小时）时读新文件，**校验通过才换上**，不合格就继续用旧的；文件被删了就转为降级
- **City 与 ASN 各自独立**：一个库缺失、损坏或过期，另一个照常用
- **过期自动停用**：MaxMind 文件的构建日期超过 30 天（可调）就不再使用、每天报一条错误，港澳台与海外的地点转为降级、日后可以补解析（GeoLite 条款要求新版发布后 30 天内换掉旧版）
- **不起定时器、不挂文件监听**：进程能正常退出（构建工具、一次性脚本里引用也不会卡住）
- **记下数据版本**：每条结果都带着用到的数据文件版本，日后能分清是哪一版数据给出的结论
- **ip2region 的版本随包发布**：包里只带清单（提交号 ＋ sha256），数据文件按清单取用；更新数据就是发一个新版本

## 安装

```bash
npm install @huangxm168/ip-geo
```

要求 Node.js 22.12 以上。只出 ESM。

## 准备数据

**ip2region**（必需，约 11MB）：

```bash
npx ip-geo ip2region fetch --dir ./vendor/ip2region
```

部署时建议加 `--cache-dir <长期保留的目录>`，开发服务可加 `--optional`。详见 [docs/operations.md](docs/operations.md)。

**MaxMind GeoLite**（可选；不给的话港澳台与海外先记 ip2region 的粗结果，来源标 `ip2region-fallback`，日后可以补解析）：在机器上装 MaxMind 官方的 `geoipupdate` 定时下载 `GeoLite2-City` 与 `GeoLite2-ASN` 到 `/var/lib/GeoIP`。配置与 systemd 定时器的模板在 [ops/](ops/)，步骤见 [docs/operations.md](docs/operations.md)。⚠️ GeoLite 的数据**不得**放进代码仓库或随应用分发（GeoLite 条款）。

## 用法

```ts
import { createGeoResolver } from "@huangxm168/ip-geo";

// 进程里建一个就够（两份数据都读进内存，约 70MB）
const geo = createGeoResolver({
  ip2regionDir: "./vendor/ip2region",
  maxmindDir: "/var/lib/GeoIP", // 可省
  recheckIntervalMs: 60 * 60 * 1000, // 缺省 1 小时
  maxDataAgeDays: 30, // 缺省 30 天，null 或 0 表示不设上限
  logger: myLogger, // 可省，缺省打到 console；要实现 info / warn / error，每个方法收一个事件对象（见下文「日志」）
});

// 启动时调一次（可省）：加载两份数据并返回状态，配置问题在启动日志里就能看到，第一位访客也不必等加载
await geo.ready();

const result = await geo.lookup("210.196.3.183");
// {
//   countryCode: "JP",
//   countryName: "日本",
//   region: "Tokyo",
//   city: "Azusawa",
//   isp: "KDDI CORPORATION",
//   source: "maxmind",
//   version: "ip2region@6a276cc7c4f9 GeoLite2@City-20261030+ASN-20261103",
// }

geo.status(); // 两份数据此刻的加载状态，给健康检查用；MaxMind 的 City 与 ASN 各自是 ready 或 unavailable
```

### 结果字段

| 字段          | 说明                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `countryCode` | ISO 3166-1 两位代码；港澳台一律 `HK` / `MO` / `TW`                                                                                 |
| `countryName` | 简体中文国家名，按代码取，与数据来源无关；港澳台为「中国香港」「中国澳门」「中国台湾」                                             |
| `region`      | 省 / 州：国内与港澳台是 ip2region 的写法（「江苏省」「香港特别行政区」），海外是英文                                               |
| `city`        | 城市：国内是 ip2region 的全称（「南京市」），港澳台与海外是英文                                                                    |
| `isp`         | 运营商：国内取 ip2region，海外取 MaxMind ASN 库的网络运营商名                                                                      |
| `source`      | 地点取自哪里：`ip2region` / `ip2region+maxmind` / `maxmind` / `ip2region-fallback` / `none`，含义见 [docs/rules.md](docs/rules.md) |
| `version`     | 用到的数据文件版本，最长约 60 个字符                                                                                               |

内网与保留地址、IPv6、非法输入一律是 `source: "none"`、其余为 `null`。

### 日志

`logger` 的 `info` / `warn` / `error` 各收一个事件对象：`code` 是固定的代码，使用方按它归类；`message` 是给人读的中文，可能带数据文件的路径、版本、构建日期与报错原文，**不带访客 IP**；其余是这种事件各自的字段。不传 `logger` 时只把 `message` 打到 console。`logger` 自己抛错不影响解析，那一条改由 console 打出 `message`。

| `code`                        | 级别                | 字段                               | 什么时候                                                                     |
| ----------------------------- | ------------------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| `ip2region_loaded`            | info                | `version`                          | ip2region 数据读进内存                                                       |
| `ip2region_load_failed`       | error               | `path`、`error`                    | ip2region 数据读不了，地区一律记为空，隔一个检查间隔再试                     |
| `ip2region_manifest_mismatch` | warn                | `path`、`sha256`（前 12 位）       | 数据文件与包里的清单不一致，照常使用                                         |
| `maxmind_status`              | info / warn / error | `city`、`asn`（同 `status()`）     | City 与 ASN 的可用状态变了：都可用 info，有一个不可用 warn，有一个过期 error |
| `maxmind_file_rejected`       | error               | `edition`、`path`、`error`、`kept` | 换上来的新文件不合格，继续用已加载的旧版                                     |
| `maxmind_lookup_failed`       | error               | `error`                            | 查询时检查 MaxMind 文件出了意外，这一条按 MaxMind 不可用记降级               |
| `lookup_failed`               | error               | `ip`、`error`                      | 查询时出了意外，这一条记为空                                                 |
| `load_failed`                 | error               | `error`                            | `ready()` 加载数据时出了意外                                                 |

访客 IP 只出现在 `lookup_failed` 的 `ip` 字段里（规整后的写法，`::ffff:1.2.3.4` 记作 `1.2.3.4`），不想把它写进日志就丢掉这个字段。⚠️ 它的 `error` 是原样交出的异常，消息里有可能带着那个 IP，写法与 `ip` 字段相同，可以按它替换掉。

`status()` 里不可用的 MaxMind 文件带 `cause`：`not_loaded`（尚未加载）/ `missing`（文件不存在）/ `invalid`（打不开或校验不过）/ `stale`（构建日期超过上限已停用，另带 `buildDate`）；`reason` 是给人读的中文。

## 命令行

```bash
ip-geo ip2region fetch --dir <目录> [--cache-dir <目录>] [--optional]
ip-geo doctor [--ip2region <目录>] [--maxmind <目录>] [--warn-days 14] [--max-age-days 30] [--ip <地址>]…
```

`doctor` 检查两份数据在不在、是哪一版，给了 `--ip` 就顺带查一遍。MaxMind 超过 `--warn-days` 天没更新时提示；超过 `--max-age-days` 天（与解析器停用的上限相同）或有其他错误时以 1 退出。

## 数据的许可与署名

本包的代码按 MIT 许可。数据各有许可，使用时请在网站的隐私政策或统计页面署名：

- MaxMind GeoLite：[GeoLite 条款](https://www.maxmind.com/en/geolite2/eula)，署名「This product includes GeoLite Data created by MaxMind, available from https://www.maxmind.com」；只供自己内部使用，不得用于识别或定位某个人；新版发布后 30 天内要换掉旧版（定时器自然满足；定时器坏了时解析器超过 30 天自动停用，失败通知的接法见 [docs/operations.md](docs/operations.md)）
- ip2region：[lionsoul2014/ip2region](https://github.com/lionsoul2014/ip2region)，Apache-2.0 或 MIT

## 限制

- IPv6 暂不解析（一律为空），原因见 [docs/rules.md](docs/rules.md)
- 海外与港澳台的州、城市是英文（MaxMind 的中文名覆盖不全、日后补上会让同一地方变成两个名字，理由见 [docs/rules.md](docs/rules.md)）；要显示中文由展示的那一层对照
- MaxMind GeoLite City 对账户所在地有要求，见 [docs/operations.md](docs/operations.md)

## 开发

```bash
npm install
npm test          # 首次会按清单取用 ip2region 数据到 test/.data/
npm run lint
npm run lint:workflows   # 工作流检查（需要 Docker）
npm run typecheck
npm run check:pack
```

测试用的 MaxMind 数据是 MaxMind 官方的测试库，见 [test/fixtures/maxmind/README.md](test/fixtures/maxmind/README.md)。

## 许可证

[MIT](LICENSE)
