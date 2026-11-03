#!/usr/bin/env node
/**
 * 命令行 `ip-geo`
 *
 *   ip-geo ip2region fetch --dir <目录> [--cache-dir <目录>] [--optional]
 *       按包里的清单取用 ip2region 数据文件。--optional：取不到只提示、不以失败退出（开发服务用）
 *
 *   ip-geo doctor [--ip2region <目录>] [--maxmind <目录>] [--max-age-days <天数>] [--ip <地址>]…
 *       自检：两类数据在不在、版本、构建日期、MaxMind 是否过久没更新（缺省 14 天）；给了 --ip 就顺带查一遍。
 *       有错误（文件缺失、与清单不符、打不开）时以 1 退出；只是过久没更新时提示、以 0 退出
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Reader } from "maxmind";

import { fetchIp2region, sha256 } from "./fetch.js";
import { IP2REGION_FILE, readManifest } from "./manifest.js";
import { createGeoResolver } from "./resolver.js";
import { errorMessage } from "./sources/ip2region.js";
import { ASN_FILE, CITY_FILE } from "./sources/maxmind.js";

const USAGE = `用法：
  ip-geo ip2region fetch --dir <目录> [--cache-dir <目录>] [--optional]
  ip-geo doctor [--ip2region <目录>] [--maxmind <目录>] [--max-age-days <天数>] [--ip <地址>]…
  ip-geo --version`;

const DAY_MS = 24 * 60 * 60 * 1000;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v") {
    console.log(packageVersion());
    return 0;
  }
  if (command === "ip2region" && rest[0] === "fetch") {
    return fetchCommand(rest.slice(1));
  }
  if (command === "doctor") return doctorCommand(rest);
  console.error(USAGE);
  return command === "--help" || command === "-h" ? 0 : 1;
}

async function fetchCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: "string" },
      "cache-dir": { type: "string" },
      optional: { type: "boolean", default: false },
    },
  });
  if (!values.dir) {
    console.error(USAGE);
    return 1;
  }
  const log = (message: string) => {
    console.log(`[ip-geo] ${message}`);
  };
  try {
    await fetchIp2region({
      dir: values.dir,
      cacheDir: values["cache-dir"],
      log,
    });
    return 0;
  } catch (err) {
    if (values.optional) {
      console.warn(
        `[ip-geo] ⚠️ 取不到 ip2region 数据文件，地区解析将一律记为空：${errorMessage(err)}`
      );
      return 0;
    }
    console.error(`[ip-geo] 失败：${errorMessage(err)}`);
    return 1;
  }
}

async function doctorCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      ip2region: { type: "string" },
      maxmind: { type: "string" },
      "max-age-days": { type: "string", default: "14" },
      ip: { type: "string", multiple: true },
    },
  });
  const maxAgeDays = Number(values["max-age-days"]);
  let errors = 0;
  const ok = (message: string) => {
    console.log(`✓ ${message}`);
  };
  const warn = (message: string) => {
    console.log(`⚠️ ${message}`);
  };
  const fail = (message: string) => {
    errors += 1;
    console.log(`✗ ${message}`);
  };

  const manifest = readManifest();
  console.log(
    `包版本 ${packageVersion()}，ip2region 清单 ${manifest.commit.slice(0, 12)}`
  );

  if (values.ip2region) {
    const path = join(resolve(values.ip2region), IP2REGION_FILE);
    if (!existsSync(path)) {
      fail(`ip2region：${path} 不存在（用 ip-geo ip2region fetch 取用）`);
    } else if (sha256(readFileSync(path)) !== manifest.sha256) {
      fail(`ip2region：${path} 与清单不符（用 ip-geo ip2region fetch 取用）`);
    } else {
      ok(`ip2region：${path}`);
    }
  }

  if (values.maxmind) {
    for (const [file, edition] of [
      [CITY_FILE, "City"],
      [ASN_FILE, "ASN"],
    ] as const) {
      const path = join(resolve(values.maxmind), file);
      if (!existsSync(path)) {
        fail(`MaxMind ${edition}：${path} 不存在`);
        continue;
      }
      try {
        const { databaseType, buildEpoch } = new Reader(readFileSync(path))
          .metadata;
        if (!databaseType.endsWith(`-${edition}`)) {
          fail(`MaxMind ${edition}：${path} 的数据库类型是 ${databaseType}`);
          continue;
        }
        const ageDays = Math.floor(
          (Date.now() - buildEpoch.getTime()) / DAY_MS
        );
        const line = `MaxMind ${edition}：${databaseType}，构建于 ${buildEpoch.toISOString().slice(0, 10)}（${String(ageDays)} 天前）`;
        if (ageDays > maxAgeDays) {
          warn(`${line}，超过 ${String(maxAgeDays)} 天，检查定时更新`);
        } else {
          ok(line);
        }
      } catch (err) {
        fail(`MaxMind ${edition}：${path} 打不开：${errorMessage(err)}`);
      }
    }
  }

  if (values.ip?.length) {
    if (!values.ip2region) {
      fail("给了 --ip 时须同时给 --ip2region");
    } else {
      const resolver = createGeoResolver({
        ip2regionDir: values.ip2region,
        maxmindDir: values.maxmind,
        logger: { info: () => {}, warn, error: fail },
      });
      for (const ip of values.ip) {
        console.log(`${ip} → ${JSON.stringify(await resolver.lookup(ip))}`);
      }
    }
  }

  return errors > 0 ? 1 : 0;
}

function packageVersion(): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ) as { version: string };
  return pkg.version;
}

process.exitCode = await main(process.argv.slice(2));
