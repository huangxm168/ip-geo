/**
 * IP 的规整与「是不是公网地址」的判断
 */

import { BlockList, isIP } from "node:net";

// 内网、回环、链路本地、运营商级 NAT 等地址：不解析地区
const NON_PUBLIC = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  NON_PUBLIC.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
] as const) {
  NON_PUBLIC.addSubnet(address, prefix, "ipv6");
}

/** 「IPv4 映射的 IPv6」（::ffff:1.2.3.4）还原成 IPv4，其余原样返回 */
export function normalizeIp(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip.trim());
  return mapped?.[1] ?? ip.trim();
}

/** 是合法的 IP 且不在内网、回环、保留等地址段里 */
export function isPublicIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  return !NON_PUBLIC.check(ip, family === 4 ? "ipv4" : "ipv6");
}
