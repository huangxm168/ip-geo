# 运维

一台机器要准备两份数据：**ip2region**（随包的清单取用，部署时做）与 **MaxMind GeoLite**（机器上的 `geoipupdate` 定时下载）。本文按「第一次装」「日常」「排查」「下线」的顺序写。

## 一、ip2region：部署时按清单取用

包里带着清单 `data/ip2region.json`（上游提交号、sha256、字节数），数据文件本身不在包里。部署时在 `npm ci` 之后执行：

```bash
npx ip-geo ip2region fetch --dir <应用读的目录> --cache-dir <长期保留的缓存目录>
```

- 缓存目录放在各次发布之外（如 `shared/ip2region`）：文件按哈希命名存一份，应用目录里只放软链。只有包换了 ip2region 版本之后的第一次部署要联网（约 11MB），回滚到旧发布时它链着的旧文件还在
- 下载每次限时 60 秒、网络出错才重试、最多 3 次；与清单不符或校验不过即失败，部署应当停在切换版本之前
- 开发服务可以加 `--optional`：取不到只提示，地区解析一律记为空，不影响开发
- 缓存目录里的旧版本不自动删（一份 11MB、一季度一份），按需手工清理

## 二、MaxMind：每台机器一份

**按机器、不按网站**：一台机器一个数据目录（`/var/lib/GeoIP`）、一个定时器，同机的几个网站共读；免费账户的下载额度（每 24 小时 30 次）也就按机器算。

### 前提：账户

- 在 maxmind.com 注册免费的 GeoLite 账户，在「Manage License Keys」生成一把许可密钥，记下账户 ID。密钥只显示一次，它相当于密码
- ⚠️ **City 库要求账户不属于美国 28 CFR 202 所说的「受关注国家」或受管辖人员**（MaxMind 数据处理附录第 8 条）。账户登记的地区落在其中时，City 库在**任何地方**下载都回 HTTP 451（`FORBIDDEN_FOR_LEGAL_REASONS`，消息里写的是账户的地区而不是请求的来源），换服务器没有用；ASN 与 Country 不受影响。可以先用不计额度的接口核对：

  ```bash
  curl -sS -u '<账户 ID>:<许可密钥>' \
    'https://updates.maxmind.com/geoip/updates/metadata?edition_id=GeoLite2-City'
  ```

### 第一次装（root）

