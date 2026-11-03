/**
 * 分流规则逐条（纯函数，手工构造两边的结果，覆盖测试库里没有的港澳台等情形）
 */

import type { AsnResponse, CityResponse } from "maxmind";
import { describe, expect, it } from "vitest";

import {
  resolveGeo,
  type Ip2regionRecord,
  type MaxmindHit,
} from "../src/rules.js";

const V = "ip2region@aaaaaaaaaaaa";
const CITY = { family: "GeoLite2", edition: "City", date: "20261030" };
const ASN = { family: "GeoLite2", edition: "ASN", date: "20261103" };

function record(parts: Partial<Ip2regionRecord>): Ip2regionRecord {
  return {
    country: null,
    province: null,
    city: null,
    isp: null,
    iso: null,
    ...parts,
  };
}

function city(
  iso: string,
  cityNames?: { "zh-CN"?: string; en: string },
  subdivision?: { "zh-CN"?: string; en: string }
): CityResponse {
  return {
    country: { iso_code: iso, geoname_id: 1, names: { en: iso } },
    ...(cityNames ? { city: { geoname_id: 2, names: cityNames } } : {}),
    ...(subdivision
      ? { subdivisions: [{ iso_code: "X", geoname_id: 3, names: subdivision }] }
      : {}),
  };
}

function asn(org: string): AsnResponse {
  return { autonomous_system_number: 1, autonomous_system_organization: org };
}

function hit(c: CityResponse | null, a: AsnResponse | null): MaxmindHit {
  return { city: c, asn: a, cityFile: CITY, asnFile: ASN };
}

describe("中国大陆", () => {
  it("一律取 ip2region，不看 MaxMind", () => {
    const result = resolveGeo({
      ip2region: record({
        country: "中国",
        province: "江苏省",
        city: "南京市",
        isp: "电信",
        iso: "CN",
      }),
      ip2regionVersion: V,
      maxmind: hit(city("PH", { en: "Manila" }), asn("Someone")),
    });
    expect(result).toEqual({
      countryCode: "CN",
      countryName: "中国",
      region: "江苏省",
      city: "南京市",
      isp: "电信",
      source: "ip2region",
      version: V,
    });
  });
});

describe("港澳台", () => {
  const hk = record({
    country: "中国",
    province: "香港特别行政区",
    iso: "CN",
  });

  it("城市取 MaxMind，运营商为空时用 ASN 补", () => {
    const result = resolveGeo({
      ip2region: hk,
      ip2regionVersion: V,
      maxmind: hit(
        city("HK", { "zh-CN": "九龙湾", en: "Kowloon Bay" }),
        asn("Example Network Ltd.")
      ),
    });
    expect(result).toEqual({
      countryCode: "HK",
      countryName: "中国香港",
      region: "香港特别行政区",
      city: "九龙湾",
      isp: "Example Network Ltd.",
      source: "ip2region+maxmind",
      version: `${V} GeoLite2@City-20261030+ASN-20261103`,
    });
  });

  it("ip2region 有运营商时保留它，不用 ASN", () => {
    const result = resolveGeo({
      ip2region: { ...hk, province: "澳门特别行政区", isp: "澳门电讯" },
      ip2regionVersion: V,
      maxmind: hit(city("MO", { en: "Macau" }), asn("CTM")),
    });
    expect(result.isp).toBe("澳门电讯");
    expect(result.city).toBe("Macau");
    expect(result.version).toBe(`${V} GeoLite2@City-20261030`);
  });

  it("MaxMind 判的国家对不上就不采用它的城市", () => {
    const result = resolveGeo({
      ip2region: { ...hk, province: "台湾省" },
      ip2regionVersion: V,
      maxmind: hit(city("JP", { en: "Tokyo" }), null),
    });
    expect(result).toMatchObject({
      countryCode: "TW",
      countryName: "中国台湾",
      city: null,
      source: "ip2region",
      version: V,
    });
  });

  it("MaxMind 查过但没有城市：来源记 ip2region（不再补解析）", () => {
    const result = resolveGeo({
      ip2region: hk,
      ip2regionVersion: V,
      maxmind: hit(null, null),
    });
    expect(result.source).toBe("ip2region");
  });

  it("MaxMind 不可用：记降级", () => {
    const result = resolveGeo({
      ip2region: { ...hk, isp: "某运营商" },
      ip2regionVersion: V,
      maxmind: null,
    });
    expect(result).toEqual({
      countryCode: "HK",
      countryName: "中国香港",
      region: "香港特别行政区",
      city: null,
      isp: "某运营商",
      source: "ip2region-fallback",
      version: V,
    });
  });
});

