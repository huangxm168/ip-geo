/**
 * MaxMind GeoLite City 与 ASN 的加载、校验、重载与过期停用
 *
 * - 第一次需要时把两个文件读进内存（City 约 51MB、ASN 约 9MB）。**两个库各自独立**：一个缺失、损坏或过期，
 *   另一个照常可用（City 对账户有限制、ASN 没有，两者的可得性本来就不同）
 * - 之后距上次检查满一个间隔（缺省 1 小时），查询时顺带看一眼文件的修改时间、大小、inode：
 *   变了就读新文件，**打开并校验通过才换上**；校验不过继续用旧的；文件不见了就丢掉旧版、转为不可用
 * - 构建日期超过上限（缺省 30 天，GeoLite 条款要求新版发布后 30 天内换掉旧版）就停用、从内存里丢掉，
 *   每天报一条错误；文件换成新版后自动恢复。停用期间港澳台与海外记降级，日后可以补解析
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

import type { MaxmindFileTag, MaxmindLookup } from "../rules.js";
import type {
  GeoLogger,
  GeoResolverStatus,
  MaxmindFileState,
  MaxmindFileStatus,
} from "../types.js";
import { errorMessage } from "./ip2region.js";

export const CITY_FILE = "GeoLite2-City.mmdb";
export const ASN_FILE = "GeoLite2-ASN.mmdb";
/** 构建日期的缺省上限（天）：GeoLite 条款要求新版发布后 30 天内换掉旧版 */
export const DEFAULT_MAX_DATA_AGE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
// 校验时查一下这个地址：能查（有没有结果都行）就说明树能走通
const PROBE_IP = "1.1.1.1";

type Edition = "City" | "ASN";
type Response = CityResponse | AsnResponse;

interface LoadedFile {
  reader: Reader<Response>;
  tag: MaxmindFileTag;
  status: MaxmindFileStatus;
  buildEpoch: Date;
  signature: string;
}

/** 一个库的槽位：可用的文件，或不可用的原因；过期停用的文件只记签名，没换新版就不必重读 */
interface Slot {
  file: LoadedFile | null;
  reason: string;
  stale: { signature: string; buildEpoch: Date; path: string } | null;
}

/** 此刻可用的两个库，各自可能为 null */
export interface MaxmindFiles {
  city: LoadedFile | null;
  asn: LoadedFile | null;
}

