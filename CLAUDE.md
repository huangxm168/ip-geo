# CLAUDE.md

## 这是什么

`@huangxm168/ip-geo`：公开发布到 npm 的 IP 地区解析包。**国内外按 ip2region 判，中国大陆取 ip2region，海外以 MaxMind GeoLite 为准（一个地点只取一家），港澳台两者结合**。给作者的多个 Node / TS 网站共用，修一处、各网站升级依赖即受益。使用方各自写一层薄适配（建解析器单例、读配置、按自己的列宽截断、接日志），规则一律留在本包里。

- 规则的权威文档是 [docs/rules.md](docs/rules.md)，运维是 [docs/operations.md](docs/operations.md)；本文件不复述
- 只与本机有关的事项（使用方的位置、讨论记录、开发环境）写在 `CLAUDE.local.md`，它被 `.gitignore` 挡掉、不进仓库

## 目录

```
src/
├── index.ts            对外出口（只从这里导出公开接口）
├── resolver.ts         解析器：把两类数据与规则接起来，永不抛错
├── rules.ts            分流规则（纯函数，不读文件不联网）
├── ip.ts · names.ts    IP 规整与公网判断 · 中文国家名与港澳台
├── manifest.ts         随包的 ip2region 清单 data/ip2region.json
├── fetch.ts            按清单取用 / 下载 / 校验 ip2region
├── cli.ts              命令行 ip-geo（ip2region fetch、doctor）
└── sources/            ip2region.ts · maxmind.ts（加载、校验、按修改时间重载）
scripts/update-ip2region.ts   维护者换 ip2region 版本（不随包发布）
ops/                    GeoIP.conf 范例、systemd 服务与定时器（随包发布）
test/                   vitest；fixtures/maxmind 是 MaxMind 官方测试库，.data/ 是按清单取用的 ip2region
```

## 命令

```bash
npm test               # 先按清单取用 ip2region 到 test/.data/（已在则不联网）
npm run typecheck
npm run lint           # eslint（typescript-eslint strictTypeChecked）＋ prettier --check
npm run lint:workflows # 工作流检查：actionlint ＋ zizmor（官方 Docker 镜像，按摘要钉死；GH_TOKEN=$(gh auth token) 时含联网审计）
npm run format
npm run check:pack     # 构建 ＋ publint ＋ npm pack --dry-run，看包里有哪些文件
npm run ip2region:update -- <40 位上游提交号>   # 换 ip2region 版本：重写清单，再记 CHANGELOG、发版
```

## 约定

- 注释、日志、命令行输出用中文（中英文之间加空格，中文标点）；README 中英双语（`README.md` 中文、`README.en.md` 英文），改一份必须同步另一份
- 只出 ESM；`engines` 是 Node ≥ 22.12，`@types/node` 跟着最低版本走（22），CI 在 22 与 24 上各跑一遍
- 规则改动必须同时改 docs/rules.md 与 test/rules.test.ts；对外接口改动要改两份 README 与 CHANGELOG
- **版本**：语义化版本，0.x 期间接口可调；ip2region 换数据也发新版本
- **依赖**：读 MaxMind 用 `maxmind`（不用官方的 `@maxmind/geoip2-node`：它不暴露数据库元数据，拿不到构建日期、做不了换文件前的校验，本身也只是 `maxmind` 上面的一层）；读 ip2region 用 `ip2region.js`
- **TypeScript 停在 6.0.x**：typescript-eslint 8.x 只支持到 < 6.1

## 发版

1. 改 `package.json` 的 `version`、在 CHANGELOG 写这一版
2. 照全局规则提交，打 `vX.Y.Z` 标签并推送
3. `release.yml` 三个作业：`check`（只读：核对标签与版本、全部检查、`npm pack` 出产物）→ `publish`（唯一拿 `id-token`：不检出、不装依赖，只把那个包 `npm publish`，**可信发布**，仓库与 npm 账户里都不存发布令牌）→ `github-release`（只拿 `contents: write`，以标签指向的提交说明建 Release）。⚠️ 别把安装依赖或跑仓库代码的步骤加进 `publish`：那一步拿得到发布身份
4. 工作流里的 action 一律钉到提交号、行尾注释写版本，升级时两处一起改；改了工作流先跑 `npm run lint:workflows`（CI 与发版的 check 作业也各跑一次）。⚠️ 发版流水线**不用任何缓存**（含 `setup-node` 的 `package-manager-cache: false`）：缓存可以被别的工作流写入，发出去的包就在 check 里构建
5. ⚠️ 可信发布只能给已存在的包配置：0.1.0 由作者在本机 `npm login` ＋ `npm publish` 手动发出，之后在 npm 的包设置里登记 `huangxm168/ip-geo` 的 `release.yml`（环境 `npm`），并把发布权限改成「要求两步验证、禁止令牌」

## 坑

- **MaxMind 的数据文件不得进仓库、不得随包发布**（GeoLite 条款）；`.gitignore` 挡掉了 `*.mmdb`，只放行 `test/fixtures/maxmind/` 里的官方测试库
- **官方测试库的构建日期是固定的（2026-10-22），会一天天变旧**：测试里建解析器一律 `maxDataAgeDays: null`，命令行测试给 `--max-age-days` 一个很大的数，只有专测过期的用例例外
- **不要起定时器、不要挂文件监听**：常驻的句柄会让引用它的进程（如 `next build` 的工作进程）退不出去；重载靠查询时顺带检查
- **不要用 `maxmind` 包的 `watchForUpdates`**：回调里换文件没有错误处理（新文件坏了即未处理的异常、进程退出），换之前不校验，文件被删静默保留旧版
- `ip2region.js` 的类型声明写 `search()` 返回 string，3.x 实际返回 Promise，一律 await
- MaxMind City 对账户所在地有限制（账户登记在 28 CFR 202 的受关注国家 / 地区时回 HTTP 451，换机器没用），见 docs/operations.md
- **这是公开仓库**：示例、测试与文档里的 IP 只用公共基础设施的地址（公共 DNS、MaxMind 测试库里的地址），不用自己的服务器或访客的地址；同样不写本机路径、主机名与内网地址
