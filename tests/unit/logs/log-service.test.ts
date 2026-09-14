import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { logService, registerAuditLogSource } from "@logs/log-service";
import { logger } from "@utils/logger";

// 测试专用独立临时日志目录（LOG_DIR 注入），绝不碰真实 logs/
const tempDirs: string[] = [];

const SERVER_LOG = `2026-01-01 10:00:00 [INFO] [index] 启动完成
2026-01-01 10:00:01 [WARN] [capture] 端口被占
2026-01-01 10:00:02 [ERROR] [BattleManager] 结算失败: boom
2026-01-01 10:00:03 [INFO] [capture] 抓包记录成功
bad line without format
`;

const WATCHDOG_LOG = `2026-01-01 09:00:00 [watchdog] 启动
2026-01-01 09:01:00 [watchdog] 退出
`;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logsvc-"));
  tempDirs.push(dir);
  process.env.LOG_DIR = dir;
  fs.writeFileSync(path.join(dir, "server-20260101.log"), SERVER_LOG);
  fs.writeFileSync(path.join(dir, "watchdog-20260101.log"), WATCHDOG_LOG);
});

afterEach(() => {
  registerAuditLogSource(undefined);
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.LOG_DIR;
});

describe("logService（统一日志服务）", () => {
  it("listServerLogDates 扫描 server-*.log 并按日期倒序", async () => {
    expect(await logService.listServerLogDates()).toEqual(["20260101"]);
  });

  it("readServerLog 解析行 + 级别/标签/关键字过滤 + 倒序分页", async () => {
    const all = await logService.readServerLog({ date: "20260101" });
    expect(all.total).toBe(4);
    // 倒序：最新在前
    expect(all.items[0].text).toBe("抓包记录成功");
    expect(all.items[3].text).toBe("启动完成");
    // 跳过格式不符的行
    expect(all.items.some((e) => e.raw.includes("bad line"))).toBe(false);

    const byLevel = await logService.readServerLog({ date: "20260101", level: "WARN" });
    expect(byLevel.total).toBe(1);
    expect(byLevel.items[0].tag).toBe("capture");

    const byTag = await logService.readServerLog({ date: "20260101", tag: "capture" });
    expect(byTag.total).toBe(2);

    const byQ = await logService.readServerLog({ date: "20260101", q: "boom" });
    expect(byQ.total).toBe(1);
    expect(byQ.items[0].level).toBe("ERROR");

    const page = await logService.readServerLog({ date: "20260101", limit: 2, offset: 0 });
    expect(page.items.length).toBe(2);
    expect(page.total).toBe(4);
  });

  it("readServerLog 指定日期文件缺失返回空", async () => {
    const r = await logService.readServerLog({ date: "19990101" });
    expect(r.total).toBe(0);
    expect(r.items).toEqual([]);
  });

  it("readWatchdogLog 读取看门狗日志行（含文件名，最新在前）", async () => {
    const r = await logService.readWatchdogLog();
    expect(r.files).toEqual(["watchdog-20260101.log"]);
    expect(r.entries.length).toBe(2);
    expect(r.entries[0].line).toContain("[watchdog] 退出");
    expect(r.entries[1].line).toContain("[watchdog] 启动");
  });

  it("clearServerLogs 需要确认词；CLEAR 后删除 server 日志（保留 watchdog）", async () => {
    await expect(logService.clearServerLogs("no")).rejects.toThrow(/CLEAR/);
    const r = await logService.clearServerLogs("CLEAR");
    expect(r.cleared).toBe(1);
    expect(fs.existsSync(path.join(process.env.LOG_DIR!, "server-20260101.log"))).toBe(false);
    expect(fs.existsSync(path.join(process.env.LOG_DIR!, "watchdog-20260101.log"))).toBe(true);
  });

  it("listServerLogDates 忽略轮转归档；clearServerLogs 一并清归档", async () => {
    const dir = process.env.LOG_DIR!;
    fs.writeFileSync(path.join(dir, "server-20260101.log.1"), "arch line\n");
    // 归档文件不计入日期列表（只列一天）
    expect(await logService.listServerLogDates()).toEqual(["20260101"]);
    // 手动清空同样删除归档文件
    const r = await logService.clearServerLogs("CLEAR");
    expect(r.cleared).toBe(2);
    expect(fs.existsSync(path.join(dir, "server-20260101.log.1"))).toBe(false);
  });

  it("subscribeServer 收到 logger 实时事件（级别过滤后）", () => {
    const events: string[] = [];
    const unsub = logService.subscribeServer((e) => events.push(`${e.level}:${e.tag}:${e.text}`));
    logger.info("logsvc-tag", "live-1");
    logger.error("logsvc-tag", "live-2");
    expect(events).toEqual(["info:logsvc-tag:live-1", "error:logsvc-tag:live-2"]);
    unsub();
    logger.info("logsvc-tag", "live-3");
    expect(events.length).toBe(2);
  });

  it("subscribeAudit/emitAudit 实时审计订阅", () => {
    const events: string[] = [];
    const unsub = logService.subscribeAudit((e) => events.push(`${e.action}:${e.uid}:${e.detail}`));
    logService.emitAudit({ ts: 1, action: "grantItem", uid: "1", detail: "4001 x10" });
    expect(events).toEqual(["grantItem:1:4001 x10"]);
    unsub();
    logService.emitAudit({ ts: 2, action: "x", uid: "", detail: "" });
    expect(events.length).toBe(1);
  });

  it("audit 经已注册 AuditLogSource.append 写入（core 侧安全事件）", async () => {
    const written: string[] = [];
    registerAuditLogSource({
      logs: async () => [],
      append: async (action, uid, detail) => {
        written.push(`${action}:${uid}:${detail}`);
      },
    });
    await logService.audit("authLoginFailed", "", "账号=138***00 ip=10.0.0.1");
    expect(written).toEqual(["authLoginFailed::账号=138***00 ip=10.0.0.1"]);
    // 读取端口未受影响（同一实现同时提供读写）
    expect(await logService.readAuditLog()).toEqual([]);
  });

  it("audit 写入端未注册/写入抛错时不阻断调用方", async () => {
    // 未注册：降级为普通日志
    await expect(logService.audit("authLogin", "1", "ok")).resolves.toBeUndefined();
    // 写入端抛错：捕获后正常返回
    registerAuditLogSource({
      logs: async () => [],
      append: async () => {
        throw new Error("disk full");
      },
    });
    await expect(logService.audit("authLogin", "1", "ok")).resolves.toBeUndefined();
  });
});
