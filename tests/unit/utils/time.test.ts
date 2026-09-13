import { describe, it, expect, afterEach } from 'vitest';
import moment from 'moment';
import { now, realNow, virtualNow, parseVirtualTime, checkBetween, checkNew, userTimestamp } from '@utils/time';
import config from '@core/config/index';

describe('now', () => {
  it('应该返回当前时间戳（秒）', () => {
    const before = Math.floor(Date.now() / 1000);
    const result = now();
    const after = Math.floor(Date.now() / 1000);
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
    expect(Number.isInteger(result)).toBe(true);
  });

  it('返回值应该是有效的 Unix 时间戳', () => {
    const result = now();
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(9999999999);
  });

  it('连续调用应该返回递增或相同的值', () => {
    const first = now();
    const second = now();
    expect(second).toBeGreaterThanOrEqual(first);
  });
});

describe('checkBetween', () => {
  it('当时间戳在范围内时应该返回 true', () => {
    const start = 1000;
    const end = 2000;
    expect(checkBetween(1500, start, end)).toBe(true);
    expect(checkBetween(1000, start, end)).toBe(true);
    expect(checkBetween(2000, start, end)).toBe(true);
  });

  it('当时间戳在范围外时应该返回 false', () => {
    const start = 1000;
    const end = 2000;
    expect(checkBetween(999, start, end)).toBe(false);
    expect(checkBetween(2001, start, end)).toBe(false);
    expect(checkBetween(0, start, end)).toBe(false);
    expect(checkBetween(5000, start, end)).toBe(false);
  });

  it('边界值应该返回 true', () => {
    expect(checkBetween(100, 100, 200)).toBe(true);
    expect(checkBetween(200, 100, 200)).toBe(true);
    expect(checkBetween(100, 100, 100)).toBe(true);
  });

  it('当 start 大于 end 时应该正确处理', () => {
    expect(checkBetween(1500, 2000, 1000)).toBe(false);
    expect(checkBetween(1500, 1000, 2000)).toBe(true);
  });

  it('应该处理相同的 start 和 end', () => {
    expect(checkBetween(100, 100, 100)).toBe(true);
    expect(checkBetween(99, 100, 100)).toBe(false);
    expect(checkBetween(101, 100, 100)).toBe(false);
  });
});

describe('checkNew', () => {
  it('当两个时间戳在同一天时应该返回 false', () => {
    const ts1 = moment('2024-01-15T10:00:00').valueOf();
    const ts2 = moment('2024-01-15T14:00:00').valueOf();
    expect(checkNew(ts1, ts2, 'day')).toBe(false);
  });

  it('当两个时间戳在不同天时应该返回 true（考虑 4h delta 偏移）', () => {
    const ts1 = moment('2024-01-15T23:00:00').valueOf();
    const ts2 = moment('2024-01-16T05:00:00').valueOf();
    expect(checkNew(ts1, ts2, 'day')).toBe(true);
  });

  it('当两个时间戳在不同周时应该返回 true', () => {
    const ts1 = moment('2024-01-15').valueOf();
    const ts2 = moment('2024-01-22').valueOf();
    expect(checkNew(ts1, ts2, 'week')).toBe(true);
  });

  it('当两个时间戳在同一周时应该返回 false', () => {
    const ts1 = moment('2024-01-15').valueOf();
    const ts2 = moment('2024-01-16').valueOf();
    expect(checkNew(ts1, ts2, 'week')).toBe(false);
  });

  it('应该使用默认的 delta 参数（4 小时）', () => {
    const ts1 = moment('2024-01-15T20:00:00').valueOf();
    const ts2 = moment('2024-01-16T05:00:00').valueOf();
    expect(checkNew(ts1, ts2, 'day')).toBe(true);
  });

  it('应该接受自定义的 delta 参数', () => {
    const ts1 = moment('2024-01-15T12:00:00').valueOf();
    const ts2 = moment('2024-01-15T13:00:00').valueOf();
    const result = checkNew(ts1, ts2, 'day', 3600000);
    expect(typeof result).toBe('boolean');
  });

  it('当两个时间戳相同时应该返回 false', () => {
    const ts = moment('2024-06-15T12:00:00').valueOf();
    expect(checkNew(ts, ts, 'day')).toBe(false);
  });

  it('应该正确处理月份边界（考虑 4h delta 偏移）', () => {
    const ts1 = moment('2024-01-31T23:00:00').valueOf();
    const ts2 = moment('2024-02-01T05:00:00').valueOf();
    expect(checkNew(ts1, ts2, 'day')).toBe(true);
    expect(checkNew(ts1, ts2, 'month')).toBe(true);
  });

  it('秒级时间戳（now() 返回 unix 秒）在不同天时应该返回 true', () => {
    // 模拟生产场景：秒级时间戳 + 默认 delta（4 小时毫秒）
    const ts1 = 1738216849; // 2025-01-30T14:00:49+08:00
    const ts2 = 1785902603; // 2026-08-05T12:03:23+08:00
    expect(checkNew(ts1, ts2, 'day')).toBe(true);
  });

  it('秒级时间戳在同一天时应该返回 false', () => {
    const ts1 = 1738216849; // 2025-01-30T14:00:49+08:00
    const ts2 = 1738234449; // 2025-01-30T18:54:09+08:00（同日）
    expect(checkNew(ts1, ts2, 'day')).toBe(false);
  });
});

