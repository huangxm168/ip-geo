/**
 * MaxMind GeoLite City 与 ASN 的加载、校验与重载
 *
 * - 第一次需要时把两个文件读进内存（City 约 51MB、ASN 约 9MB）
 * - 之后距上次检查满一个间隔（缺省 1 小时），查询时顺带看一眼两个文件的修改时间、大小、inode：
 *   变了就读新文件，**打开并校验通过才换上**；校验不过继续用旧的；文件不见了就丢掉旧版、转为不可用
 * - 不起定时器、不挂文件监听：进程能正常退出（常驻的监听会让 `next build` 的工作进程退不出去）
 *
 * 为什么不用 `maxmind` 包自带的 watchForUpdates：它的回调里读新文件、换进去没有任何错误处理，
 * 新文件坏了就成了未处理的异常（Node 缺省让进程直接退出）；换之前不校验；文件被删了静默保留旧版
 *
 * 检查是在查询里 await 的：平时只是两次 stat（微秒级），换版本那一次要读约 60MB（几十毫秒），
 * 同一时刻的其他查询等同一个检查，不会重复读
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Reader, type AsnResponse, type CityResponse } from "maxmind";

import type { MaxmindFileTag, MaxmindHit } from "../rules.js";
import type {
  GeoLogger,
  GeoResolverStatus,
  MaxmindFileStatus,
} from "../types.js";
import { errorMessage } from "./ip2region.js";

export const CITY_FILE = "GeoLite2-City.mmdb";
export const ASN_FILE = "GeoLite2-ASN.mmdb";

// 校验时查一下这个地址：能查（有没有结果都行）就说明树能走通
const PROBE_IP = "1.1.1.1";

type Edition = "City" | "ASN";

interface LoadedFile<T extends CityResponse | AsnResponse> {
  reader: Reader<T>;
  tag: MaxmindFileTag;
  status: MaxmindFileStatus;
  signature: string;
}

interface Loaded {
  city: LoadedFile<CityResponse>;
  asn: LoadedFile<AsnResponse>;
}

export class MaxmindSource {
  readonly #dir: string | null;
  readonly #intervalMs: number;
  readonly #logger: GeoLogger;
  #loaded: Loaded | null = null;
  #unavailableReason = "尚未加载";
  #lastCheckAt: number | null = null;
  #checking: Promise<void> | null = null;
  #lastReport: string | null = null;

  constructor(dir: string | null, intervalMs: number, logger: GeoLogger) {
    this.#dir = dir;
    this.#intervalMs = intervalMs;
    this.#logger = logger;
  }

  get enabled(): boolean {
    return this.#dir !== null;
  }

  /** 到点就先检查一次（同一时刻只检查一次），返回此刻可用的两个库；不可用时返回 null */
  async current(): Promise<Loaded | null> {
    if (this.#dir === null) return null;
    const due =
      this.#lastCheckAt === null ||
      Date.now() - this.#lastCheckAt >= this.#intervalMs;
    if (due) {
      this.#checking ??= this.#check(this.#dir).finally(() => {
        this.#lastCheckAt = Date.now();
        this.#checking = null;
      });
      await this.#checking;
    }
    return this.#loaded;
  }

  lookup(ip: string, loaded: Loaded): MaxmindHit {
    return {
      city: safeGet(loaded.city.reader, ip),
      asn: safeGet(loaded.asn.reader, ip),
      cityFile: loaded.city.tag,
      asnFile: loaded.asn.tag,
    };
  }

  status(): GeoResolverStatus["maxmind"] {
    if (this.#dir === null) return { state: "disabled" };
    if (!this.#loaded) {
      return { state: "unavailable", reason: this.#unavailableReason };
    }
    return {
      state: "ready",
      city: this.#loaded.city.status,
      asn: this.#loaded.asn.status,
    };
  }

  async #check(dir: string): Promise<void> {
    const city = await this.#refreshFile(
      join(dir, CITY_FILE),
      "City",
      this.#loaded?.city ?? null
    );
    const asn = await this.#refreshFile(
      join(dir, ASN_FILE),
      "ASN",
      this.#loaded?.asn ?? null
    );
    if (city.file && asn.file) {
      this.#loaded = {
        city: city.file as LoadedFile<CityResponse>,
        asn: asn.file as LoadedFile<AsnResponse>,
      };
      this.#report(
        "info",
        `MaxMind 可用：${describe(this.#loaded.city)}，${describe(this.#loaded.asn)}`
      );
    } else {
      this.#loaded = null;
      this.#unavailableReason = [city.problem, asn.problem]
        .filter(Boolean)
        .join("；");
      this.#report(
        "warn",
        `MaxMind 不可用，港澳台与海外先记粗结果：${this.#unavailableReason}`
      );
    }
    for (const problem of [city.kept, asn.kept]) {
      if (problem) this.#logger.error(problem);
    }
  }

  /**
   * 一个文件的检查：没变就沿用；变了就读新的、校验、换上；
   * 新文件不合格时沿用旧的（kept 里写原因）；文件不见了返回 problem
   */
  async #refreshFile(
    path: string,
    edition: Edition,
    previous: LoadedFile<CityResponse | AsnResponse> | null
  ): Promise<{
    file: LoadedFile<CityResponse | AsnResponse> | null;
    problem?: string;
    kept?: string;
  }> {
    let signature: string;
    try {
      const info = await stat(path);
      signature = `${String(info.mtimeMs)}:${String(info.size)}:${String(info.ino)}`;
    } catch {
      return { file: null, problem: `${path} 不存在` };
    }
    if (previous?.signature === signature) return { file: previous };

    try {
      const reader = new Reader<CityResponse | AsnResponse>(
        await readFile(path)
      );
      const tag = validate(reader, edition);
      return {
        file: {
          reader,
          tag,
          signature,
          status: {
            databaseType: reader.metadata.databaseType,
            buildDate: isoDate(reader.metadata.buildEpoch),
            loadedAt: new Date(),
          },
        },
      };
    } catch (err) {
      const reason = `${path} 无法使用：${errorMessage(err)}`;
      if (previous) {
        return {
          file: previous,
          kept: `${reason}；继续使用已加载的 ${describe(previous)}`,
        };
      }
      return { file: null, problem: reason };
    }
  }

  // 同一个状态只报一次：每小时检查一次，不该每次都刷一条
  #report(level: "info" | "warn", message: string) {
    if (this.#lastReport === message) return;
    this.#lastReport = message;
    this.#logger[level](message);
  }
}

// 数据库类型必须是「产品线-库」且库对得上（GeoLite2-City、GeoIP2-City、GeoLite2-ASN），并且能走通一次查询
function validate(
  reader: Reader<CityResponse | AsnResponse>,
  edition: Edition
): MaxmindFileTag {
  const type = reader.metadata.databaseType;
  const match = /^([A-Za-z0-9]+)-(City|ASN)$/.exec(type);
  if (match?.[2] !== edition || !match[1]) {
    throw new Error(`数据库类型是 ${type}，不是 ${edition} 库`);
  }
  reader.get(PROBE_IP);
  return {
    family: match[1],
    edition,
    date: isoDate(reader.metadata.buildEpoch).replaceAll("-", ""),
  };
}

function safeGet<T extends CityResponse | AsnResponse>(
  reader: Reader<T>,
  ip: string
): T | null {
  try {
    return reader.get(ip);
  } catch {
    return null;
  }
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function describe(file: LoadedFile<CityResponse | AsnResponse>): string {
  return `${file.status.databaseType}（构建于 ${file.status.buildDate}）`;
}
