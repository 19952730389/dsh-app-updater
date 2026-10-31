/**
 * 版本比较：Windows 生态里版本串形状极不统一，这里实现一条保守但可用的规则。
 *
 * - 先按「数字段」切分比较（1.2.3.4 逐段比，缺段视为 0）
 * - 数字段相同后，剩余的非数字尾缀按字典序比较（2.55.0.5 vs 2.56.0.3）
 * - 带字母的预发布标记（1.2.3-beta）排在 1.2.3 之前
 * - 无法解析时返回 0（视为相等），由调用方决定是否降级为「无法判断」
 */

const NUMERIC = /^\d+(?:\.\d+)*/;

/** 把版本串拆成 { nums: number[], tail: string }，无法解析返回 null。 */
export function splitVersion(raw) {
  if (raw == null) return null;
  let text = String(raw).trim();
  if (!text) return null;
  // winget 会给出带比较符的写法（如 WindowsAppRuntime 的 "> 1.8.10"）：先剥掉符号
  text = text.replace(/^[><=~^]+\s*/, "").trim();
  if (!text) return null;
  // 去掉常见前缀与包装：v1.2.3 / Version 1.2.3 / (1.2.3)
  text = text.replace(/^(?:version|ver|v)\s*[.:]?\s*/i, '').trim();
  const wrapped = text.match(/^\(([^)]+)\)$/);
  if (wrapped) text = wrapped[1].trim();
  if (!text) return null;

  const m = text.match(NUMERIC);
  if (!m) return null;
  const nums = m[0].split('.').map((n) => {
    const v = Number.parseInt(n, 10);
    return Number.isFinite(v) ? v : 0;
  });
  const tail = text.slice(m[0].length).trim();
  return { nums, tail };
}

/** 比较两个版本串：a>b 返回 1，a<b 返回 -1，相等/无法判断返回 0。 */
export function compareVersions(a, b) {
  const va = splitVersion(a);
  const vb = splitVersion(b);
  if (!va || !vb) return 0;
  const len = Math.max(va.nums.length, vb.nums.length);
  for (let i = 0; i < len; i += 1) {
    const x = va.nums[i] || 0;
    const y = vb.nums[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  // 数字段一致：看尾缀。尾缀为空的视为「正式版」，大于任何预发布尾缀。
  const ta = va.tail;
  const tb = vb.tail;
  if (!ta && !tb) return 0;
  if (!ta) return 1;
  if (!tb) return -1;
  const na = ta.replace(/^[-+._\s]+/, '');
  const nb = tb.replace(/^[-+._\s]+/, '');
  if (na === nb) return 0;
  return na > nb ? 1 : -1;
}

/** a 是否比 b 新（严格大于）。 */
export function isNewer(a, b) {
  return compareVersions(a, b) > 0;
}

/**
 * 版本串是否「像版本」：至少一段数字。
 * winget 会把认不出当前版本的应用显示成 "Unknown"，这种条目不做版本比较。
 */
export function looksLikeVersion(raw) {
  if (raw == null) return false;
  const text = String(raw).trim();
  if (!text) return false;
  if (/^unknown$/i.test(text)) return false;
  return splitVersion(text) !== null;
}

/** 版本串归一化（用于跨源匹配同一款软件）。 */
export function normalizeVersionKey(raw) {
  const v = splitVersion(raw);
  if (!v) return "";
  return v.nums.join(".") + (v.tail ? v.tail.replace(/[^0-9a-z]/gi, "").toLowerCase() : "");
}