describe('userTimestamp（activity 切换 developer.timestamp）', () => {
  const original = config.developer;

  afterEach(() => {
    config.developer = original;
  });

  it('缺省（无 developer.timestamp）→ 真实时间', () => {
    delete config.developer;
    const ts = userTimestamp();
    expect(Math.abs(ts - now())).toBeLessThan(5);
  });

  it('-1 → 真实时间', () => {
    config.developer = { timestamp: -1 };
    const ts = userTimestamp();
    expect(Math.abs(ts - now())).toBeLessThan(5);
  });

  it('冻结到过去时间戳 → 返回冻结值', () => {
    config.developer = { timestamp: 1597132800 };
    expect(userTimestamp()).toBe(1597132800);
  });

  it('未来时间戳 → 回退真实时间（DoctoratePy 规则）', () => {
    config.developer = { timestamp: now() + 999999 };
    const ts = userTimestamp();
    expect(Math.abs(ts - now())).toBeLessThan(5);
  });
});

describe('virtualtime（DoctoratePy server.virtualtime 移植）', () => {
  const originalVirtualTime = config.virtualtime;
  const originalDeveloper = config.developer;

  afterEach(() => {
    config.virtualtime = originalVirtualTime;
    config.developer = originalDeveloper;
  });

  /** 本地时区期望值（与解析实现同源，避免测试机时区差异） */
  const localTs = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) =>
    Math.floor(new Date(y, mo - 1, d, h, mi, s).getTime() / 1000);

  it('缺省 / 负数 / 0 / 非有限数 → 未启用（回退真实时间）', () => {
    for (const value of [undefined, -1, -114514, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      config.virtualtime = value;
      expect(parseVirtualTime(value)).toBeNull();
      expect(Math.abs(virtualNow() - realNow())).toBeLessThan(5);
      expect(Math.abs(now() - realNow())).toBeLessThan(5);
    }
  });

  it('数值 > 0 → 冻结该时间戳（now/virtualNow 同源，realNow 不受影响）', () => {
    config.virtualtime = 1597132800;
    expect(virtualNow()).toBe(1597132800);
    expect(now()).toBe(1597132800);
    expect(Math.abs(realNow() - Date.now() / 1000)).toBeLessThan(5);
  });

  it('允许未来时间戳（推进到后续卡池/活动）', () => {
    const future = realNow() + 86400 * 30;
    config.virtualtime = future;
    expect(now()).toBe(future);
  });

  it('五种字符串日期格式均按本地时区解析', () => {
    const expected = localTs(2024, 6, 13, 12, 12, 12);
    for (const text of [
      '2024/06/13 12:12:12',
      '13062024 12:12:12',
      '13-06-2024 12:12:12',
      '2024-06-13 12:12:12',
      '20240613 12:12:12',
    ]) {
      config.virtualtime = text;
      expect(virtualNow()).toBe(expected);
    }
  });

  it('月/日/时/分/秒允许 1~2 位（对齐 Python strptime）', () => {
    config.virtualtime = '2024/6/3 1:2:3';
    expect(virtualNow()).toBe(localTs(2024, 6, 3, 1, 2, 3));
  });

  it('空白归一：首尾空白与多空格不影响解析', () => {
    config.virtualtime = '  2024/06/13    12:12:12  ';
    expect(virtualNow()).toBe(localTs(2024, 6, 13, 12, 12, 12));
  });

  it('非法字符串 / 空串 / 缺时间 / 越界日期 → 回退真实时间', () => {
    for (const text of ['', '   ', 'not-a-time', '2024/06/13', '2024-13-45 99:99:99', '2024-02-31 00:00:00']) {
      config.virtualtime = text;
      expect(parseVirtualTime(text)).toBeNull();
      expect(Math.abs(virtualNow() - realNow())).toBeLessThan(5);
    }
  });

  it('布尔/null → 回退真实时间（手工改坏 config 不抛错）', () => {
    delete config.virtualtime;
    for (const value of [true, false, null]) {
      expect(parseVirtualTime(value)).toBeNull();
    }
    expect(Math.abs(virtualNow() - realNow())).toBeLessThan(5);
  });

  it('纯数字串视同数值配置（> 0 冻结，0 视为未启用）', () => {
    config.virtualtime = '1597132800';
    expect(virtualNow()).toBe(1597132800);
    config.virtualtime = '0';
    expect(parseVirtualTime('0')).toBeNull();
  });

  it('userTimestamp 无 developer.timestamp 时跟随虚拟时钟', () => {
    delete config.developer;
    config.virtualtime = 1597132800;
    expect(userTimestamp()).toBe(1597132800);
  });

  it('developer.timestamp 优先于虚拟时钟（真实过去、虚拟未来仍生效）', () => {
    config.virtualtime = 1597132800;
    config.developer = { timestamp: 1700000000 };
    expect(userTimestamp()).toBe(1700000000);
  });
});