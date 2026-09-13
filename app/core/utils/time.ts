/**
 * 时间工具模块
 * 
 * 提供时间相关的工具函数，基于 moment 库封装。
 */

import moment from "moment";
import config from "../config/index";
// 类型别名（Node 原生 transform-types 不支持 import= 语法）
type StartOf = moment.unitOfTime.StartOf;

/**
 * 获取真实时间戳（秒）——绕过虚拟时钟（DoctoratePy virtualtime 移植）
 *
 * 仅基础设施需要真实时钟时使用（如 admin 的「仅允许冻结到过去时间」校验基准、
 * 虚拟时钟自身回退）。游戏逻辑一律用 {@link now}。
 *
 * @returns 当前真实 Unix 时间戳（秒）
 */
export function realNow(): number {
  return moment().unix();
}

/**
 * 虚拟时钟支持的日期格式（DoctoratePy virtualtime 的五种 strptime 格式，本地时区）
 *
 * 与 Python `datetime.strptime` 对齐：月/日/时/分/秒可 1~2 位（`\d{1,2}`），
 * 且按声明顺序逐个尝试（`20/24/0220` 这类非法组合由 {@link localTimestamp}
 * 的范围/回卷校验拒绝后继续尝试下一格式）。
 */
const VIRTUAL_TIME_FORMATS: {
  /** 完整匹配串（含日期与时间，空白已归一为单空格） */
  pattern: RegExp;
  /** 从捕获组取 [年, 月, 日]（各格式字段序不同） */
  date: (match: RegExpExecArray) => [number, number, number];
}[] = [
  {
    pattern: /^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/,
    date: (m) => [Number(m[1]), Number(m[2]), Number(m[3])],
  },
  {
    pattern: /^(\d{2})(\d{2})(\d{4}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/,
    date: (m) => [Number(m[3]), Number(m[2]), Number(m[1])],
  },
  {
    pattern: /^(\d{1,2})-(\d{1,2})-(\d{4}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/,
    date: (m) => [Number(m[3]), Number(m[2]), Number(m[1])],
  },
  {
    pattern: /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/,
    date: (m) => [Number(m[1]), Number(m[2]), Number(m[3])],
  },
  {
    pattern: /^(\d{4})(\d{2})(\d{2}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/,
    date: (m) => [Number(m[1]), Number(m[2]), Number(m[3])],
  },
];

/**
 * 本地时区构造秒级时间戳（字段越界/日期回卷返回 null）
 *
 * 用 `new Date(y, m-1, ...)` 而非 `new Date(string)`：与 Python
 * `datetime.strptime(...).timestamp()` 同为「本地时区 + 该日期的 DST 规则」语义，
 * 且不接受 JS 宽松解析（`2024-02-31` 会被 Date 回卷为 3/2，必须显式拒绝）。
 *
 * @param year - 年（1970~9999）
 * @param month - 月（1~12）
 * @param day - 日（1~31，按实际月份校验）
 * @param hour - 时（0~23）
 * @param minute - 分（0~59）
 * @param second - 秒（0~59）
 * @returns Unix 时间戳（秒）；非法字段返回 null
 */
function localTimestamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | null {
  if (
    year < 1970 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  const date = new Date(year, month - 1, day, hour, minute, second);
  // 回卷校验：2024-02-31 → 3/2，字段与输入不一致即视为非法
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return Math.floor(date.getTime() / 1000);
}

/**
 * 解析虚拟时钟配置值（DoctoratePy `server.virtualtime` 语义）
 *
 * - 数值 > 0：冻结到该时间戳（odpy 允许未来值——私服可用于推进到后续卡池/活动）
 * - 数值 ≤ 0 / 非有限数：未启用（返回 null，由调用方回退真实时间）。**刻意把 0 归入
 *   未启用**——odpy 原语义会返回 0（1970），基建等按流逝时间结算的系统会得到数十年
 *   时长而溢出，属防呆收敛
 * - 字符串：纯数字串视同数值；否则按 {@link VIRTUAL_TIME_FORMATS} 五种本地时区日期格式解析；
 *   全部不匹配（非法值「防刁民」）返回 null 回退真实时间
 * - 其他类型（布尔/null/未定义）：返回 null 回退真实时间（运行时对任何非数值、
 *   非字符串值一律由 typeof 判定兜底，手工改坏 config 也不会抛错）
 *
 * @param value - config.virtualtime 原始值
 * @returns 秒级时间戳；未启用或非法返回 null
 */
export function parseVirtualTime(
  value: number | string | boolean | null | undefined,
): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) return null;
  // 纯数字串（"1700000000"）等价于数值配置——odpy 会判为非法回退真实时间，
  // 此处放宽为安全超集（不影响任何 odpy 合法配置的行为）
  if (/^-?\d+$/.test(text)) {
    const num = Number(text);
    return num > 0 ? num : null;
  }
  for (const format of VIRTUAL_TIME_FORMATS) {
    const match = format.pattern.exec(text);
    if (!match) continue;
    const [year, month, day] = format.date(match);
    const ts = localTimestamp(
      year,
      month,
      day,
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    );
    if (ts !== null) return ts;
  }
  return null;
}

/**
 * 虚拟时钟当前时间戳（秒）——`config.virtualtime` 未启用/非法时回退真实时间
 *
 * @returns 虚拟时钟时间戳（秒）
 */
export function virtualNow(): number {
  return parseVirtualTime(config.virtualtime) ?? realNow();
}

/**
 * 获取服务器逻辑时间戳（秒）——虚拟时钟（DoctoratePy virtualtime 移植）
 *
 * 游戏/账号/基建/活动等全部业务时间基准：`config.virtualtime` 启用时返回冻结值，
 * 未启用（缺省）时等价于真实时间，行为与历史版本完全一致。
 *
 * 注意：冻结为**常量**时钟——依赖「时间流逝」的结算（每日刷新 checkNew、基建产能、
 * AP/信赖恢复）在冻结期间不推进；推进时间戳即可（odpy 警示：确定后勿随意调小，
 * 大幅回退会让基建结算出现异常时长）。
 *
 * @returns 当前逻辑 Unix 时间戳（秒）
 */
export function now(): number {
  return virtualNow();
}

/**
 * 获取客户端可见服务器时间戳（秒）——activity 切换（DoctoratePy 移植）
 *
 * `config.developer.timestamp`：-1（缺省）= 虚拟时钟（{@link now}，未启用虚拟时钟
 * 即真实时间）；数值 = 冻结到该时间戳（仅允许过去时间——若值大于当前**真实**时间则
 * 回退虚拟时钟，避免未来日期存档异常）。
 * 用于 syncData/gate 等客户端可见时钟（活动按 server ts 判定开放）。
 */
export function userTimestamp(): number {
  const realTs = realNow();
  const userTs = config.developer?.timestamp ?? -1;
  if (userTs === -1 || userTs > realTs) {
    return now();
  }
  return userTs;
}

/**
 * 检查时间戳是否在指定范围内
 * 
 * @param ts - 待检查的时间戳
 * @param start - 开始时间戳
 * @param end - 结束时间戳
 * @returns 在范围内返回 true，否则返回 false
 */
export function checkBetween(ts: number, start: number, end: number): boolean {
  return ts >= start && ts <= end;
}

/**
 * 检查两个时间戳是否属于不同的时间单位
 * 
 * 用于判断是否进入新的周期（如每日、每周任务刷新）。
 * 
 * @param ts1 - 第一个时间戳
 * @param ts2 - 第二个时间戳
 * @param type - 时间单位类型（day, week, month 等）
 * @param delta - 时间偏移量（毫秒），默认为 14400000（4小时）
 * @returns 属于不同周期返回 true，否则返回 false
 */
export function checkNew(
  ts1: number,
  ts2: number,
  type: StartOf,
  delta = 14400000,
): boolean {
  // 修复：时间戳可能是秒级（now() 返回 moment().unix()，~1.7e9）或毫秒级
  //（moment().valueOf()，~1.7e12）。原实现把秒直接传给 moment(number)（按毫秒解析）
  // → 相邻两天（86400s）被当作同一"天"，每日/每周/每月刷新永不触发。
  // 按量级自动归一：> 1e11 视为毫秒，否则视为秒 ×1000；delta 语义为毫秒（默认 4h）。
  const ms1 = ts1 > 1e11 ? ts1 - delta : ts1 * 1000 - delta;
  const ms2 = ts2 > 1e11 ? ts2 - delta : ts2 * 1000 - delta;
  return !moment(ms1).isSame(moment(ms2), type);
}

/**
 * 本地时区紧凑日期 YYYYMMDD（缺省当前时间）
 *
 * 收敛此前手写 padStart 句式 ×6（logger/log-service/capture-player/shop/AdminService）：
 * 日志文件名后缀、抓包默认会话名、信用商店周期 id、备份文件名日期段等。
 *
 * @param d - Date 对象，缺省 new Date()
 * @returns 形如 `20260825` 的字符串
 */
export function formatDateCompact(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * 本地时区紧凑时间戳 YYYYMMDD-HHmmss（缺省当前时间）
 *
 * 备份文件名等需要秒级但禁用冒号的场景（AdminService.formatTs 原句式）。
 *
 * @param d - Date 对象，缺省 new Date()
 * @returns 形如 `20260825-143000` 的字符串
 */
export function formatCompactTimestamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${formatDateCompact(d)}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * 本地时区日志时间戳 YYYY-MM-DD HH:mm:ss（缺省当前时间）
 *
 * logger 行级时间戳原句式。
 *
 * @param d - Date 对象，缺省 new Date()
 * @returns 形如 `2026-08-25 14:30:00` 的字符串
 */
export function formatTimestamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 距今天数（moment 语义：moment().diff(moment(ts), "days")）
 *
 * 收敛 medal.ts 中逐字重复 ×78 的注册天数表达式。**刻意不做秒/毫秒归一**——
 * 与被替换的原表达式完全同语义（registerTs 按原样交给 moment），避免改变既有
 * 勋章数值；如需归一化应连同调用方一起评估。
 *
 * @param ts - 注册时间戳（原样传给 moment，与历史行为一致）
 * @returns 整数天数差（可为负）
 */
export function daysSince(ts: number | string | Date): number {
  return moment().diff(moment(ts as never), "days");
}