/**
 * 解析器端到端：真实的 ip2region 数据 ＋ MaxMind 官方测试库（test/fixtures/maxmind）
 *
 * 测试库只收了少数几个国家的地址（英国、瑞典、中国大陆、美国、菲律宾、不丹），所以港澳台的规则在
 * rules.test.ts 里用手工构造的结果测；这里测加载、重载、降级与几条走得通的真实地址
 */

import { copyFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  createGeoResolver,
  type GeoLogEvent,
  type GeoResolver,
} from "../src/index.js";
import { Ip2regionSource } from "../src/sources/ip2region.js";
import { MaxmindSource } from "../src/sources/maxmind.js";
import {
  ASN_FIXTURE,
  CITY_FIXTURE_GEOIP2,
  IP2REGION_DIR,
  maxmindDir,
  recordingLogger,
  tempDir,
} from "./helpers.js";

const FIXTURE_VERSION = "GeoLite2@City-20261022";
const FIXTURE_ASN = "ASN-20261022";

// 官方测试库的构建日期是固定的，会一天天变旧：除了专测过期的用例，一律不设上限
function resolver(
  dir: string | null,
  recheckIntervalMs = 0,
  maxDataAgeDays: number | null = null
) {
  const logger = recordingLogger();
  return {
    logger,
    geo: createGeoResolver({
      ip2regionDir: IP2REGION_DIR,
      maxmindDir: dir,
      recheckIntervalMs,
      maxDataAgeDays,
      logger,
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// 某个库不可用的原因；可用或没开 MaxMind 时为空串
function reasonOf(geo: GeoResolver, edition: "city" | "asn"): string {
  const maxmind = geo.status().maxmind;
  if (maxmind.state !== "enabled") return "";
  const file = maxmind[edition];
  return file.state === "unavailable" ? file.reason : "";
}

// 某个库不可用的原因代码；可用或没开 MaxMind 时为 null
function causeOf(geo: GeoResolver, edition: "city" | "asn"): string | null {
  const maxmind = geo.status().maxmind;
  if (maxmind.state !== "enabled") return null;
  const file = maxmind[edition];
  return file.state === "unavailable" ? file.cause : null;
}

// 像 geoipupdate 那样先写临时文件再改名
function replace(path: string, content: Buffer | string) {
  writeFileSync(`${path}.tmp`, content);
  renameSync(`${path}.tmp`, path);
}

describe("真实地址", () => {
  it("中国大陆取 ip2region，测试库里的「长春」不采用", async () => {
    const { geo } = resolver(maxmindDir());
    expect(await geo.lookup("175.16.199.1")).toMatchObject({
      countryCode: "CN",
      region: "吉林省",
      city: "吉林市",
      source: "ip2region",
    });
  });

  it("海外：MaxMind 有地点，取它的州与城市（英文名，库里有中文名也不用）", async () => {
    const { geo } = resolver(maxmindDir());
    const result = await geo.lookup("81.2.69.142");
    expect(result).toMatchObject({
      countryCode: "GB",
      countryName: "英国",
      region: "England",
      city: "London",
      source: "maxmind",
    });
    expect(result.version).toMatch(
      new RegExp(`^ip2region@[0-9a-f]{12} ${FIXTURE_VERSION}$`)
    );
  });

  it("运营商取 ASN", async () => {
    const { geo } = resolver(maxmindDir());
    const result = await geo.lookup("89.160.20.112");
    expect(result).toMatchObject({
      countryCode: "SE",
      region: "Östergötland County",
      city: "Linköping",
      isp: "Bredband2 AB",
      source: "maxmind",
    });
    expect(result.version).toContain(`${FIXTURE_VERSION}+${FIXTURE_ASN}`);
  });

  it("MaxMind 只有国家（测试库是不丹、ip2region 是美国）：地点整套取 ip2region", async () => {
    const { geo } = resolver(maxmindDir());
    expect(await geo.lookup("67.43.156.1")).toMatchObject({
      countryCode: "US",
      region: "Hawaii",
      city: "Honolulu",
      source: "ip2region",
    });
    expect((await geo.lookup("67.43.156.1")).version).not.toContain("City");
  });

  it("MaxMind 只有运营商：地点保留 ip2region，运营商取 ASN", async () => {
    const { geo } = resolver(maxmindDir());
    const result = await geo.lookup("1.128.0.1");
    expect(result).toMatchObject({
      countryCode: "AU",
      isp: "Telstra Pty Ltd",
      source: "ip2region",
    });
    expect(result.version).toContain(`GeoLite2@${FIXTURE_ASN}`);
  });

  it("IPv4 映射的 IPv6 还原后照常解析", async () => {
    const { geo } = resolver(null);
    expect((await geo.lookup("::ffff:175.16.199.1")).region).toBe("吉林省");
  });

  it("内网、IPv6、非法输入与空值一律记为空，不抛错", async () => {
    const { geo } = resolver(maxmindDir());
    for (const ip of ["10.0.0.1", "2001:db8::1", "not-an-ip", "", null]) {
      expect((await geo.lookup(ip)).source).toBe("none");
    }
  });
});

describe("MaxMind 的状态与降级", () => {
  it("没给目录：海外记降级，状态为 disabled", async () => {
    const { geo } = resolver(null);
    expect((await geo.lookup("81.2.69.142")).source).toBe("ip2region-fallback");
    expect(geo.status().maxmind).toEqual({ state: "disabled" });
  });

  it("目录里缺文件：记降级，状态写明原因，只报一次", async () => {
    const { geo, logger } = resolver(tempDir());
    await geo.lookup("81.2.69.142");
    await geo.lookup("89.160.20.112");
    expect((await geo.lookup("81.2.69.142")).source).toBe("ip2region-fallback");
    expect(geo.status().maxmind).toMatchObject({
      state: "enabled",
      city: { state: "unavailable" },
      asn: { state: "unavailable" },
    });
    expect(reasonOf(geo, "city")).toContain("不存在");
    expect(causeOf(geo, "city")).toBe("missing");
    expect(causeOf(geo, "asn")).toBe("missing");
    const warnings = logger.lines.filter((line) => line.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.event).toMatchObject({
      code: "maxmind_status",
      city: { state: "unavailable", cause: "missing" },
      asn: { state: "unavailable", cause: "missing" },
    });
  });

  it("文件类型不对（City 的位置放了 ASN 库）：City 不可用，ASN 照常", async () => {
    const dir = maxmindDir();
    copyFileSync(ASN_FIXTURE, join(dir, "GeoLite2-City.mmdb"));
    const { geo } = resolver(dir);
    expect(await geo.lookup("89.160.20.112")).toMatchObject({
      source: "ip2region-fallback",
      isp: "Bredband2 AB",
    });
    const status = geo.status().maxmind;
    expect(status).toMatchObject({
      city: { state: "unavailable" },
      asn: { state: "ready" },
    });
    expect(reasonOf(geo, "city")).toContain("不是 City 库");
    expect(causeOf(geo, "city")).toBe("invalid");
  });

  it("只缺 City：地点记降级，ASN 照样补运营商", async () => {
    const dir = maxmindDir();
    rmSync(join(dir, "GeoLite2-City.mmdb"));
    const { geo, logger } = resolver(dir);
    const result = await geo.lookup("1.128.0.1");
    expect(result).toMatchObject({
      source: "ip2region-fallback",
      isp: "Telstra Pty Ltd",
    });
    expect(result.version).toContain("GeoLite2@ASN-");
    expect(
      logger.lines.some(
        (line) =>
          line.level === "warn" &&
          line.code === "maxmind_status" &&
          line.message.includes("日后可以补解析")
      )
    ).toBe(true);
  });

  it("只缺 ASN：地点照常取 MaxMind", async () => {
    const dir = maxmindDir();
    rmSync(join(dir, "GeoLite2-ASN.mmdb"));
    const { geo } = resolver(dir);
    expect(await geo.lookup("89.160.20.112")).toMatchObject({
      source: "maxmind",
      city: "Linköping",
      isp: null,
    });
    expect(geo.status().maxmind).toMatchObject({
      city: { state: "ready" },
      asn: { state: "unavailable" },
    });
  });

  it("就绪时状态给出两个库的类型与构建日期", async () => {
    const { geo } = resolver(maxmindDir());
    await geo.lookup("81.2.69.142");
    expect(geo.status().maxmind).toMatchObject({
      state: "enabled",
      city: {
        state: "ready",
        databaseType: "GeoLite2-City",
        buildDate: "2026-10-22",
      },
      asn: {
        state: "ready",
        databaseType: "GeoLite2-ASN",
        buildDate: "2026-10-22",
      },
    });
  });

  it("MaxMind 那一段出了意外：按不可用处理，记降级而不是空", async () => {
    vi.spyOn(MaxmindSource.prototype, "current").mockRejectedValue(
      new Error("模拟的意外")
    );
    const { geo, logger } = resolver(maxmindDir());
    expect(await geo.lookup("81.2.69.142")).toMatchObject({
      countryCode: "GB",
      source: "ip2region-fallback",
    });
    const failed = logger.lines.filter(
      (line) => line.level === "error" && line.code === "maxmind_lookup_failed"
    );
    expect(failed).toHaveLength(1);
    // 出错的是文件检查、与 IP 无关：事件不带 IP，说明文字也不带异常原文
    expect(failed[0]?.event).not.toHaveProperty("ip");
    expect(failed[0]?.message).not.toContain("81.2.69.142");
    expect(failed[0]?.message).not.toContain("模拟的意外");
  });
});

describe("过期停用", () => {
  it("构建日期超过上限：两个库都停用，记降级，报一条错误", async () => {
    const { geo, logger } = resolver(maxmindDir(), 0, 1);
    expect(await geo.lookup("89.160.20.112")).toMatchObject({
      source: "ip2region-fallback",
      isp: null,
    });
    await geo.lookup("81.2.69.142");
    expect(geo.status().maxmind).toMatchObject({
      city: { state: "unavailable" },
      asn: { state: "unavailable" },
    });
    expect(reasonOf(geo, "city")).toContain("已停用");
    expect(reasonOf(geo, "asn")).toContain("已停用");
    expect(geo.status().maxmind).toMatchObject({
      city: { cause: "stale", buildDate: "2026-10-22" },
      asn: { cause: "stale", buildDate: "2026-10-22" },
    });
    // 同一天里反复检查只报一次
    const errors = logger.lines.filter((line) => line.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("maxmind_status");
  });

  it("已停用的文件没换就不重读；换成新版后恢复", async () => {
    // 只假造「今天」：测试库构建于 2026-10-22，上限 1 天
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const dir = maxmindDir();
      const cityPath = join(dir, "GeoLite2-City.mmdb");
      const { geo } = resolver(dir, 0, 1);
      vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
      expect((await geo.lookup("81.2.69.142")).source).toBe("maxmind");

      vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
      expect((await geo.lookup("81.2.69.142")).source).toBe(
        "ip2region-fallback"
      );
      // 文件被改坏但签名没变（同一份）：照样只是停用，不去读它
      expect(reasonOf(geo, "city")).toContain("已停用");

      // 新版到了（换文件、签名变了，且构建日期在上限内）
      vi.setSystemTime(new Date("2026-10-22T18:00:00Z"));
      copyFileSync(CITY_FIXTURE_GEOIP2, `${cityPath}.new`);
      renameSync(`${cityPath}.new`, cityPath);
      expect((await geo.lookup("81.2.69.142")).source).toBe("maxmind");
    } finally {
      vi.useRealTimers();
    }
  });

  it("上限设为 null 或 0：不停用", async () => {
    for (const limit of [null, 0]) {
      const { geo } = resolver(maxmindDir(), 0, limit);
      expect((await geo.lookup("81.2.69.142")).source).toBe("maxmind");
    }
  });
});

describe("ready()", () => {
  it("加载两类数据并返回状态，之后的查询不必再等加载", async () => {
    const { geo, logger } = resolver(maxmindDir(), 60 * 60 * 1000);
    const status = await geo.ready();
    expect(status.ip2region?.version).toMatch(/^ip2region@/);
    expect(status.maxmind).toMatchObject({
      city: { state: "ready" },
      asn: { state: "ready" },
    });
    const loaded = logger.lines.length;
    await geo.lookup("81.2.69.142");
    expect(logger.lines).toHaveLength(loaded);
  });

  it("数据缺失时照常返回状态，不抛错", async () => {
    const geo = createGeoResolver({
      ip2regionDir: tempDir(),
      maxmindDir: tempDir(),
      logger: recordingLogger(),
    });
    const status = await geo.ready();
    expect(status.ip2region).toBeNull();
    expect(status.maxmind).toMatchObject({
      city: { state: "unavailable" },
    });
  });
});

describe("重载", () => {
  it("换了文件，下一次检查时不重启即生效", async () => {
    const dir = maxmindDir();
    const { geo } = resolver(dir);
    await geo.lookup("81.2.69.142");
    copyFileSync(CITY_FIXTURE_GEOIP2, join(dir, "GeoLite2-City.mmdb.new"));
    renameSync(
      join(dir, "GeoLite2-City.mmdb.new"),
      join(dir, "GeoLite2-City.mmdb")
    );
    const result = await geo.lookup("81.2.69.142");
    expect(result.version).toContain("GeoIP2@City-");
    expect(geo.status().maxmind).toMatchObject({
      city: { state: "ready", databaseType: "GeoIP2-City" },
    });
  });

  it("新文件坏了：继续用旧的，并记一条错误", async () => {
    const dir = maxmindDir();
    const { geo, logger } = resolver(dir);
    await geo.lookup("81.2.69.142");
    replace(join(dir, "GeoLite2-City.mmdb"), "这不是数据库");
    expect((await geo.lookup("81.2.69.142")).source).toBe("maxmind");
    const rejected = logger.lines.filter(
      (line) => line.code === "maxmind_file_rejected"
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.level).toBe("error");
    expect(rejected[0]?.message).toContain("继续使用");
    expect(rejected[0]?.event).toMatchObject({
      edition: "City",
      path: join(dir, "GeoLite2-City.mmdb"),
      kept: { databaseType: "GeoLite2-City" },
    });
  });

  it("文件被删了：丢掉旧版、转为降级；放回来后恢复", async () => {
    const dir = maxmindDir();
    const { geo } = resolver(dir);
    await geo.lookup("81.2.69.142");
    rmSync(join(dir, "GeoLite2-City.mmdb"));
    expect((await geo.lookup("81.2.69.142")).source).toBe("ip2region-fallback");
    copyFileSync(CITY_FIXTURE_GEOIP2, join(dir, "GeoLite2-City.mmdb"));
    expect((await geo.lookup("81.2.69.142")).source).toBe("maxmind");
  });

  it("没到检查间隔时不看文件", async () => {
    const dir = maxmindDir();
    const { geo } = resolver(dir, 60 * 60 * 1000);
    await geo.lookup("81.2.69.142");
    rmSync(join(dir, "GeoLite2-City.mmdb"));
    expect((await geo.lookup("81.2.69.142")).source).toBe("maxmind");
  });

  it("同一时刻的多个查询只触发一次检查", async () => {
    const { geo, logger } = resolver(maxmindDir());
    const results = await Promise.all(
      Array.from({ length: 20 }, () => geo.lookup("81.2.69.142"))
    );
    expect(results.every((result) => result.source === "maxmind")).toBe(true);
    expect(
      logger.lines.filter(
        (line) =>
          line.code === "maxmind_status" &&
          line.message.startsWith("MaxMind City 可用")
      )
    ).toHaveLength(1);
  });
});

describe("ip2region 不可用", () => {
  it("目录里没有数据文件：一律记为空、报一次错，状态为 null", async () => {
    const logger = recordingLogger();
    const geo = createGeoResolver({
      ip2regionDir: tempDir(),
      maxmindDir: maxmindDir(),
      recheckIntervalMs: 60_000,
      logger,
    });
    expect((await geo.lookup("81.2.69.142")).source).toBe("none");
    expect((await geo.lookup("175.16.199.1")).source).toBe("none");
    const errors = logger.lines.filter((line) => line.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("ip2region_load_failed");
    expect(errors[0]?.event).toMatchObject({
      path: expect.stringContaining("ip2region_v4.xdb") as unknown,
    });
    expect(geo.status().ip2region).toBeNull();
  });
});

describe("日志里的访客 IP", () => {
  it("查询出错：IP 只在 ip 字段里，说明文字不带它", async () => {
    vi.spyOn(Ip2regionSource.prototype, "search").mockRejectedValue(
      new Error("模拟的意外：175.16.199.1")
    );
    const { geo, logger } = resolver(null);
    expect((await geo.lookup("175.16.199.1")).source).toBe("none");
    const failed = logger.lines.filter((line) => line.code === "lookup_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.level).toBe("error");
    expect(failed[0]?.event).toMatchObject({ ip: "175.16.199.1" });
    expect(failed[0]?.message).not.toContain("175.16.199.1");
  });

  it("IPv4 映射的 IPv6：ip 字段是规整后的写法，与异常原文里的一致", async () => {
    vi.spyOn(Ip2regionSource.prototype, "search").mockRejectedValue(
      new Error("模拟的意外：175.16.199.1")
    );
    const { geo, logger } = resolver(null);
    await geo.lookup("::ffff:175.16.199.1");
    const failed = logger.lines.filter((line) => line.code === "lookup_failed");
    expect(failed[0]?.event).toMatchObject({ ip: "175.16.199.1" });
  });

  it("只有 lookup_failed 带 ip 字段（类型层面）", () => {
    expectTypeOf<
      Extract<GeoLogEvent, { ip: string }>["code"]
    >().toEqualTypeOf<"lookup_failed">();
  });

  it("缺省打到 console 时不打 IP，也不打异常原文", async () => {
    vi.spyOn(Ip2regionSource.prototype, "search").mockRejectedValue(
      new Error("模拟的意外：175.16.199.1")
    );
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    const geo = createGeoResolver({ ip2regionDir: IP2REGION_DIR });
    await geo.lookup("175.16.199.1");
    const text = printed.mock.calls.flat().map(String).join("\n");
    expect(text).toContain("[ip-geo]");
    expect(text).not.toContain("175.16.199.1");
  });

  it("其余事件都不带 ip 字段", async () => {
    const dir = maxmindDir();
    const { geo, logger } = resolver(dir);
    await geo.ready();
    await geo.lookup("81.2.69.142");
    replace(join(dir, "GeoLite2-City.mmdb"), "这不是数据库");
    await geo.lookup("81.2.69.142");
    expect(logger.lines.length).toBeGreaterThan(0);
    for (const line of logger.lines)
      expect(line.event).not.toHaveProperty("ip");
  });
});

describe("logger 自己抛错", () => {
  const throwing = {
    info: () => {
      throw new Error("logger 坏了");
    },
    warn: () => {
      throw new Error("logger 坏了");
    },
    error: () => {
      throw new Error("logger 坏了");
    },
  };

  it("查询照常返回，那一条改由 console 打出", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const geo = createGeoResolver({
      ip2regionDir: IP2REGION_DIR,
      maxmindDir: maxmindDir(),
      maxDataAgeDays: null,
      logger: throwing,
    });
    expect((await geo.lookup("81.2.69.142")).source).toBe("maxmind");
    // ip2region 不会因为「已加载」那一条报错而被当成加载失败
    expect(geo.status().ip2region).not.toBeNull();
    const text = info.mock.calls.flat().map(String).join("\n");
    expect(text).toContain("ip2region 已加载");
  });

  it("ready 照常返回状态", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const geo = createGeoResolver({
      ip2regionDir: IP2REGION_DIR,
      logger: throwing,
    });
    await expect(geo.ready()).resolves.toMatchObject({
      maxmind: { state: "disabled" },
    });
  });
});

describe("status() 交出的是拷贝", () => {
  it("改了返回值不影响下一次", () => {
    const { geo } = resolver(maxmindDir());
    const first = geo.status().maxmind;
    if (first.state === "enabled" && first.city.state === "unavailable") {
      first.city.reason = "被改过";
    }
    expect(reasonOf(geo, "city")).toBe("尚未加载");
  });
});