describe("海外", () => {
  const jp = record({
    country: "Japan",
    province: "Tokyo",
    isp: "KDDI CORPORATION",
    iso: "JP",
  });

  it("国家一致：省 / 州与城市取 MaxMind（中文优先），运营商取 ASN", () => {
    const result = resolveGeo({
      ip2region: jp,
      ip2regionVersion: V,
      maxmind: hit(
        city("JP", { en: "Chiyoda" }, { "zh-CN": "东京都", en: "Tokyo" }),
        asn("KDDI CORPORATION (ASN)")
      ),
    });
    expect(result).toEqual({
      countryCode: "JP",
      countryName: "日本",
      region: "东京都",
      city: "Chiyoda",
      isp: "KDDI CORPORATION (ASN)",
      source: "maxmind",
      version: `${V} GeoLite2@City-20261030+ASN-20261103`,
    });
  });

  it("MaxMind 缺的那一栏用 ip2region 补", () => {
    const result = resolveGeo({
      ip2region: record({
        country: "United States",
        province: "California",
        iso: "US",
      }),
      ip2regionVersion: V,
      maxmind: hit(city("US"), null),
    });
    expect(result).toMatchObject({
      region: "California",
      city: null,
      isp: null,
      source: "maxmind",
      version: `${V} GeoLite2@City-20261030`,
    });
  });

  it("国家不一致：保留 ip2region 的地点，运营商仍可取 ASN", () => {
    const result = resolveGeo({
      ip2region: jp,
      ip2regionVersion: V,
      maxmind: hit(city("US", { en: "Seattle" }), asn("Anycast Inc.")),
    });
    expect(result).toMatchObject({
      countryCode: "JP",
      region: "Tokyo",
      city: null,
      isp: "Anycast Inc.",
      source: "ip2region",
      version: `${V} GeoLite2@ASN-20261103`,
    });
  });

  it("MaxMind 不可用：记降级，国家名按代码取中文", () => {
    const result = resolveGeo({
      ip2region: jp,
      ip2regionVersion: V,
      maxmind: null,
    });
    expect(result).toEqual({
      countryCode: "JP",
      countryName: "日本",
      region: "Tokyo",
      city: null,
      isp: "KDDI CORPORATION",
      source: "ip2region-fallback",
      version: V,
    });
  });

  it("ip2region 没给代码：国家名用它的原文，不采用 MaxMind 的地点", () => {
    const result = resolveGeo({
      ip2region: record({ country: "Somewhere" }),
      ip2regionVersion: V,
      maxmind: hit(city("US", { en: "Seattle" }), null),
    });
    expect(result).toMatchObject({
      countryCode: null,
      countryName: "Somewhere",
      city: null,
      source: "ip2region",
    });
  });

  it("两条产品线的文件各占一段版本", () => {
    const result = resolveGeo({
      ip2region: jp,
      ip2regionVersion: V,
      maxmind: {
        ...hit(city("JP", { en: "Chiyoda" }), asn("KDDI")),
        cityFile: { family: "GeoIP2", edition: "City", date: "20261101" },
      },
    });
    expect(result.version).toBe(
      `${V} GeoIP2@City-20261101 GeoLite2@ASN-20261103`
    );
  });
});
