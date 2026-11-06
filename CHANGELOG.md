# 更新日志 / Changelog

版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。0.x 期间接口可能调整，1.0.0 之后才承诺兼容。
ip2region 换数据版本也发新版本，在这里写明上游提交号。

## 0.3.0

⚠️ 日志接口不兼容：传了 `logger` 的使用方要改写适配层。

- **日志改为事件对象**：`logger` 的 `info` / `warn` / `error` 由收一句中文改为收 `{ code, message, …字段 }`。`code` 是固定的 8 种（见 README「日志」），`message` 照旧是中文说明，其余字段按事件各异；导出类型 `GeoLogEvent`、`GeoLogCode`
- **日志的说明文字不再带访客 IP**：查询出错时说明文字是固定的，不再拼接 IP 与异常原文（异常原样放在 `error` 字段）。此前句子里插着 IP，使用方无法在不解析句子的情况下把它去掉
- **访客 IP 只在 `lookup_failed` 的 `ip` 字段里**，取规整后的写法（`::ffff:1.2.3.4` 记作 `1.2.3.4`），与异常原文里出现的写法相同；`maxmind_lookup_failed` 出错的是文件检查、与 IP 无关，不带 IP
- **`logger` 抛错不再影响解析**：此前 `lookup()` 与 `ready()` 会把它抛给调用方，ip2region 还会把「已加载」误记成加载失败；现在那一条改由 console 打出说明文字。`GeoLogger` 的三个方法改为函数属性的写法，只收一部分事件的函数不再能通过类型检查
- **缺省的 console 输出只打 `message`**；命令行 `doctor --ip` 查的是使用者自己给的地址，出错时照旧打出 IP 与异常原文
- `status()` 里不可用的 MaxMind 文件新增 `cause`（`not_loaded` / `missing` / `invalid` / `stale`），`cause` 为 `stale` 时必带 `buildDate`；导出类型 `MaxmindUnavailableCause`。`reason` 不变

## 0.2.0

⚠️ 规则与接口都有不兼容的改动，升级后新旧两版的结果不能直接放在一起比。

- **海外的地点只取一家**：MaxMind City 有国家以下的地点（州或城市至少一个）、且它判的国家不在中国大陆与港澳台之内时，国家、州、城市整套取 MaxMind，缺的留空；否则整套取 ip2region。此前会把 MaxMind 缺的那一栏用 ip2region 补上，两份数据对州的判断不一致时会拼出不存在的组合，来源也会把全部取自 ip2region 的地点记成 `maxmind`
- **海外的国家**：MaxMind 有地点时按它（此前一律按 ip2region、两边不一致就不采用 MaxMind 的地点）；MaxMind 判到中国大陆或港澳台时仍以 ip2region 为准
- **MaxMind 的州与城市一律取英文**（此前中文优先）：与 ip2region 的海外地名同一种写法，按州汇总时不会分成两组；跨数据版本不变
- **City 与 ASN 各自独立**：只缺 City 时地点记降级、运营商照样取 ASN；只缺 ASN 时地点照常取 MaxMind、运营商用 ip2region 的。此前缺一个就两个都不用
- **过期停用**：新选项 `maxDataAgeDays`（缺省 30，`null` 或 0 不设上限）。构建日期超过上限的 MaxMind 文件不再使用、从内存里丢掉，每天报一条错误，换成新版后自动恢复；导出 `DEFAULT_MAX_DATA_AGE_DAYS`
- **MaxMind 那一段出了意外时记降级**（日后可补解析），不再整条记为空
- 新方法 `ready()`：加载两类数据并返回状态，供启动时预热与一次性脚本使用
- `status().maxmind` 改为 `{ state: "disabled" }` 或 `{ state: "enabled", city, asn }`，`city` 与 `asn` 各自是 `ready`（带类型与构建日期）或 `unavailable`（带原因）；导出类型 `MaxmindFileState`
- 系统时钟被往回校过时照常检查文件（此前要等时钟追回来）
- 命令行 `doctor`：新增 `--warn-days`（缺省 14，超过即提示）；`--max-age-days` 改为停用的上限（缺省 30，超过以 1 退出）
- 文档：运维文档补「失败通知」（用 `OnFailure=` 覆盖片段接自己的通知）
- 发版流水线拆成检查、发布、建 Release 三个作业：只有发布那一步拿 npm 的发布身份，且它不装依赖、不跑仓库代码，只发检查那一步打好的包；action 一律钉到提交号；不再读写任何缓存（防缓存投毒）
- 新增工作流检查 `npm run lint:workflows`（actionlint ＋ zizmor，官方镜像按摘要钉死），CI 与发版前各跑一次

## 0.1.0

- 首个版本：`createGeoResolver` 按「国内外按 ip2region 判、中国大陆取 ip2region、海外以 MaxMind 为准、港澳台两者结合」解析 IPv4（规则见 docs/rules.md）
- MaxMind City 与 ASN 按修改时间重载，校验通过才换上，不合格保留旧版，文件被删转为降级
- 命令行 `ip-geo ip2region fetch`（按清单取用）与 `ip-geo doctor`（自检）
- `ops/`：geoipupdate 的配置范例与 systemd 定时器
- ip2region 数据：上游提交 `6a276cc7c4f9f2d7ff1d8ace14b91af59752f943`
