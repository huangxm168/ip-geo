/**
 * 分流规则（纯函数）：把 ip2region 与 MaxMind 各自查到的东西合成一条结果
 *
 * 1. 国内外的边界只按 ip2region 判：MaxMind 对国内 IP 不准，不能反过来让它判
 * 2. 中国大陆：一律取 ip2region（省、市、运营商），不查 MaxMind
 * 3. 港澳台：国家、省一级、运营商取 ip2region；城市取 MaxMind City（它判的也是港澳台那一地时才采用）；
 *    ip2region 没有运营商时用 MaxMind ASN 的网络运营商名补上
 * 4. 海外：一个地点只取一家，不跨来源拼层级。MaxMind City 有国家以下的地点（州或城市至少一个）、且它判的
 *    国家不在中国大陆与港澳台之内时，国家、州、城市整套取 MaxMind；否则整套取 ip2region。
 *    运营商取 MaxMind ASN，没有再用 ip2region 的
 * 5. City 与 ASN 各自独立：City 不可用时地点记 ip2region 的粗结果、来源标 `ip2region-fallback`（日后可以补解析），
 *    ASN 照常补运营商；ASN 不可用时运营商用 ip2region 的
 * 6. MaxMind 的地名一律取英文：英文名每一条都有、跨数据版本不变，与 ip2region 的海外地名同一种写法，
 *    按州 / 城市汇总时两种来源的行能合在一起
 *
 * 规则的来龙去脉与例子见 docs/rules.md；每一条都由 test/rules.test.ts 钉住
 */

import type { AsnResponse, CityResponse } from "maxmind";

import { countryNameZh, englishName, SPECIAL_REGIONS } from "./names.js";
import type { GeoResult } from "./types.js";

/** ip2region 一条结果拆开后的五段，`0` 已归一为 null */
export interface Ip2regionRecord {
  country: string | null;
  province: string | null;
  city: string | null;
  isp: string | null;
  /** ISO 3166-1 两位代码；港澳台在 ip2region 里也是 CN */
  iso: string | null;
}

/** 一个 MaxMind 数据文件的身份，用来拼数据版本 */
export interface MaxmindFileTag {
  /** 产品线，如 GeoLite2 */
  family: string;
  /** 库，如 City / ASN */
  edition: string;
  /** 构建日期，YYYYMMDD */
  date: string;
}

/** 一个可用的 MaxMind 库对这个 IP 的查询结果（record 为 null 表示查过了、库里没有） */
export interface MaxmindLookup<T> {
  record: T | null;
  file: MaxmindFileTag;
}

export interface ResolveInput {
  ip2region: Ip2regionRecord;
  ip2regionVersion: string;
  /** City 库不可用（没配目录、文件缺失、打不开、过期停用）时为 null */
  city: MaxmindLookup<CityResponse> | null;
  /** ASN 库不可用时为 null */
  asn: MaxmindLookup<AsnResponse> | null;
}

// MaxMind 判到这几个地方时与 ip2region 划的边界冲突，以 ip2region 为准
const CHINA_CODES = new Set(["CN", "HK", "MO", "TW"]);

export function resolveGeo({
  ip2region,
  ip2regionVersion,
  city,
  asn,
}: ResolveInput): GeoResult {
  const { country, province, isp, iso } = ip2region;

  if (iso === "CN") {
    const special = province ? SPECIAL_REGIONS[province] : undefined;
    if (!special) {
      return {
        countryCode: "CN",
        countryName: "中国",
        region: province,
        city: ip2region.city,
        isp,
        source: "ip2region",
        version: ip2regionVersion,
      };
    }

    // 港澳台
    const used: MaxmindFileTag[] = [];
    const mmCity =
      city?.record?.country?.iso_code === special.code
        ? englishName(city.record.city?.names)
        : null;
    if (city && mmCity) used.push(city.file);
    const finalIsp = isp ?? asnOrganization(asn, used);
    return {
      countryCode: special.code,
      countryName: special.name,
      region: province,
      city: mmCity,
      isp: finalIsp,
      source: !city
        ? "ip2region-fallback"
        : mmCity
          ? "ip2region+maxmind"
          : "ip2region",
      version: joinVersion(ip2regionVersion, used),
    };
  }

  // 海外
  const used: MaxmindFileTag[] = [];
  const located = city ? maxmindLocation(city.record) : null;
  if (city && located) used.push(city.file);
  const location = located ?? {
    countryCode: iso,
    countryName: (iso && countryNameZh(iso)) ?? country,
    region: province,
    city: ip2region.city,
  };
  // 运营商与地点分开取：ASN 有就用 ASN 的
  const finalIsp = asnOrganization(asn, used) ?? isp;
  return {
    ...location,
    isp: finalIsp,
    source: !city ? "ip2region-fallback" : located ? "maxmind" : "ip2region",
    version: joinVersion(ip2regionVersion, used),
  };
}

// MaxMind 的地点整套可用的条件：有国家以下的地点，且国家不在 ip2region 管的范围里
function maxmindLocation(record: CityResponse | null) {
  const code = record?.country?.iso_code;
  if (!record || !code || CHINA_CODES.has(code)) return null;
  const region = englishName(record.subdivisions?.[0]?.names);
  const cityName = englishName(record.city?.names);
  if (!region && !cityName) return null;
  return {
    countryCode: code,
    countryName:
      countryNameZh(code) ?? englishName(record.country.names) ?? code,
    region,
    city: cityName,
  };
}

function asnOrganization(
  asn: MaxmindLookup<AsnResponse> | null,
  used: MaxmindFileTag[]
): string | null {
  const organization = asn?.record?.autonomous_system_organization ?? null;
  if (asn && organization) used.push(asn.file);
  return organization;
}

// 数据版本：ip2region 一段，MaxMind 按产品线各一段，如 `ip2region@6a276cc7c4f9 GeoLite2@City-20261030+ASN-20261103`
function joinVersion(ip2regionVersion: string, used: MaxmindFileTag[]): string {
  const byFamily = new Map<string, string[]>();
  for (const file of used) {
    const parts = byFamily.get(file.family) ?? [];
    parts.push(`${file.edition}-${file.date}`);
    byFamily.set(file.family, parts);
  }
  return [
    ip2regionVersion,
    ...[...byFamily].map(([family, parts]) => `${family}@${parts.join("+")}`),
  ].join(" ");
}
