/**
 * Unity 日志回传存储单测（app/ops/plugin/plugin-log-store.ts）
 *
 * 覆盖三件事：
 *   1. 分片重组：乱序 / 重复 / 凑齐才落盘；
 *   2. 输入收敛：非法标识与序号被拒、正文/堆栈/级别/条数按上限归一（客户端可伪造）；
 *   3. 落盘与索引：meta 会话索引、级别过滤、轮转、清空。
 *
 * 全部用临时目录（`mkdtempSync`），不触碰仓库 data/。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { JsonValue } from "@core/utils/json-value";
import { PluginLogStore } from "@ops/plugin/plugin-log-store";

/** 临时日志目录 */
let dir: string;
/** 被测存储实例 */
let store: PluginLogStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dts-unity-log-"));
  store = new PluginLogStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * 把信封编码成分片并逐个推给存储。
 * @param target    目标存储实例
 * @param sid       会话标识
 * @param batchId   批次标识
 * @param envelope  信封
 * @param chunkSize 切片大小（故意取小值以便制造多片）
 * @returns 是否凑齐
 */
function pushEnvelope(
  target: PluginLogStore,
  sid: string,
  batchId: string,
  envelope: JsonValue,
  chunkSize = 40,
): boolean {
  const b64 = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += chunkSize) chunks.push(b64.slice(i, i + chunkSize));
  if (chunks.length === 0) chunks.push("");
  let done = false;
  for (let i = 0; i < chunks.length; i++) {
    if (target.pushChunk(sid, batchId, i + 1, chunks.length, chunks[i])) done = true;
  }
  return done;
}

/**
 * 构造一个最小信封。
 * @param records 记录列表
 * @returns 信封
 */
function envelope(records: JsonValue[]): JsonValue {
  return {
    v: 1,
    sid: "dts_Android_1a2b3c",
    seq: 0,
    ts: 1730000000,
    dropped: 0,
    device: { platform: "Android" },
    records,
  };
}

describe("PluginLogStore 分片重组", () => {
  it("乱序到达、重复分片都能拼齐并落盘", () => {
    const env = envelope([
      { t: 1, l: "E", m: "boom" },
      { t: 2, l: "W", m: "careful" },
    ]);
    const b64 = Buffer.from(JSON.stringify(env), "utf8").toString("base64url");
    const chunkSize = 30;
    const chunks: string[] = [];
    for (let i = 0; i < b64.length; i += chunkSize) chunks.push(b64.slice(i, i + chunkSize));
    expect(chunks.length).toBeGreaterThan(1);

    // 先发第 2..N 片（故意让第 1 片最后到）：始终未凑齐
    for (let i = 2; i <= chunks.length; i++) {
      expect(store.pushChunk("s1", "b1", i, chunks.length, chunks[i - 1])).toBe(false);
    }
    // 重复片不改变状态
    expect(store.pushChunk("s1", "b1", 2, chunks.length, chunks[1])).toBe(false);
    // 补上第 1 片：凑齐
    expect(store.pushChunk("s1", "b1", 1, chunks.length, chunks[0])).toBe(true);

    const records = store.readRecords("s1", { limit: 10 });
    expect(records.map((r) => r.m)).toEqual(["boom", "careful"]);
    expect(records[0].l).toBe("E");
    expect(records[0].receivedAt).toBeGreaterThan(0);

    const sessions = store.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sid: "s1", records: 2, errors: 1, warnings: 1, batches: 1 });
    expect(sessions[0].device.platform).toBe("Android");
  });

  it("缺片时整批不落盘", () => {
    const env = envelope([{ l: "E", m: "never landed" }]);
    const b64 = Buffer.from(JSON.stringify(env), "utf8").toString("base64url");
    store.pushChunk("s1", "b1", 2, 3, b64.slice(0, 10));
    expect(store.readRecords("s1")).toEqual([]);
    expect(store.listSessions()).toEqual([]);
  });

  it("非法标识/序号/字符集一律拒绝（防路径穿越与灌入）", () => {
    expect(store.pushChunk("../evil", "b1", 1, 1, "AAAA")).toBe(false);
    expect(store.pushChunk("s1", "a/b", 1, 1, "AAAA")).toBe(false);
    expect(store.pushChunk("s1", "b1", 0, 1, "AAAA")).toBe(false);
    expect(store.pushChunk("s1", "b1", 3, 2, "AAAA")).toBe(false);
    expect(store.pushChunk("s1", "b1", 1, 1, "not+base64")).toBe(false);
    expect(store.pushChunk("s1", "b1", 1, 99999, "AAAA")).toBe(false);
    expect(existsSync(join(dir, "s1.ndjson"))).toBe(false);
  });

  it("损坏的 base64/JSON 批次被丢弃且不抛错", () => {
    const bad = Buffer.from("not json at all", "utf8").toString("base64url");
    expect(store.pushChunk("s1", "b1", 1, 1, bad)).toBe(true);
    expect(store.readRecords("s1")).toEqual([]);
  });
});

