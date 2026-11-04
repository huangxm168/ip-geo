# 更新日志 / Changelog

版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。0.x 期间接口可能调整，1.0.0 之后才承诺兼容。
ip2region 换数据版本也发新版本，在这里写明上游提交号。

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
