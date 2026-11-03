# MaxMind 官方测试库

这三个文件取自 [maxmind/MaxMind-DB](https://github.com/maxmind/MaxMind-DB) 的 `test-data/`，提交 `d1551916cff0712d12ff602c309234471b0402a2`，原样未改：

| 文件                      | 用途                                               |
| ------------------------- | -------------------------------------------------- |
| `GeoLite2-City-Test.mmdb` | City 库：加载、查询、分流规则的真实地址            |
| `GeoLite2-ASN-Test.mmdb`  | ASN 库：运营商                                     |
| `GeoIP2-City-Test.mmdb`   | 另一条产品线的 City 库：测「换了文件不重启即生效」 |

许可：该仓库按 Apache-2.0 或 MIT 双许可发布（Copyright © 2013–2026 MaxMind, Inc.）。这些是 MaxMind 专门给各语言读取库写测试用的**测试数据**，只收了少数几个地址段，不是 GeoLite 数据库本身；真实的 GeoLite 数据**不得**放进本仓库（GeoLite 条款）。

测试库里有哪些地址，看同一提交的 `source-data/*.json`。
