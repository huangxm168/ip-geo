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

const consoleLogger: GeoLogger = {
  info: (message) => {
    console.info(`[ip-geo] ${message}`);
  },
  warn: (message) => {
    console.warn(`[ip-geo] ${message}`);
  },
  error: (message) => {
    console.error(`[ip-geo] ${message}`);
  },
};

export function createGeoResolver(options: GeoResolverOptions): GeoResolver {
  const logger = options.logger ?? consoleLogger;
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
      try {
        if (!rawIp) return { ...NONE };
        const ip = normalizeIp(rawIp);
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
            logger.error(
              `查询 ${ip} 时 MaxMind 出错，按不可用处理：${errorMessage(err)}`
            );
          }
        }
        return resolveGeo({
          ip2region: record,
          ip2regionVersion: version,
          ...hit,
        });
      } catch (err) {
        logger.error(
          `查询 ${String(rawIp)} 时出错，记为空：${errorMessage(err)}`
        );
        return { ...NONE };
      }
    },

    async ready() {
      try {
        ip2region.ensureLoaded();
        await maxmind.current();
      } catch (err) {
        logger.error(`加载数据时出错：${errorMessage(err)}`);
      }
      return status();
    },

    status,
  };
}
