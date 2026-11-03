/**
 * 解析器端到端：真实的 ip2region 数据 ＋ MaxMind 官方测试库（test/fixtures/maxmind）
 *
 * 测试库只收了少数几个国家的地址（英国、瑞典、中国大陆、美国、菲律宾、不丹），所以港澳台的规则在
 * rules.test.ts 里用手工构造的结果测；这里测加载、重载、降级与几条走得通的真实地址
 */

import { copyFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createGeoResolver } from "../src/index.js";
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

function resolver(dir: string | null, recheckIntervalMs = 0) {
  const logger = recordingLogger();
  return {
    logger,
    geo: createGeoResolver({
      ip2regionDir: IP2REGION_DIR,
      maxmindDir: dir,
      recheckIntervalMs,
      logger,
    }),
  };
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

  it("海外国家一致：取 MaxMind 的州与城市（中文优先）", async () => {
    const { geo } = resolver(maxmindDir());
    const result = await geo.lookup("81.2.69.142");
    expect(result).toMatchObject({
      countryCode: "GB",
      countryName: "英国",
      region: "英格兰",
      city: "伦敦",
      source: "maxmind",
    });
    expect(result.version).toMatch(
      new RegExp(`^ip2region@[0-9a-f]{12} ${FIXTURE_VERSION}$`)
    );
  });

  it("运营商取 ASN；没有中文名的州用英文", async () => {
    const { geo } = resolver(maxmindDir());
    const result = await geo.lookup("89.160.20.112");
    expect(result).toMatchObject({
      countryCode: "SE",
      region: "Östergötland County",
      city: "林雪平",
      isp: "Bredband2 AB",
      source: "maxmind",
    });
    expect(result.version).toContain(`${FIXTURE_VERSION}+${FIXTURE_ASN}`);
  });

  it("国家不一致（ip2region 美国、测试库不丹）：保留粗结果", async () => {
    const { geo } = resolver(maxmindDir());
    expect(await geo.lookup("67.43.156.1")).toMatchObject({
      countryCode: "US",
      region: "Hawaii",
      city: "Honolulu",
      source: "ip2region",
    });
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
    const status = geo.status().maxmind;
    expect(status.state).toBe("unavailable");
    expect(logger.lines.filter((line) => line.level === "warn")).toHaveLength(
      1
    );
  });

  it("文件类型不对（City 的位置放了 ASN 库）：不可用", async () => {
    const dir = maxmindDir();
    copyFileSync(ASN_FIXTURE, join(dir, "GeoLite2-City.mmdb"));
    const { geo } = resolver(dir);
    expect((await geo.lookup("81.2.69.142")).source).toBe("ip2region-fallback");
    const status = geo.status().maxmind;
    expect(status.state === "unavailable" && status.reason).toContain(
      "不是 City 库"
    );
  });

  it("就绪时状态给出两个库的类型与构建日期", async () => {
    const { geo } = resolver(maxmindDir());
    await geo.lookup("81.2.69.142");
    expect(geo.status().maxmind).toMatchObject({
      state: "ready",
      city: { databaseType: "GeoLite2-City", buildDate: "2026-10-22" },
      asn: { databaseType: "GeoLite2-ASN", buildDate: "2026-10-22" },
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
      state: "ready",
      city: { databaseType: "GeoIP2-City" },
    });
  });

  it("新文件坏了：继续用旧的，并记一条错误", async () => {
    const dir = maxmindDir();
    const { geo, logger } = resolver(dir);
    await geo.lookup("81.2.69.142");
    replace(join(dir, "GeoLite2-City.mmdb"), "这不是数据库");
    expect((await geo.lookup("81.2.69.142")).source).toBe("maxmind");
    expect(
      logger.lines.some(
        (line) => line.level === "error" && line.message.includes("继续使用")
      )
    ).toBe(true);
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
      logger.lines.filter((line) => line.message.startsWith("MaxMind 可用"))
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
    expect(logger.lines.filter((line) => line.level === "error")).toHaveLength(
      1
    );
    expect(geo.status().ip2region).toBeNull();
  });
});