export class MaxmindSource {
  readonly #dir: string | null;
  readonly #intervalMs: number;
  readonly #maxAgeMs: number | null;
  readonly #logger: GeoLogger;
  readonly #slots: Record<Edition, Slot> = {
    City: { file: null, reason: "尚未加载", stale: null },
    ASN: { file: null, reason: "尚未加载", stale: null },
  };
  #lastCheckAt: number | null = null;
  #checking: Promise<void> | null = null;
  #lastReport: string | null = null;

  constructor(
    dir: string | null,
    intervalMs: number,
    maxAgeDays: number | null,
    logger: GeoLogger
  ) {
    this.#dir = dir;
    this.#intervalMs = intervalMs;
    this.#maxAgeMs = maxAgeDays ? maxAgeDays * DAY_MS : null;
    this.#logger = logger;
  }

  /** 到点就先检查一次（同一时刻只检查一次），返回此刻可用的两个库 */
  async current(): Promise<MaxmindFiles> {
    if (this.#dir === null) return { city: null, asn: null };
    // 时钟被往回校过（距上次检查成了负数）也算到点，否则要等时钟追回来才再检查
    const elapsed =
      this.#lastCheckAt === null ? null : Date.now() - this.#lastCheckAt;
    const due = elapsed === null || elapsed < 0 || elapsed >= this.#intervalMs;
    if (due) {
      this.#checking ??= this.#check(this.#dir).finally(() => {
        this.#lastCheckAt = Date.now();
        this.#checking = null;
      });
      await this.#checking;
    }
    return { city: this.#slots.City.file, asn: this.#slots.ASN.file };
  }

  lookup(
    ip: string,
    files: MaxmindFiles
  ): {
    city: MaxmindLookup<CityResponse> | null;
    asn: MaxmindLookup<AsnResponse> | null;
  } {
    return {
      city: files.city && {
        record: safeGet(files.city.reader, ip) as CityResponse | null,
        file: files.city.tag,
      },
      asn: files.asn && {
        record: safeGet(files.asn.reader, ip) as AsnResponse | null,
        file: files.asn.tag,
      },
    };
  }

  status(): GeoResolverStatus["maxmind"] {
    if (this.#dir === null) return { state: "disabled" };
    return {
      state: "enabled",
      city: slotState(this.#slots.City),
      asn: slotState(this.#slots.ASN),
    };
  }

  async #check(dir: string): Promise<void> {
    const kept: string[] = [];
    for (const [edition, file] of [
      ["City", CITY_FILE],
      ["ASN", ASN_FILE],
    ] as const) {
      const problem = await this.#refresh(join(dir, file), edition);
      if (problem) kept.push(problem);
    }
    for (const problem of kept) this.#logger.error(problem);

    const { City: city, ASN: asn } = this.#slots;
    const describeSlot = (edition: Edition, slot: Slot) =>
      slot.file
        ? `${edition} 可用：${describe(slot.file)}`
        : `${edition} 不可用：${slot.reason}`;
    const level =
      city.stale || asn.stale
        ? "error"
        : city.file && asn.file
          ? "info"
          : "warn";
    this.#report(
      level,
      `MaxMind ${describeSlot("City", city)}；${describeSlot("ASN", asn)}` +
        (city.file ? "" : "。港澳台与海外的地点先记粗结果，日后可以补解析")
    );
  }

  /**
   * 一个库的检查：没变就沿用；变了就读新的、校验、换上；新文件不合格时沿用旧的（返回要记的错误）；
   * 文件不见了、打不开或过期时槽位清空并写明原因
   */
  async #refresh(path: string, edition: Edition): Promise<string | null> {
    const slot = this.#slots[edition];
    let signature: string;
    try {
      const info = await stat(path);
      signature = `${String(info.mtimeMs)}:${String(info.size)}:${String(info.ino)}`;
    } catch {
      this.#clear(slot, `${path} 不存在`);
      return null;
    }

    let kept: string | null = null;
    if (slot.stale?.signature === signature) {
      // 过期停用的那一份还没换：不必重读，只更新天数
      this.#clear(
        slot,
        this.#staleReason(slot.stale.path, slot.stale.buildEpoch),
        slot.stale
      );
      return null;
    }
    if (slot.file?.signature !== signature) {
      try {
        const reader = new Reader<Response>(await readFile(path));
        const tag = validate(reader, edition);
        slot.file = {
          reader,
          tag,
          signature,
          buildEpoch: reader.metadata.buildEpoch,
          status: {
            databaseType: reader.metadata.databaseType,
            buildDate: isoDate(reader.metadata.buildEpoch),
            loadedAt: new Date(),
          },
        };
      } catch (err) {
        const reason = `${path} 无法使用：${errorMessage(err)}`;
        if (slot.file) {
          kept = `${reason}；继续使用已加载的 ${describe(slot.file)}`;
        } else {
          this.#clear(slot, reason);
          return null;
        }
      }
    }

    // 已加载的文件也会随时间过期，所以每次检查都要看
    const file = slot.file;
    if (this.#isTooOld(file.buildEpoch)) {
      this.#clear(slot, this.#staleReason(path, file.buildEpoch), {
        signature: file.signature,
        buildEpoch: file.buildEpoch,
        path,
      });
      return kept;
    }
    slot.stale = null;
    return kept;
  }

  #clear(slot: Slot, reason: string, stale: Slot["stale"] = null) {
    slot.file = null;
    slot.reason = reason;
    slot.stale = stale;
  }

  #isTooOld(buildEpoch: Date): boolean {
    return (
      this.#maxAgeMs !== null &&
      Date.now() - buildEpoch.getTime() > this.#maxAgeMs
    );
  }

  // 天数每天变一次，所以这条错误每天报一次
  #staleReason(path: string, buildEpoch: Date): string {
    const days = Math.floor((Date.now() - buildEpoch.getTime()) / DAY_MS);
    const limit = String(Math.round((this.#maxAgeMs ?? 0) / DAY_MS));
    return `${path} 构建于 ${isoDate(buildEpoch)}，已 ${String(days)} 天未更新，超过 ${limit} 天已停用（GeoLite 条款要求新版发布后 30 天内换掉旧版，检查 geoipupdate 定时器）`;
  }

  // 同一个状态只报一次：每小时检查一次，不该每次都刷一条
  #report(level: "info" | "warn" | "error", message: string) {
    if (this.#lastReport === message) return;
    this.#lastReport = message;
    this.#logger[level](message);
  }
}

function slotState(slot: Slot): MaxmindFileState {
  return slot.file
    ? { state: "ready", ...slot.file.status }
    : { state: "unavailable", reason: slot.reason };
}

// 数据库类型必须是「产品线-库」且库对得上（GeoLite2-City、GeoIP2-City、GeoLite2-ASN），并且能走通一次查询
function validate(reader: Reader<Response>, edition: Edition): MaxmindFileTag {
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

function safeGet(reader: Reader<Response>, ip: string): Response | null {
  try {
    return reader.get(ip);
  } catch {
    return null;
  }
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function describe(file: LoadedFile): string {
  return `${file.status.databaseType}（构建于 ${file.status.buildDate}）`;
}
