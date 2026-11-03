# 更新日志 / Changelog

版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。0.x 期间接口可能调整，1.0.0 之后才承诺兼容。
ip2region 换数据版本也发新版本，在这里写明上游提交号。

## 0.1.0（未发布）

- 首个版本：`createGeoResolver` 按「国内外按 ip2region 判、中国大陆取 ip2region、海外以 MaxMind 为准、港澳台两者结合」解析 IPv4（规则见 docs/rules.md）
- MaxMind City 与 ASN 按修改时间重载，校验通过才换上，不合格保留旧版，文件被删转为降级
- 命令行 `ip-geo ip2region fetch`（按清单取用）与 `ip-geo doctor`（自检）
- `ops/`：geoipupdate 的配置范例与 systemd 定时器
- ip2region 数据：上游提交 `6a276cc7c4f9f2d7ff1d8ace14b91af59752f943`
