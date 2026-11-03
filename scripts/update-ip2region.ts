/**
 * 维护者用：给 ip2region 换版本 —— npm run ip2region:update -- <40 位上游提交号>
 *
 * 到上游 lionsoul2014/ip2region 查 data/ip2region_v4.xdb 最近一次提交，下载那个提交的文件、用一个已知地址
 * 校验，通过才重写 data/ip2region.json；数据文件顺带放到 test/.data/ip2region/ 供测试用（不进 Git）。
 * 提交清单、发一个新版本，各网站升级依赖后重新取用即可
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { downloadIp2region, sha256, writeAtomically } from "../src/fetch.js";
import { IP2REGION_FILE, MANIFEST_PATH } from "../src/manifest.js";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const TEST_DATA_DIR = "test/.data/ip2region";

const commit = process.argv[2];
if (!commit || !COMMIT_PATTERN.test(commit)) {
  console.error("用法：npm run ip2region:update -- <40 位上游提交号>");
  process.exit(1);
}

const log = (message: string) => {
  console.log(`[ip2region] ${message}`);
};
const content = await downloadIp2region(commit, null, log);
mkdirSync(TEST_DATA_DIR, { recursive: true });
writeAtomically(join(TEST_DATA_DIR, IP2REGION_FILE), content);
const manifest = {
  commit,
  sha256: sha256(content),
  bytes: content.length,
  updatedAt: new Date().toISOString(),
};
writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
log(
  `清单已更新（${(content.length / 1024 / 1024).toFixed(1)}MB，sha256 ${manifest.sha256.slice(0, 12)}…）。提交 data/ip2region.json、在 CHANGELOG 记一笔再发版`
);
