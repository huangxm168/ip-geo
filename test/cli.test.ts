/**
 * 命令行：自检的输出与退出码
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { IP2REGION_DIR, maxmindDir, tempDir } from "./helpers.js";

const CLI = join(import.meta.dirname, "../src/cli.ts");

function run(args: string[]) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", CLI, ...args],
    {
      encoding: "utf8",
    }
  );
  return { code: result.status, output: result.stdout + result.stderr };
}

describe("ip-geo doctor", () => {
  it("两类数据都在：以 0 退出，并能顺带查地址", () => {
    const { code, output } = run([
      "doctor",
      "--ip2region",
      IP2REGION_DIR,
      "--maxmind",
      maxmindDir(),
      "--max-age-days",
      "100000",
      "--ip",
      "81.2.69.142",
    ]);
    expect(code).toBe(0);
    expect(output).toContain("✓ ip2region");
    expect(output).toContain("✓ MaxMind City：GeoLite2-City");
    expect(output).toContain('"city":"伦敦"');
  });

  it("MaxMind 过久没更新：提示但以 0 退出", () => {
    const { code, output } = run([
      "doctor",
      "--maxmind",
      maxmindDir(),
      "--max-age-days",
      "0",
    ]);
    expect(code).toBe(0);
    expect(output).toContain("检查定时更新");
  });

  it("文件缺失：以 1 退出", () => {
    const { code, output } = run([
      "doctor",
      "--ip2region",
      tempDir(),
      "--maxmind",
      tempDir(),
    ]);
    expect(code).toBe(1);
    expect(output).toContain("✗ ip2region");
    expect(output).toContain("✗ MaxMind City");
  });

  it("不认识的命令：打印用法、以 1 退出", () => {
    const { code, output } = run(["whatever"]);
    expect(code).toBe(1);
    expect(output).toContain("用法");
  });
});
