/**
 * ip2region 数据文件的取用与下载（命令行 `ip-geo ip2region fetch` 与维护脚本共用）
 *
 * 只认清单里固定的上游提交号与 sha256：同一个包版本无论在哪台机器取用几次，拿到的必然是同一份文件，
 * 拿不到就失败，不会拿到别的版本
 *
 * - 目标文件已在、哈希对得上：什么都不做（绝大多数情况，不联网）
 * - 给了缓存目录（部署用，放在各次发布之外、长期保留）：缓存里按哈希命名存一份，目标位置只放一个指向它的
 *   软链。只有换版本后的第一次要联网；回滚到旧发布时它的软链指向的旧文件还在
 * - 下载：每次限时 60 秒（连同读完响应体），网络出错才重试、最多 3 次；下载到之后先核对字节数与哈希，
 *   再用客户端库查一个已知地址，对得上才落盘（先写临时文件再改名，半截的文件不会被当成可用的）
 *
 * 缓存目录里的旧版本不自动删：保留的发布可能还链着它（一份 11MB、一季度一份，按需手工清理）
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { IPv4, newWithBuffer } from "ip2region.js";

import {
  IP2REGION_FILE,
  readManifest,
  type Ip2regionManifest,
} from "./manifest.js";
import { errorMessage } from "./sources/ip2region.js";

const UPSTREAM = "https://raw.githubusercontent.com/lionsoul2014/ip2region";
const ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 60_000;
// 南京信风的公共 DNS，归属多年未变
const PROBE_IP = "114.114.114.114";
const PROBE_EXPECTED = "中国|江苏省|南京市";

export type Log = (message: string) => void;

export interface FetchOptions {
  dir: string;
  cacheDir?: string | null | undefined;
  log: Log;
}

/** 按包里的清单把数据文件放到 `<dir>/ip2region_v4.xdb`；返回这一次做了什么 */
export async function fetchIp2region({
  dir,
  cacheDir,
  log,
}: FetchOptions): Promise<"present" | "downloaded" | "linked"> {
  const manifest = readManifest();
  const target = join(resolve(dir), IP2REGION_FILE);
  if (existsSync(target) && sha256(readFileSync(target)) === manifest.sha256) {
    log(`已就位（${manifest.commit.slice(0, 12)}）：${target}`);
    return "present";
  }

  mkdirSync(resolve(dir), { recursive: true });
  if (cacheDir) {
    const cacheRoot = resolve(cacheDir);
    mkdirSync(cacheRoot, { recursive: true });
    const cached = join(cacheRoot, `${manifest.sha256}.xdb`);
    if (
      !existsSync(cached) ||
      sha256(readFileSync(cached)) !== manifest.sha256
    ) {
      writeAtomically(
        cached,
        await downloadIp2region(manifest.commit, manifest, log)
      );
    }
    replaceWithSymlink(target, cached);
    log(`已链接到缓存 ${cached}`);
    return "linked";
  }

  writeAtomically(
    target,
    await downloadIp2region(manifest.commit, manifest, log)
  );
  log(`已下载（${manifest.commit.slice(0, 12)}）：${target}`);
  return "downloaded";
}

/** 下载某个上游提交的数据文件并校验；expected 为 null 时（换版本）没有哈希可核对，只做已知地址的查询校验 */
export async function downloadIp2region(
  commit: string,
  expected: Ip2regionManifest | null,
  log: Log
): Promise<Buffer> {
  const url = `${UPSTREAM}/${commit}/data/${IP2REGION_FILE}`;
  let content: Buffer | null = null;
  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS && !content; attempt += 1) {
    try {
      log(
        `下载 ${url}（第 ${String(attempt)} 次，限时 ${String(ATTEMPT_TIMEOUT_MS / 1000)}s）`
      );
      // 信号同时管住连接与读完响应体：线路卡住时不会一直挂着
      const response = await fetch(url, {
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      content = Buffer.from(await response.arrayBuffer());
    } catch (err) {
      lastError = err;
      log(`第 ${String(attempt)} 次未成功：${errorMessage(err)}`);
    }
  }
  if (!content) {
    throw new Error(
      `连续 ${String(ATTEMPTS)} 次取不到数据文件：${errorMessage(lastError)}`
    );
  }
  // 下载到了却对不上，重下也一样：不重试
  await verifyIp2region(content, expected);
  return content;
}

export async function verifyIp2region(
  content: Buffer,
  expected: Ip2regionManifest | null
): Promise<void> {
  if (expected) {
    const actual = sha256(content);
    if (content.length !== expected.bytes || actual !== expected.sha256) {
      throw new Error(
        `与清单不符：${String(content.length)} 字节、sha256 ${actual.slice(0, 12)}…`
      );
    }
  }
  // 查不出来或查错，说明格式与当前客户端库不匹配、或者数据坏了。
  // ⚠️ 类型声明写 search 返回 string，3.x 实际返回 Promise
  const probe = await Promise.resolve(
    newWithBuffer(IPv4, content).search(PROBE_IP)
  );
  if (!probe.startsWith(PROBE_EXPECTED)) {
    throw new Error(`校验失败：${PROBE_IP} 查得「${probe}」`);
  }
}

export function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function writeAtomically(path: string, content: Buffer): void {
  const temp = `${path}.tmp-${String(process.pid)}`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

function replaceWithSymlink(path: string, target: string) {
  if (existsSync(path) || isSymlink(path)) rmSync(path);
  symlinkSync(target, path);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
