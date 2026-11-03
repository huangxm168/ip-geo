/**
 * 测试共用：临时目录、测试库的位置、记录日志的假 logger
 */

import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

import type { GeoLogger } from "../src/types.js";

export const FIXTURES = join(import.meta.dirname, "fixtures/maxmind");
export const IP2REGION_DIR = join(import.meta.dirname, ".data/ip2region");
export const CITY_FIXTURE = join(FIXTURES, "GeoLite2-City-Test.mmdb");
export const CITY_FIXTURE_GEOIP2 = join(FIXTURES, "GeoIP2-City-Test.mmdb");
export const ASN_FIXTURE = join(FIXTURES, "GeoLite2-ASN-Test.mmdb");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ip-geo-test-"));
  dirs.push(dir);
  return dir;
}

/** 一个放好了 City 与 ASN 测试库的 MaxMind 数据目录 */
export function maxmindDir(): string {
  const dir = tempDir();
  cpSync(CITY_FIXTURE, join(dir, "GeoLite2-City.mmdb"));
  cpSync(ASN_FIXTURE, join(dir, "GeoLite2-ASN.mmdb"));
  return dir;
}

export interface RecordingLogger extends GeoLogger {
  lines: { level: "info" | "warn" | "error"; message: string }[];
}

export function recordingLogger(): RecordingLogger {
  const lines: RecordingLogger["lines"] = [];
  return {
    lines,
    info: (message) => lines.push({ level: "info", message }),
    warn: (message) => lines.push({ level: "warn", message }),
    error: (message) => lines.push({ level: "error", message }),
  };
}
