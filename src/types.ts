/**
 * 对外的类型：解析结果、来源、解析器的选项与状态
 */

/**
 * 解析来源：只说明**地点**（国家以下的省 / 州、城市）取自哪里；运营商取自哪个数据文件看 `version`
 *
 * - `ip2region`：地点取自 ip2region（中国大陆一律如此；港澳台与海外是 MaxMind City 查过了、但没有国家以下的地点）
 * - `ip2region+maxmind`：港澳台，国家与省一级取自 ip2region、城市取自 MaxMind
 * - `maxmind`：海外，国家、省 / 州、城市整套取自 MaxMind（缺的留空，不拿 ip2region 补）
 * - `ip2region-fallback`：港澳台与海外，MaxMind City 不可用，地点先记 ip2region 的粗结果，可以日后补解析
 * - `none`：没有解析（内网与保留地址、IPv6、ip2region 不可用或查不到）
 */
export type GeoSource =
  "ip2region" | "ip2region+maxmind" | "maxmind" | "ip2region-fallback" | "none";

export interface GeoResult {
  /** ISO 3166-1 两位代码；港澳台一律 HK / MO / TW */
  countryCode: string | null;
  /** 简体中文国家名；港澳台为「中国香港」「中国澳门」「中国台湾」 */
  countryName: string | null;
  /** 省 / 州：国内与港澳台是 ip2region 的写法（「江苏省」「香港特别行政区」），海外是英文 */
  region: string | null;
  /** 城市：国内是 ip2region 的全称（「南京市」），港澳台与海外是英文 */
  city: string | null;
  /** 运营商：国内取 ip2region，海外取 MaxMind ASN 库的网络运营商名 */
  isp: string | null;
  source: GeoSource;
  /** 本次用到的数据文件版本，空格分隔，如 `ip2region@6a276cc7c4f9 GeoLite2@City-20261030+ASN-20261103` */
  version: string | null;
}

/**
 * 日志事件：`code` 是固定词表，使用方按它归类；`message` 是给人读的中文，可能带数据文件的路径、版本、
 * 构建日期与报错原文，**不会带访客 IP**——IP 只出现在 `lookup_failed` 的 `ip` 字段里，不想记就丢掉这个字段
 *
 * - `ip2region_loaded`（info）：数据文件读进内存
 * - `ip2region_load_failed`（error）：数据文件读不了，地区一律记为空，隔一个检查间隔再试
 * - `ip2region_manifest_mismatch`（warn）：数据文件与包里的清单不一致，照常使用
 * - `maxmind_status`（info / warn / error）：City 与 ASN 的可用状态变了（同一状态只报一次；过期停用时天数每天变，
 *   所以每天报一次）。两个都可用是 info，有一个不可用是 warn，有一个过期停用是 error
 * - `maxmind_file_rejected`（error）：换上来的新文件不合格，继续用已加载的旧版
 * - `maxmind_lookup_failed`（error）：查询时检查 MaxMind 文件出了意外，这一条按 MaxMind 不可用记降级。
 *   出错的是文件检查、与查的是哪个 IP 无关，所以不带 IP
 * - `lookup_failed`（error）：查询时出了意外，这一条记为空
 * - `load_failed`（error）：`ready()` 加载数据时出了意外
 *
 * ⚠️ `lookup_failed` 的 `error` 是原样交出的异常，它的消息里有可能带着那个 IP，写法与 `ip` 字段相同
 */
export type GeoLogEvent =
  | { code: "ip2region_loaded"; message: string; version: string }
  | {
      code: "ip2region_load_failed";
      message: string;
      path: string;
      error: unknown;
    }
  | {
      code: "ip2region_manifest_mismatch";
      message: string;
      path: string;
      /** 数据文件 sha256 的前 12 位 */
      sha256: string;
    }
  | {
      code: "maxmind_status";
      message: string;
      city: MaxmindFileState;
      asn: MaxmindFileState;
    }
  | {
      code: "maxmind_file_rejected";
      message: string;
      edition: "City" | "ASN";
      path: string;
      error: unknown;
      /** 继续使用的那一份 */
      kept: MaxmindFileStatus;
    }
  | { code: "maxmind_lookup_failed"; message: string; error: unknown }
  | {
      code: "lookup_failed";
      message: string;
      /** 规整后的写法（`::ffff:1.2.3.4` 记作 `1.2.3.4`）；还没走到规整那一步时是传入的原值 */
      ip: string;
      error: unknown;
    }
  | { code: "load_failed"; message: string; error: unknown };

