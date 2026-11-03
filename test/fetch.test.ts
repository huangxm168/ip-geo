/**
 * ip2region 的取用与校验（不联网：用本地已取好的数据文件）
 */

import { lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { fetchIp2region, sha256, verifyIp2region } from "../src/fetch.js";
import { IP2REGION_FILE, readManifest } from "../src/manifest.js";
import { IP2REGION_DIR, tempDir } from "./helpers.js";

const log = () => {};
const content = () => readFileSync(join(IP2REGION_DIR, IP2REGION_FILE));

describe("清单与校验", () => {
  it("测试用的数据文件与清单一致", () => {
    const manifest = readManifest();
    expect(sha256(content())).toBe(manifest.sha256);
    expect(content().length).toBe(manifest.bytes);
  });

  it("哈希对得上、已知地址查得对：通过", async () => {
    await expect(verifyIp2region(content(), readManifest())).resolves.toBe(
      undefined
    );
  });

  it("与清单不符：失败", async () => {
    const changed = Buffer.from(content());
    changed.writeUInt8(
      changed.readUInt8(changed.length - 1) ^ 0xff,
      changed.length - 1
    );
    await expect(verifyIp2region(changed, readManifest())).rejects.toThrow(
      "与清单不符"
    );
  });

  it("不是 ip2region 数据：失败", async () => {
    await expect(verifyIp2region(Buffer.alloc(1024), null)).rejects.toThrow();
  });
});

describe("fetch", () => {
  it("目标已在且哈希一致：什么都不做", async () => {
    await expect(fetchIp2region({ dir: IP2REGION_DIR, log })).resolves.toBe(
      "present"
    );
  });

  it("缓存里已有：目标位置放软链，不联网", async () => {
    const dir = tempDir();
    const cacheDir = tempDir();
    const cached = join(cacheDir, `${readManifest().sha256}.xdb`);
    writeFileSync(cached, content());
    await expect(fetchIp2region({ dir, cacheDir, log })).resolves.toBe(
      "linked"
    );
    const target = join(dir, IP2REGION_FILE);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readlinkSync(target)).toBe(cached);
  });
});