describe("PluginLogStore 输入收敛", () => {
  it("级别归一、正文截断、堆栈保留、重复计数保留", () => {
    const longText = "x".repeat(9000);
    pushEnvelope(store, "s1", "b1", {
      v: 1,
      sid: "s1",
      dropped: 3,
      device: { platform: "Android", nested: { a: 1 } },
      records: [
        { l: "x", m: "unknown level" },
        { l: "W", m: longText, s: "stack line", c: 7 },
        { l: "E", m: 42 },
      ],
    });

    const records = store.readRecords("s1", { limit: 10 });
    // 第三条 msg 不是字符串 → 丢弃
    expect(records).toHaveLength(2);
    expect(records[0].l).toBe("I");
    expect(records[1].l).toBe("W");
    expect(records[1].s).toBe("stack line");
    expect(records[1].c).toBe(7);
    expect(records[1].m.length).toBeLessThan(longText.length);

    const info = store.listSessions()[0];
    expect(info.dropped).toBe(3);
    // 设备字段只保留标量
    expect(info.device).toEqual({ platform: "Android" });
  });

  it("单批条数上限生效", () => {
    const records: JsonValue[] = [];
    for (let i = 0; i < 2100; i++) records.push({ l: "I", m: `m${i}` });
    pushEnvelope(store, "s1", "b1", { v: 1, records }, 4096);
    const info = store.listSessions()[0];
    expect(info.records).toBeLessThanOrEqual(2000);
  });
});

describe("PluginLogStore 查询与维护", () => {
  it("级别过滤 + 会话列表 + 全局统计", () => {
    pushEnvelope(store, "s1", "b1", envelope([{ l: "E", m: "e1" }, { l: "W", m: "w1" }, { l: "I", m: "i1" }]));
    pushEnvelope(store, "s2", "b1", envelope([{ l: "E", m: "e2" }]));

    expect(store.readRecords("s1", { level: "E" }).map((r) => r.m)).toEqual(["e1"]);
    expect(store.readRecords("s1", { limit: 1 }).map((r) => r.m)).toEqual(["i1"]);

    expect(store.listSessions()).toHaveLength(2);

    const stats = store.stats();
    expect(stats).toMatchObject({ sessions: 2, records: 4, errors: 2, warnings: 1 });
    expect(stats.bytes).toBeGreaterThan(0);
    expect(stats.dir).toBe(dir);
  });

  it("超过单会话上限时轮转到 <sid>.1.ndjson 并标记 truncated", () => {
    const small = new PluginLogStore(dir, 200);
    const big = `m${"y".repeat(200)}`;
    for (let i = 0; i < 5; i++) {
      pushEnvelope(small, "s1", `b${i}`, { v: 1, records: [{ l: "E", m: big }] });
    }
    expect(existsSync(join(dir, "s1.1.ndjson"))).toBe(true);
    const info = small.listSessions().find((s) => s.sid === "s1");
    expect(info?.truncated).toBe(true);
  });

  it("清空单会话与全部", () => {
    pushEnvelope(store, "s1", "b1", envelope([{ l: "E", m: "e1" }]));
    pushEnvelope(store, "s2", "b1", envelope([{ l: "E", m: "e2" }]));
    expect(store.clear("s1")).toBeGreaterThan(0);
    expect(store.listSessions().map((s) => s.sid)).toEqual(["s2"]);
    expect(store.clear()).toBeGreaterThan(0);
    expect(store.listSessions()).toEqual([]);
    expect(store.clear("bad/../id")).toBe(0);
  });

  it("落盘为 NDJSON（一行一条，可被外部工具直接消费）", () => {
    pushEnvelope(store, "s1", "b1", envelope([{ l: "E", m: "e1" }, { l: "I", m: "i1" }]));
    const lines = readFileSync(join(dir, "s1.ndjson"), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ sid: "s1", batchId: "b1", l: "E", m: "e1" });
    expect(existsSync(join(dir, "s1.meta.json"))).toBe(true);
  });
});
