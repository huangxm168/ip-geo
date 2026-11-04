/**
 * 分流规则逐条（纯函数，手工构造两边的结果，覆盖测试库里没有的港澳台等情形）
 */

import type { AsnResponse, CityResponse } from "maxmind";
import { describe, expect, it } from "vitest";

import {
  resolveGeo,
  type Ip2regionRecord,
  type MaxmindFileTag,
  type MaxmindLookup,
} from "../src/rules.js";

const V = "ip2region@aaaaaaaaaaaa";
const CITY_TAG = { family: "GeoLite2", edition: "City", date: "20261030" };
const ASN_TAG = { family: "GeoLite2", edition: "ASN", date: "20261103" };

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

type Names = { "zh-CN"?: string; en: string };

function cityRecord(
  iso: string,
  cityNames?: Names,
  subdivision?: Names
): CityResponse {
  return {
    country: { iso_code: iso, geoname_id: 1, names: { en: `Country ${iso}` } },
    ...(cityNames ? { city: { geoname_id: 2, names: cityNames } } : {}),
    ...(subdivision
      ? { subdivisions: [{ iso_code: "X", geoname_id: 3, names: subdivision }] }
      : {}),
  };
}

// City / ASN 库可用时的查询结果（record 为 null 表示库里没有这个 IP）
function city(
  value: CityResponse | null,
  file: MaxmindFileTag = CITY_TAG
): MaxmindLookup<CityResponse> {
  return { record: value, file };
}