1. 安装 `geoipupdate`（Debian 默认源里没有）：到 [GitHub 发布页](https://github.com/maxmind/geoipupdate/releases) 下载 `geoipupdate_<版本>_linux_amd64.deb` 与 `geoipupdate_<版本>_checksums.txt`，核对后安装：

   ```bash
   grep 'linux_amd64.deb$' geoipupdate_<版本>_checksums.txt | sha256sum -c -
   dpkg -i geoipupdate_<版本>_linux_amd64.deb
   ```

2. 写配置：照 [ops/GeoIP.conf.example](../ops/GeoIP.conf.example) 写 `/etc/GeoIP.conf`，`chmod 600 /etc/GeoIP.conf`
3. 建目录：`install -d -m 755 /var/lib/GeoIP`
4. 装定时器：把 [ops/geoipupdate.service](../ops/geoipupdate.service) 与 [ops/geoipupdate.timer](../ops/geoipupdate.timer) 放到 `/etc/systemd/system/`，然后

   ```bash
   systemctl daemon-reload
   systemctl enable --now geoipupdate.timer
   systemctl start geoipupdate.service   # 第一次下载（用掉 2 次额度）
   journalctl -u geoipupdate.service -n 20
   ```

5. 自检：`npx ip-geo doctor --maxmind /var/lib/GeoIP --ip2region <目录> --ip 8.8.8.8`
6. 应用的配置里把 MaxMind 数据目录指向 `/var/lib/GeoIP`

### 日常

- 定时器每周三、周六北京时间 04:00 跑（MaxMind 每周二、周五发布），随机延后最多 1 小时；停机错过的那一次开机补跑。`systemctl list-timers geoipupdate.timer` 看下一次
- `geoipupdate` 先比对哈希，没有新版本时不下载、不计额度；有新版本时写临时文件再改名
- **应用不用重启**：解析器每隔一个检查间隔（缺省 1 小时）看一眼文件的修改时间，变了就读新文件、校验通过才换上；校验不过继续用旧的并记一条错误日志
- **失败不重试**：服务刻意不设 `Restart`。`geoipupdate` 8.x 遇到第一个错误就停（它自己对网络错误有最长 5 分钟的重试），等下一次定时即可；切忌写循环重试：额度是滚动 24 小时 30 次，社区里有过因循环重试被封 24 小时的先例
- **条款要求新版发布后 30 天内销毁旧版**：定时器每周两次原地替换，自然满足。定时器坏了时，解析器在文件的构建日期超过 30 天（`maxDataAgeDays`）后**自动停用**它、从内存里丢掉，港澳台与海外的地点记降级（日后可补解析），每天报一条错误；文件换成新版后自动恢复。盘上的旧文件仍要人去处理，所以失败要有通知（见下）

### 监测

- **失败通知**：服务模板刻意不带通知（各人的通知渠道不同），用 systemd 的 `OnFailure=` 接到自己的通知上。做法是给服务加一个覆盖片段，不改模板本身：

  ```bash
  systemctl edit geoipupdate.service
  ```

  ```ini
  [Unit]
  OnFailure=geoipupdate-notify.service
  ```

  `geoipupdate-notify.service` 是自己写的一个 oneshot 服务，`ExecStart` 指向发通知的脚本（脚本里可以用 `journalctl -u geoipupdate.service -n 20 --no-pager` 取最近的输出放进通知）。验证：`systemctl start geoipupdate-notify.service` 手动触发一次

- `ip-geo doctor --maxmind /var/lib/GeoIP` 在数据超过 14 天没更新时打印「⚠️ … 检查定时更新」（`--warn-days` 可调），超过 30 天（`--max-age-days`，与解析器停用的上限相同）或文件缺失、打不开时以 1 退出
- 应用里可以读解析器的 `status()`：`maxmind.state` 为 `enabled` 时，`city` 与 `asn` 各自是 `ready`（带构建日期）或 `unavailable`（带原因）。应用启动时调一次 `ready()`，状态会写进日志

### 下线一台机器

停掉并删除定时器，删除 `/var/lib/GeoIP/*.mmdb` 与 `/etc/GeoIP.conf`（条款不允许数据留给第三方，凭据也不该留在不用的机器上）。

## 三、署名

两份数据的许可都要求署名，放在网站的隐私政策或统计页面的页脚：

- MaxMind：「This product includes GeoLite Data created by MaxMind, available from https://www.maxmind.com」
- ip2region：数据来自 [lionsoul2014/ip2region](https://github.com/lionsoul2014/ip2region)（Apache-2.0 / MIT）

## 四、排查

| 现象                                  | 先看                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 港澳台与海外全是 `ip2region-fallback` | 应用有没有传 MaxMind 目录；`status().maxmind.city` 的原因（含「已停用」：超过 30 天没更新）；`ls -l /var/lib/GeoIP`    |
| 海外的运营商不是 ASN 的组织名         | `status().maxmind.asn` 是否可用                                                                                        |
| 全部是 `none`                         | ip2region 数据文件在不在应用读的目录里（`ip-geo doctor --ip2region <目录>`）；应用日志里「ip2region 数据文件加载失败」 |
| 数据版本里是 `ip2region@sha256-…`     | 应用目录里的文件不是包清单那一版，重新 `ip-geo ip2region fetch`                                                        |
| `geoipupdate` 回 451                  | 见「前提：账户」                                                                                                       |
| `geoipupdate` 回 401                  | 账户 ID 或许可密钥写错，或密钥已作废                                                                                   |