export type GeoLogCode = GeoLogEvent["code"];

/**
 * 日志函数：缺省打到 console（只打 `message`）。传入时要实现三个级别；它抛错不影响解析，那一条改由 console 打出
 *
 * 写成属性而不是方法：方法的参数按双变检查，只收一部分事件的函数也能通过类型检查
 */
export interface GeoLogger {
  info: (event: GeoLogEvent) => void;
  warn: (event: GeoLogEvent) => void;
  error: (event: GeoLogEvent) => void;
}

export interface GeoResolverOptions {
  /** ip2region 数据文件所在目录，文件名固定为 ip2region_v4.xdb（用 `ip-geo ip2region fetch` 取用） */
  ip2regionDir: string;
  /** MaxMind 数据目录，放 GeoLite2-City.mmdb 与 GeoLite2-ASN.mmdb；省略或为空时不用 MaxMind */
  maxmindDir?: string | null | undefined;
  /** 隔多久检查一次 MaxMind 文件有没有换过，缺省 1 小时；0 表示每次查询都检查 */
  recheckIntervalMs?: number | undefined;
  /**
   * MaxMind 文件的构建日期超过这么多天就停用（当作不可用，港澳台与海外记降级、日后可补解析），缺省 30 天：
   * GeoLite 条款要求新版发布后 30 天内换掉旧版。null 或 0 表示不设上限
   */
  maxDataAgeDays?: number | null | undefined;
  logger?: GeoLogger | undefined;
}

/** 一个 MaxMind 数据文件的加载状态 */
export interface MaxmindFileStatus {
  /** 数据库类型，如 GeoLite2-City */
  databaseType: string;
  /** 构建日期（UTC），YYYY-MM-DD */
  buildDate: string;
  /** 加载进内存的时刻 */
  loadedAt: Date;
}

/**
 * MaxMind 数据文件不可用的原因：`not_loaded` 尚未加载、`missing` 文件不存在、`invalid` 打不开或校验不过、
 * `stale` 构建日期超过上限已停用
 */
export type MaxmindUnavailableCause =
  "not_loaded" | "missing" | "invalid" | "stale";

/**
 * 一个 MaxMind 数据文件此刻能不能用；City 与 ASN 各自独立，一个不可用不牵连另一个。
 * 不可用时 `cause` 是固定词表、`reason` 是给人读的中文；过期停用时另带构建日期
 */
export type MaxmindFileState =
  | ({ state: "ready" } & MaxmindFileStatus)
  | {
      state: "unavailable";
      cause: Exclude<MaxmindUnavailableCause, "stale">;
      reason: string;
    }
  | {
      state: "unavailable";
      cause: "stale";
      reason: string;
      /** 构建日期（UTC），YYYY-MM-DD */
      buildDate: string;
    };

export interface GeoResolverStatus {
  ip2region: { version: string; loadedAt: Date } | null;
  maxmind:
    | { state: "disabled" }
    | { state: "enabled"; city: MaxmindFileState; asn: MaxmindFileState };
}

export interface GeoResolver {
  /** 查一个 IP。永不抛错：出问题时退回粗结果或 `none` */
  lookup(ip: string | null | undefined): Promise<GeoResult>;
  /**
   * 加载两类数据（已加载的照常按间隔检查）并返回状态。永不抛错。启动时调一次，配置问题在启动日志里就能看到，
   * 第一位访客也不必等加载；一次性脚本用它判断数据是否就绪
   */
  ready(): Promise<GeoResolverStatus>;
  /** 两类数据此刻的加载状态（只读，不触发加载或检查） */
  status(): GeoResolverStatus;
}
