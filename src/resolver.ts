/**
 * 解析器：把两类数据与分流规则接起来，对外只有「查一个 IP」「加载并看状态」「看状态」
 *
 * 网站在进程里建一个就够（两类数据都在内存里，建多个就多占多份）
 */

import { isIP } from "node:net";

import { isPublicIp, normalizeIp } from "./ip.js";
import { SPECIAL_REGIONS } from "./names.js";
import { resolveGeo } from "./rules.js";
import { errorMessage, Ip2regionSource } from "./sources/ip2region.js";
import { DEFAULT_MAX_DATA_AGE_DAYS, MaxmindSource } from "./sources/maxmind.js";
import type {
  GeoLogEvent,
  GeoLogger,
  GeoResolver,
  GeoResolverOptions,
  GeoResult,
} from "./types.js";

const DEFAULT_RECHECK_MS = 60 * 60 * 1000;

const NONE: GeoResult = Object.freeze({
  countryCode: null,
  countryName: null,
  region: null,
  city: null,
  isp: null,
  source: "none",
  version: null,
});

// 缺省只打说明文字：查询出错时的 IP 与异常（消息里可能带着 IP）都不打
const consoleLogger: GeoLogger = {
  info: (event) => {
    console.info(`[ip-geo] ${event.message}`);
  },
  warn: (event) => {
    console.warn(`[ip-geo] ${event.message}`);
  },
  error: (event) => {
    console.error(`[ip-geo] ${event.message}`);
  },
};

// 使用方的 logger 抛错不能连累查询（lookup 与 ready 承诺永不抛错）：那一条改由 console 打出说明文字，
// console 也出错就作罢。不兜住的话，抛错会从查询里冒出去，ip2region 还会把「已加载」误记成加载失败
function guarded(logger: GeoLogger): GeoLogger {
  const call =
    (level: keyof GeoLogger) =>
    (event: GeoLogEvent): void => {
      try {
        logger[level](event);
      } catch {
        try {
          consoleLogger[level](event);
        } catch {
          // 无处可写
        }
      }
    };
  return { info: call("info"), warn: call("warn"), error: call("error") };
}

export function createGeoResolver(options: GeoResolverOptions): GeoResolver {
  const logger = guarded(options.logger ?? consoleLogger);
  const intervalMs = Math.max(
    0,
    options.recheckIntervalMs ?? DEFAULT_RECHECK_MS
  );
  const maxAgeDays =
    options.maxDataAgeDays === undefined
      ? DEFAULT_MAX_DATA_AGE_DAYS
      : options.maxDataAgeDays;
  const ip2region = new Ip2regionSource(
    options.ip2regionDir,
    intervalMs,
    logger
  );
  const maxmind = new MaxmindSource(
    options.maxmindDir || null,
    intervalMs,
    maxAgeDays && maxAgeDays > 0 ? maxAgeDays : null,
    logger
  );

  const status = () => ({
    ip2region: ip2region.status(),
    maxmind: maxmind.status(),
  });

  return {
    async lookup(rawIp) {
      // 出错时报规整后的写法：之后各步（含 ip2region 的报错）用的都是它，使用方才能按 ip 字段抹掉异常里的 IP
      let ip: string | null = null;
      try {
        if (!rawIp) return { ...NONE };
        ip = normalizeIp(rawIp);
        // 只放了 IPv4 的 ip2region 数据；国内外又只能靠它判，所以 IPv6 一律记为空
        if (isIP(ip) !== 4 || !isPublicIp(ip)) return { ...NONE };

        const record = await ip2region.search(ip);
        const version = ip2region.version;
        if (!record || !version || (!record.country && !record.iso)) {
          return { ...NONE };
        }

        // 中国大陆不查 MaxMind
        const mainland =
          record.iso === "CN" &&
          !(record.province && SPECIAL_REGIONS[record.province]);
        let hit: ReturnType<MaxmindSource["lookup"]> = {
          city: null,
          asn: null,
        };
        if (!mainland) {
          // MaxMind 这一段出了意外就当它不可用：结果记降级、日后还能补解析，而不是整条记为空
          try {
            hit = maxmind.lookup(ip, await maxmind.current());
          } catch (err) {
            // 出错的只会是文件检查（逐条查库的错误已在 MaxmindSource 里接住），与 IP 无关，不带它
            logger.error({
              code: "maxmind_lookup_failed",
              message: "查询时检查 MaxMind 文件出错，这一条按不可用处理",
              error: err,
            });
          }
        }
        return resolveGeo({
          ip2region: record,
          ip2regionVersion: version,
          ...hit,
        });
      } catch (err) {
        logger.error({
          code: "lookup_failed",
          message: "查询时出错，这一条记为空",
          ip: ip ?? String(rawIp),
          error: err,
        });
        return { ...NONE };
      }
    },

    async ready() {
      try {
        ip2region.ensureLoaded();
        await maxmind.current();
      } catch (err) {
        logger.error({
          code: "load_failed",
          message: `加载数据时出错：${errorMessage(err)}`,
          error: err,
        });
      }
      return status();
    },

    status,
  };
}
