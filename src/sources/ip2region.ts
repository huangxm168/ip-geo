/**
 * ip2region 的加载与查询
 *
 * 首次查询时把整个数据文件读进内存（约 11MB，之后每次查询几到几十微秒）。读失败记一条错误，
 * 隔一个检查间隔再试，期间一律返回 null（调用方记为没有解析）
 *
 * 数据版本：文件的 sha256 与包里的清单一致时记 `ip2region@<提交号前 12 位>`；不一致（使用方没有按清单
 * 取用，或者自己换了文件）时照样能用，记 `ip2region@sha256-<前 12 位>` 并提醒一次
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IPv4, newWithBuffer, type Searcher } from "ip2region.js";

import { IP2REGION_FILE, readManifest } from "../manifest.js";
import type { Ip2regionRecord } from "../rules.js";
import type { GeoLogger } from "../types.js";

interface Loaded {
  searcher: Searcher;
  version: string;
  loadedAt: Date;
}

export class Ip2regionSource {
  readonly #path: string;
  readonly #retryMs: number;
  readonly #logger: GeoLogger;
  #loaded: Loaded | null = null;
  #failedAt: number | null = null;

  constructor(dir: string, retryMs: number, logger: GeoLogger) {
    this.#path = join(dir, IP2REGION_FILE);
    this.#retryMs = retryMs;
    this.#logger = logger;
  }

  /** 只接受 IPv4；查不到或数据不可用时返回 null */
  async search(ip: string): Promise<Ip2regionRecord | null> {
    const loaded = this.#load();
    if (!loaded) return null;
    // ⚠️ 类型声明写 search 返回 string，3.x 实际返回 Promise
    const raw = await Promise.resolve(loaded.searcher.search(ip));
    return parseRecord(raw);
  }

  /** 没加载就加载（失败后隔一个检查间隔才再试）；返回此刻是否可用 */
  ensureLoaded(): boolean {
    return this.#load() !== null;
  }

  get version(): string | null {
    return this.#loaded?.version ?? null;
  }

  status(): { version: string; loadedAt: Date } | null {
    return this.#loaded
      ? { version: this.#loaded.version, loadedAt: this.#loaded.loadedAt }
      : null;
  }

  #load(): Loaded | null {
    if (this.#loaded) return this.#loaded;
    if (
      this.#failedAt !== null &&
      Date.now() - this.#failedAt < this.#retryMs
    ) {
      return null;
    }
    try {
      const content = readFileSync(this.#path);
      const searcher = newWithBuffer(IPv4, content);
      this.#loaded = {
        searcher,
        version: this.#versionOf(content),
        loadedAt: new Date(),
      };
      this.#failedAt = null;
      this.#logger.info(`ip2region 已加载：${this.#loaded.version}`);
    } catch (err) {
      this.#failedAt = Date.now();
      this.#logger.error(
        `ip2region 数据文件加载失败（${this.#path}，用 ip-geo ip2region fetch 按清单取用），地区一律记为空：${errorMessage(err)}`
      );
    }
    return this.#loaded;
  }

  #versionOf(content: Buffer): string {
    const actual = createHash("sha256").update(content).digest("hex");
    try {
      const manifest = readManifest();
      if (manifest.sha256 === actual) {
        return `ip2region@${manifest.commit.slice(0, 12)}`;
      }
    } catch {
      // 清单读不到只影响版本号的写法
    }
    this.#logger.warn(
      `ip2region 数据文件与包里的清单不一致（sha256 ${actual.slice(0, 12)}…），照常使用；按清单取用请运行 ip-geo ip2region fetch`
    );
    return `ip2region@sha256-${actual.slice(0, 12)}`;
  }
}

/** 「国家|省|市|运营商|代码」拆成五段，`0` 与空串归一为 null */
export function parseRecord(raw: string): Ip2regionRecord {
  const [country, province, city, isp, iso] = raw.split("|").map(blankToNull);
  return {
    country: country ?? null,
    province: province ?? null,
    city: city ?? null,
    isp: isp ?? null,
    iso: iso ?? null,
  };
}

function blankToNull(value: string): string | null {
  return value && value !== "0" ? value : null;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
