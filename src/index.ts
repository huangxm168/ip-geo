/**
 * @huangxm168/ip-geo：IP 地区解析
 *
 * 中国境内用 ip2region，海外与港澳台用 MaxMind GeoLite 补齐城市与运营商。用法见 README，
 * 分流规则见 docs/rules.md
 */

export { createGeoResolver } from "./resolver.js";
export { isPublicIp, normalizeIp } from "./ip.js";
export { IP2REGION_FILE } from "./manifest.js";
export { ASN_FILE, CITY_FILE } from "./sources/maxmind.js";
export type {
  GeoLogger,
  GeoResolver,
  GeoResolverOptions,
  GeoResolverStatus,
  GeoResult,
  GeoSource,
  MaxmindFileStatus,
} from "./types.js";
