/**
 * 分流规则（纯函数）：把 ip2region 与 MaxMind 各自查到的东西合成一条结果
 *
 * 1. 国内外只按 ip2region 判：MaxMind 对国内 IP 的城市不准，不能反过来让它判
 * 2. 中国大陆：一律取 ip2region（省、市、运营商），不查 MaxMind
 * 3. 港澳台：国家、省一级、运营商取 ip2region；城市取 MaxMind City（它判的国家也是港澳台那一个时才采用）；
 *    ip2region 没有运营商时用 MaxMind ASN 的网络运营商名补上
 * 4. 海外：国家按 ip2region 的代码、取简体中文名；MaxMind City 判的国家与之一致时，省 / 州、城市取 MaxMind；
 *    运营商取 MaxMind ASN，没有再用 ip2region 的
 * 5. MaxMind 不可用：港澳台与海外先记 ip2region 的粗结果，来源标 `ip2region-fallback`，日后可以补解析
 *
 * 规则的来龙去脉与例子见 docs/rules.md；每一条都由 test/rules.test.ts 钉住
 */

import type { AsnResponse, CityResponse } from "maxmind";

import { countryNameZh, pickName, SPECIAL_REGIONS } from "./names.js";
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

/** MaxMind 可用时这一次查询的结果；不可用时整个为 null */
export interface MaxmindHit {
  city: CityResponse | null;
  asn: AsnResponse | null;
  cityFile: MaxmindFileTag;
  asnFile: MaxmindFileTag;
}

export interface ResolveInput {
  ip2region: Ip2regionRecord;
  ip2regionVersion: string;
  maxmind: MaxmindHit | null;
}

export function resolveGeo({
  ip2region,
  ip2regionVersion,
  maxmind,
}: ResolveInput): GeoResult {
  const { country, province, city, isp, iso } = ip2region;

  if (iso === "CN") {
    const special = province ? SPECIAL_REGIONS[province] : undefined;
    if (!special) {
      return {
        countryCode: "CN",
        countryName: "中国",
        region: province,
        city,
        isp,
        source: "ip2region",
        version: ip2regionVersion,
      };
    }

    // 港澳台
    if (!maxmind) {
      return {
        countryCode: special.code,
        countryName: special.name,
        region: province,
        city: null,
        isp,
        source: "ip2region-fallback",
        version: ip2regionVersion,
      };
    }
    const used: MaxmindFileTag[] = [];
    const mmCity = sameCountry(maxmind.city, special.code)
      ? pickName(maxmind.city?.city?.names)
      : null;
    if (mmCity) used.push(maxmind.cityFile);
    let finalIsp = isp;
    if (!finalIsp) {
      finalIsp = maxmind.asn?.autonomous_system_organization ?? null;
      if (finalIsp) used.push(maxmind.asnFile);
    }
    return {
      countryCode: special.code,
      countryName: special.name,
      region: province,
      city: mmCity,
      isp: finalIsp,
      source: mmCity ? "ip2region+maxmind" : "ip2region",
      version: joinVersion(ip2regionVersion, used),
    };
  }

  // 海外
  const countryName = (iso && countryNameZh(iso)) ?? country;
  if (!maxmind) {
    return {
      countryCode: iso,
      countryName,
      region: province,
      city,
      isp,
      source: "ip2region-fallback",
      version: ip2regionVersion,
    };
  }
  const used: MaxmindFileTag[] = [];
  const located = iso !== null && sameCountry(maxmind.city, iso);
  let region = province;
  let finalCity = city;
  if (located) {
    region = pickName(maxmind.city?.subdivisions?.[0]?.names) ?? province;
    finalCity = pickName(maxmind.city?.city?.names) ?? city;
    used.push(maxmind.cityFile);
  }
  const asnIsp = maxmind.asn?.autonomous_system_organization ?? null;
  if (asnIsp) used.push(maxmind.asnFile);
  return {
    countryCode: iso,
    countryName,
    region,
    city: finalCity,
    isp: asnIsp ?? isp,
    source: located ? "maxmind" : "ip2region",
    version: joinVersion(ip2regionVersion, used),
  };
}

// MaxMind City 判的国家与 ip2region 一致才采用它的地点，否则会出现「美国 · 东京」
function sameCountry(record: CityResponse | null, code: string): boolean {
  return record?.country?.iso_code === code;
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
