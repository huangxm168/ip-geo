**简体中文** | [English](README.en.md)

# @huangxm168/ip-geo

IP 地区解析：**中国境内用 [ip2region](https://github.com/lionsoul2014/ip2region)，海外与港澳台用 [MaxMind GeoLite](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data) 补齐城市与运营商。** 全部在本机查询，不调用任何在线接口。

```
114.114.114.114 → 中国 · 江苏省 · 南京市                      （ip2region）
203.80.96.10    → 中国香港 · 香港特别行政区 · 九龙湾 · 香港宽频（ip2region＋MaxMind）
210.196.3.183   → 日本 · 东京都 · Azusawa · KDDI CORPORATION     （MaxMind）
```

## 为什么是两份数据

- ip2region 对中国境内最准（省、市、运营商），但对海外只给英文的州、城市多为空；港澳台只到「香港特别行政区」一级
- MaxMind GeoLite 对海外最好，但对中国境内不准（实测南京信风的公共 DNS 查不到省市，阿里的地址给的运营商是一家美国公司）
- 所以：**国内外按 ip2region 判，中国大陆取 ip2region，海外以 MaxMind 为准，港澳台两者结合**。规则逐条见 [docs/rules.md](docs/rules.md)

## 特点

- **永不抛错**：数据缺失、文件损坏、输入非法，都只退回粗结果或空结果
- **换数据不重启**：MaxMind 文件被 `geoipupdate` 替换后，下一次检查（缺省 1 小时）时读新文件，**校验通过才换上**，不合格就继续用旧的；文件被删了就转为降级
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
  logger: myLogger, // 可省，缺省打到 console；要实现 info / warn / error
});

const result = await geo.lookup("210.196.3.183");
// {
//   countryCode: "JP",
//   countryName: "日本",
//   region: "东京都",
//   city: "Azusawa",
//   isp: "KDDI CORPORATION",
//   source: "maxmind",
//   version: "ip2region@6a276cc7c4f9 GeoLite2@City-20261030+ASN-20261103",
// }

geo.status(); // 两份数据此刻的加载状态，给健康检查用
```

### 结果字段

| 字段          | 说明                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `countryCode` | ISO 3166-1 两位代码；港澳台一律 `HK` / `MO` / `TW`                                                                                 |
| `countryName` | 简体中文国家名，按代码取，与数据来源无关；港澳台为「中国香港」「中国澳门」「中国台湾」                                             |
| `region`      | 省 / 州：国内是全称（「江苏省」），海外优先简体中文、没有取英文                                                                    |
| `city`        | 城市，同上                                                                                                                         |
| `isp`         | 运营商：国内取 ip2region，海外取 MaxMind ASN 库的网络运营商名                                                                      |
| `source`      | 地点取自哪里：`ip2region` / `ip2region+maxmind` / `maxmind` / `ip2region-fallback` / `none`，含义见 [docs/rules.md](docs/rules.md) |
| `version`     | 用到的数据文件版本，最长约 60 个字符                                                                                               |

内网与保留地址、IPv6、非法输入一律是 `source: "none"`、其余为 `null`。

## 命令行

```bash
ip-geo ip2region fetch --dir <目录> [--cache-dir <目录>] [--optional]
ip-geo doctor [--ip2region <目录>] [--maxmind <目录>] [--max-age-days 14] [--ip <地址>]…
```

`doctor` 检查两份数据在不在、是哪一版、MaxMind 是否超过 14 天没更新，给了 `--ip` 就顺带查一遍；有错误时以 1 退出。

## 数据的许可与署名

本包的代码按 MIT 许可。数据各有许可，使用时请在网站的隐私政策或统计页面署名：

- MaxMind GeoLite：[GeoLite 条款](https://www.maxmind.com/en/geolite2/eula)，署名「This product includes GeoLite Data created by MaxMind, available from https://www.maxmind.com」；只供自己内部使用，不得用于识别或定位某个人；新版发布后 30 天内要换掉旧版（定时器自然满足）
- ip2region：[lionsoul2014/ip2region](https://github.com/lionsoul2014/ip2region)，Apache-2.0 或 MIT

## 限制

- IPv6 暂不解析（一律为空），原因见 [docs/rules.md](docs/rules.md)
- MaxMind 的中文名覆盖不全，海外的州与城市会中英文混排
- MaxMind GeoLite City 对账户所在地有要求，见 [docs/operations.md](docs/operations.md)

## 开发

```bash
npm install
npm test          # 首次会按清单取用 ip2region 数据到 test/.data/
npm run lint
npm run typecheck
npm run check:pack
```

测试用的 MaxMind 数据是 MaxMind 官方的测试库，见 [test/fixtures/maxmind/README.md](test/fixtures/maxmind/README.md)。

## 许可证

[MIT](LICENSE)
