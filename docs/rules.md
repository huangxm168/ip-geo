# 分流规则

`@huangxm168/ip-geo` 用两份数据解析一个 IP：**ip2region** 管中国境内（省、市、运营商都准），**MaxMind GeoLite** 管海外与港澳台的细节（城市、网络运营商）。本文说明两份数据怎么分工、每种情况下结果长什么样、为什么这样定。代码在 [src/rules.ts](../src/rules.ts)，每一条都由 [test/rules.test.ts](../test/rules.test.ts) 钉住。

## 一、总的思路

1. **国内外只按 ip2region 判。** MaxMind 对中国境内 IP 不准（实测 GeoLite2-City 2026-10-30 版：南京信风的公共 DNS 114.114.114.114 查不到省市，阿里的 223.5.5.5 给的运营商是「Alibaba (US) Technology」），不能反过来让它判。所以每个 IP 都先查 ip2region
2. **中国大陆一律取 ip2region**，不查 MaxMind
3. **港澳台两者结合**：ip2region 认得出港澳台，但城市一栏是空的，城市交给 MaxMind 补
4. **海外以 MaxMind 为准**：ip2region 对海外只给英文的州，城市多为空
5. **两边判的国家不一致时，不采用 MaxMind 的地点**，否则会出现「美国 · 东京」

## 二、逐条

| 情况                                           | 国家             | 省 / 州                         | 城市                        | 运营商                          | 来源                 |
| ---------------------------------------------- | ---------------- | ------------------------------- | --------------------------- | ------------------------------- | -------------------- |
| 中国大陆                                       | CN · 中国        | ip2region                       | ip2region                   | ip2region                       | `ip2region`          |
| 港澳台，MaxMind City 判的也是这一地            | HK / MO / TW     | ip2region（「香港特别行政区」） | MaxMind                     | ip2region；为空时取 MaxMind ASN | `ip2region+maxmind`  |
| 港澳台，MaxMind 没有城市或判成别处             | HK / MO / TW     | ip2region                       | 空                          | 同上                            | `ip2region`          |
| 海外，MaxMind City 判的国家一致                | ip2region 的代码 | MaxMind；它缺就用 ip2region     | MaxMind；它缺就用 ip2region | MaxMind ASN；没有再用 ip2region | `maxmind`            |
| 海外，MaxMind 没有记录或判成别国               | ip2region 的代码 | ip2region                       | ip2region                   | 同上                            | `ip2region`          |
| 港澳台与海外，MaxMind 不可用                   | 同上             | ip2region                       | ip2region                   | ip2region                       | `ip2region-fallback` |
| 内网与保留地址、IPv6、ip2region 不可用或查不到 | 空               | 空                              | 空                          | 空                              | `none`               |

**来源只说明地点（省 / 州、城市）取自哪里**；运营商取自哪个文件，看数据版本里有没有 ASN 那一段。

**MaxMind「不可用」与「查过了、没有」是两回事**：前者（没配目录、文件缺失或打不开）记 `ip2region-fallback`，意思是「这条日后可以补解析」；后者记 `ip2region`，意思是「这就是最终结果」，补解析不必再碰它。

## 三、名称

- **国家名**：一律按 ISO 代码取简体中文名（`Intl.DisplayNames`），不用 MaxMind 自带的中文国家名，也不用 ip2region 给的英文名。这样同一个国家无论走哪一支都是同一个名字，按国家汇总时不会分成两组
- **港澳台**：国家代码存 HK / MO / TW，国家名写「中国香港」「中国澳门」「中国台湾」，省一级保留 ip2region 的写法（「香港特别行政区」「澳门特别行政区」「台湾省」）
- **国内的省、市**：保留 ip2region 的全称（「江苏省」「南京市」）
- **海外的州、城市**：MaxMind 有简体中文名就用中文，没有就用英文（实测东京都、英格兰、伦敦有中文，Chiyoda City、Östergötland County 只有英文）。⚠️ 所以同一张表里会有中英文混排；MaxMind 日后给某个城市补上中文名，同一个城市在新旧数据里会是两个名字

## 四、数据版本

结果里的 `version` 记下这一条用到了哪些数据文件，空格分隔：

```
ip2region@6a276cc7c4f9 GeoLite2@City-20261030+ASN-20261103
```

- `ip2region@<上游提交号前 12 位>`：数据文件与包里的清单一致时；不一致时是 `ip2region@sha256-<前 12 位>`
- MaxMind 按产品线各一段，段内是用到的库与构建日期（UTC）。只用到 ASN 时是 `GeoLite2@ASN-20261103`
- 最长约 60 个字符

## 五、刻意不做的

- **IPv6 一律为空**：包里只取用 ip2region 的 IPv4 数据；国内外又只能靠 ip2region 判，所以不让 MaxMind 单独判 IPv6（那样国内的 IPv6 会被判到错误的城市）。真有需要时加 ip2region 的 IPv6 数据文件（约 37MB）
- **不存经纬度、邮编**：GeoLite 条款禁止用于识别或定位某一个人、某一户或街道地址，城市一级已够统计用
- **不让 MaxMind 判中国大陆的运营商**：ip2region 没有运营商时就是空（如南京信风的公共 DNS），MaxMind ASN 给的往往是境外注册的公司名，与国内的「电信 / 联通 / 移动」不是一套口径