function asn(org: string | null): MaxmindLookup<AsnResponse> {
  return {
    record: org
      ? { autonomous_system_number: 1, autonomous_system_organization: org }
      : null,
    file: ASN_TAG,
  };
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
      city: city(cityRecord("PH", { en: "Manila" }, { en: "Metro Manila" })),
      asn: asn("Someone"),
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

  it("城市取 MaxMind 的英文名，运营商为空时用 ASN 补", () => {
    const result = resolveGeo({
      ip2region: hk,
      ip2regionVersion: V,
      city: city(cityRecord("HK", { "zh-CN": "九龙湾", en: "Kowloon Bay" })),
      asn: asn("Example Network Ltd."),
    });
    expect(result).toEqual({
      countryCode: "HK",
      countryName: "中国香港",
      region: "香港特别行政区",
      city: "Kowloon Bay",
      isp: "Example Network Ltd.",
      source: "ip2region+maxmind",
      version: `${V} GeoLite2@City-20261030+ASN-20261103`,
    });
  });

  it("ip2region 有运营商时保留它，不用 ASN", () => {
    const result = resolveGeo({
      ip2region: { ...hk, province: "澳门特别行政区", isp: "澳门电讯" },
      ip2regionVersion: V,
      city: city(cityRecord("MO", { en: "Macau" })),
      asn: asn("CTM"),
    });
    expect(result.isp).toBe("澳门电讯");
    expect(result.city).toBe("Macau");
    expect(result.version).toBe(`${V} GeoLite2@City-20261030`);
  });

  it("MaxMind 判的地方对不上就不采用它的城市", () => {
    const result = resolveGeo({
      ip2region: { ...hk, province: "台湾省" },
      ip2regionVersion: V,
      city: city(cityRecord("JP", { en: "Tokyo" })),
      asn: asn(null),
    });
    expect(result).toMatchObject({
      countryCode: "TW",
      countryName: "中国台湾",
      city: null,
      source: "ip2region",
      version: V,
    });
  });

  it("City 查过但没有城市：来源记 ip2region（不再补解析）", () => {
    const result = resolveGeo({
      ip2region: hk,
      ip2regionVersion: V,
      city: city(null),
      asn: asn(null),
    });
    expect(result.source).toBe("ip2region");
  });

  it("City 不可用、ASN 可用：地点记降级，运营商照样用 ASN 补", () => {
    const result = resolveGeo({
      ip2region: hk,
      ip2regionVersion: V,
      city: null,
      asn: asn("Example Network Ltd."),
    });
    expect(result).toEqual({
      countryCode: "HK",
      countryName: "中国香港",
      region: "香港特别行政区",
      city: null,
      isp: "Example Network Ltd.",
      source: "ip2region-fallback",
      version: `${V} GeoLite2@ASN-20261103`,
    });
  });

  it("两个库都不可用：记降级", () => {
    const result = resolveGeo({
      ip2region: { ...hk, isp: "某运营商" },
      ip2regionVersion: V,
      city: null,
      asn: null,
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
    city: "Shibuya",
    isp: "KDDI CORPORATION",
    iso: "JP",
  });

  it("MaxMind 有国家以下的地点：国家、州、城市整套取 MaxMind 的英文名，运营商取 ASN", () => {
    const result = resolveGeo({
      ip2region: jp,
      ip2regionVersion: V,
      city: city(
        cityRecord("JP", { en: "Chiyoda" }, { "zh-CN": "东京都", en: "Tokyo" })
      ),
      asn: asn("KDDI CORPORATION (ASN)"),
    });
    expect(result).toEqual({
      countryCode: "JP",
      countryName: "日本",
      region: "Tokyo",
      city: "Chiyoda",
      isp: "KDDI CORPORATION (ASN)",
      source: "maxmind",
      version: `${V} GeoLite2@City-20261030+ASN-20261103`,
    });
  });

  it("MaxMind 只有州：城市留空，不拿 ip2region 的城市拼上", () => {
    const result = resolveGeo({
      ip2region: jp,
      ip2regionVersion: V,
      city: city(cityRecord("JP", undefined, { en: "Osaka" })),
      asn: asn(null),
    });
    expect(result).toMatchObject({
      region: "Osaka",
      city: null,
      isp: "KDDI CORPORATION",
      source: "maxmind",
      version: `${V} GeoLite2@City-20261030`,
    });
  });

  it("MaxMind 只有国家：地点整套取 ip2region，来源记 ip2region", () => {
    const result = resolveGeo({
      ip2region: record({
        country: "United States",
        province: "California",
        iso: "US",
      }),
      ip2regionVersion: V,
      city: city(cityRecord("US")),
      asn: asn("Google LLC"),
    });
    expect(result).toEqual({
      countryCode: "US",
      countryName: "美国",
      region: "California",
      city: null,
      isp: "Google LLC",
      source: "ip2region",
      version: `${V} GeoLite2@ASN-20261103`,
    });
  });

  it("两边判的国家不同、MaxMind 有地点：整套取 MaxMind，国家也按它", () => {
    const result = resolveGeo({
      ip2region: jp,
      ip2regionVersion: V,
      city: city(cityRecord("US", { en: "Seattle" }, { en: "Washington" })),
      asn: asn("Anycast Inc."),
    });
    expect(result).toMatchObject({
      countryCode: "US",
      countryName: "美国",
      region: "Washington",
      city: "Seattle",
      isp: "Anycast Inc.",
      source: "maxmind",
    });
  });

  it("MaxMind 判到中国大陆或港澳台：边界以 ip2region 为准", () => {
    for (const code of ["CN", "HK", "MO", "TW"]) {
      const result = resolveGeo({
        ip2region: jp,
        ip2regionVersion: V,
        city: city(cityRecord(code, { en: "Somewhere" }, { en: "Province" })),
        asn: asn(null),
      });
      expect(result).toMatchObject({
        countryCode: "JP",
        region: "Tokyo",
        city: "Shibuya",
        source: "ip2region",
        version: V,
      });
    }
  });

  it("City 不可用：地点记降级，ASN 照常补运营商", () => {
    const result = resolveGeo({
      ip2region: jp,
      ip2regionVersion: V,
      city: null,
      asn: asn("KDDI (ASN)"),
    });
    expect(result).toEqual({
      countryCode: "JP",
      countryName: "日本",
      region: "Tokyo",
      city: "Shibuya",
      isp: "KDDI (ASN)",
      source: "ip2region-fallback",
      version: `${V} GeoLite2@ASN-20261103`,
    });
  });

  it("ASN 不可用：运营商用 ip2region 的，地点照常取 MaxMind", () => {
    const result = resolveGeo({
      ip2region: jp,
      ip2regionVersion: V,
      city: city(cityRecord("JP", { en: "Chiyoda" }, { en: "Tokyo" })),
      asn: null,
    });
    expect(result).toMatchObject({
      city: "Chiyoda",
      isp: "KDDI CORPORATION",
      source: "maxmind",
      version: `${V} GeoLite2@City-20261030`,
    });
  });

  it("ip2region 没给代码：MaxMind 有地点就用它的，没有就用 ip2region 的原文", () => {
    const somewhere = record({ country: "Somewhere" });
    expect(
      resolveGeo({
        ip2region: somewhere,
        ip2regionVersion: V,
        city: city(cityRecord("US", { en: "Seattle" }, { en: "Washington" })),
        asn: null,
      })
    ).toMatchObject({ countryCode: "US", city: "Seattle", source: "maxmind" });
    expect(
      resolveGeo({
        ip2region: somewhere,
        ip2regionVersion: V,
        city: city(null),
        asn: null,
      })
    ).toMatchObject({
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
      city: city(cityRecord("JP", { en: "Chiyoda" }), {
        family: "GeoIP2",
        edition: "City",
        date: "20261101",
      }),
      asn: asn("KDDI"),
    });
    expect(result.version).toBe(
      `${V} GeoIP2@City-20261101 GeoLite2@ASN-20261103`
    );
  });
});
