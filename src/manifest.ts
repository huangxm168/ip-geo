/**
 * ip2region 数据清单：随包发版的 data/ip2region.json
 *
 * 只记上游提交号、sha256 与字节数，数据文件本身不进包（约 11MB、按季度换版本），
 * 由 `ip-geo ip2region fetch` 按清单取用。维护者用 `npm run ip2region:update -- <提交号>` 换版本
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Ip2regionManifest {
  /** 上游 lionsoul2014/ip2region 的 40 位提交号 */
  commit: string;
  sha256: string;
  bytes: number;
  updatedAt: string;
}

/** 清单的位置：src/ 与 dist/ 都在包根目录下一层，所以同一个相对路径两边都对 */
export const MANIFEST_PATH = fileURLToPath(
  new URL("../data/ip2region.json", import.meta.url)
);

export const IP2REGION_FILE = "ip2region_v4.xdb";

export function readManifest(): Ip2regionManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Ip2regionManifest;
}
