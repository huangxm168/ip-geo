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

/** 日志函数：缺省打到 console。传入时只需实现用得到的三个级别 */
export interface GeoLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
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

/** 一个 MaxMind 数据文件此刻能不能用；City 与 ASN 各自独立，一个不可用不牵连另一个 */
export type MaxmindFileState =
  | ({ state: "ready" } & MaxmindFileStatus)
  | { state: "unavailable"; reason: string };

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
