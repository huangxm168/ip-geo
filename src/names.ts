/**
 * 名称：港澳台的固定写法、按 ISO 代码取简体中文国家名、MaxMind 多语言名称的取舍
 */

// ip2region 把港澳台记作「中国｜香港特别行政区｜…｜CN」，按省一级认出来
export const SPECIAL_REGIONS: Readonly<
  Record<string, { code: string; name: string }>
> = {
  香港特别行政区: { code: "HK", name: "中国香港" },
  澳门特别行政区: { code: "MO", name: "中国澳门" },
  台湾省: { code: "TW", name: "中国台湾" },
};

const regionNames = new Intl.DisplayNames(["zh-CN"], { type: "region" });

/** 按 ISO 代码取简体中文国家名；不认识的代码返回 null */
export function countryNameZh(code: string): string | null {
  try {
    const name = regionNames.of(code);
    // 不认识的代码 Intl 会原样返回
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}

/** MaxMind 的多语言名称：优先简体中文，没有就取英文 */
export function pickName(
  names:
    | {
        readonly "zh-CN"?: string | undefined;
        readonly en?: string | undefined;
      }
    | undefined
): string | null {
  return names?.["zh-CN"] ?? names?.en ?? null;
}
