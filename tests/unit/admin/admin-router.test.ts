import { describe, it, expect, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import type { JsonValue } from "@excel/json-value";
import { asModel } from "../../helpers";

vi.mock("@ops/admin/admin-service", () => ({
  adminService: {
    status: vi.fn().mockResolvedValue({ online: true }),
    listUsers: vi.fn().mockResolvedValue([{ uid: "1" }]),
    getUserInfo: vi.fn().mockResolvedValue(null),
    createUser: vi.fn().mockResolvedValue("2222"),
    reloadUser: vi.fn().mockResolvedValue(undefined),
    grantItem: vi.fn().mockResolvedValue(undefined),
    grantChar: vi.fn().mockResolvedValue({ isNew: 1, name: "阿米娅" }),
    grantSkin: vi.fn().mockResolvedValue(undefined),
    listChars: vi.fn().mockResolvedValue([{ instId: 1, name: "阿米娅" }]),
    getCharDetail: vi.fn().mockResolvedValue(null),
    getShopSummary: vi.fn().mockResolvedValue({ types: [{ type: "LS", items: 1 }], total: 1 }),
    getCheckInState: vi.fn().mockResolvedValue({ groupId: "group1", total: 1, rewardIndex: 0 }),
    resetCheckIn: vi.fn().mockResolvedValue({ groupId: "group1", total: 1, rewardIndex: -1 }),
    doCheckIn: vi.fn().mockResolvedValue({ rewards: [{ id: "4001", name: "龙门币", count: 100 }], state: {} }),
    setCharAttrs: vi.fn().mockResolvedValue({ instId: 1, name: "阿米娅", level: 90 }),
    maxOutAccount: vi.fn().mockResolvedValue({ chars: 1, items: 10, skins: 2, rooms: 1 }),
    buildingMax: vi.fn().mockResolvedValue({ rooms: 3 }),
    backup: vi.fn().mockResolvedValue({ name: "1-20250101000000.json", size: 10 }),
    listBackups: vi.fn().mockResolvedValue([{ name: "1-20250101000000.json", size: 10 }]),
    restore: vi.fn().mockResolvedValue(undefined),
    getRawJson: vi.fn().mockResolvedValue({ status: { uid: "1" } }),
    listMails: vi.fn().mockResolvedValue([{ mailId: 1000001, subject: "欢迎" }]),
    deleteMail: vi.fn().mockResolvedValue(true),
    sendMail: vi.fn().mockResolvedValue({ mailId: 1000000 }),
    sendMailAll: vi.fn().mockResolvedValue({ sent: 2 }),
    refreshUser: vi.fn().mockResolvedValue(undefined),
    saveUser: vi.fn().mockResolvedValue(undefined),
    stats: vi.fn().mockResolvedValue({ userCount: 1, avgLevel: 60 }),
    logs: vi.fn().mockResolvedValue([{ ts: 1, action: "grantItem", uid: "1", detail: "x" }]),
    getCommonItems: vi.fn().mockResolvedValue([{ name: "龙门币", id: "4001" }]),
    getMailTemplates: vi.fn().mockReturnValue([{ name: "补偿", subject: "补偿发放", items: 2 }]),
    gameProxy: vi.fn().mockResolvedValue({ status: 200, data: {}, uid: "1" }),
    listPools: vi.fn().mockResolvedValue([{ poolId: "NORMAL_0_1", name: "测试卡池" }]),
    poolDetail: vi.fn().mockReturnValue(null),
    getPlayerPoolState: vi.fn().mockResolvedValue({ poolId: "NORMAL_0_1", upCharIds: [], beforeNonHitCnt: 0 }),
    setPlayerPoolUp: vi.fn().mockResolvedValue({ poolId: "NORMAL_0_1", upCharIds: ["char_002_amiya"] }),
    setPlayerPity: vi.fn().mockResolvedValue({ uid: "1", ruleType: "NORMAL", beforeNonHitCnt: 42 }),
    migrateOfficial: vi.fn().mockResolvedValue([{ phone: "13800000000", uid: "2", nickName: "A" }]),
    officialAction: vi.fn().mockResolvedValue({ action: "signin", ok: true, data: "签到成功" }),
    officialCall: vi.fn().mockResolvedValue({ cgi: "/mail/getMetaInfoList", result: {} }),
    syncGachaPools: vi.fn().mockResolvedValue({ total: 2, ok: 1, failed: [], updated: 1 }),
    grantAllItems: vi.fn().mockResolvedValue({ items: 4 }),
    maxAllChars: vi.fn().mockResolvedValue({ chars: 10 }),
    repairChars: vi.fn().mockResolvedValue({ chars: 3, fields: 8 }),
    listStages: vi.fn().mockResolvedValue({ total: 2, done: 1, stages: [] }),
    unlockStage: vi.fn().mockResolvedValue({ stageId: "main_01-01" }),
    unlockAllStages: vi.fn().mockResolvedValue({ stages: 5, total: 100 }),
    searchItems: vi.fn().mockReturnValue([{ id: "4001", name: "龙门币", classifyType: "NORMAL" }]),
    listMissionStats: vi.fn().mockResolvedValue({ total: 10, done: 3, groups: [] }),
    listMedals: vi.fn().mockResolvedValue({ total: 5, unlocked: 2, medals: [] }),
    exportUser: vi.fn().mockResolvedValue({ uid: "1", path: "./exports/1-x.json", size: 10 }),
    importUser: vi.fn().mockResolvedValue({ uid: "1" }),
    checkData: vi.fn().mockResolvedValue({ ok: true, users: [{ uid: "1", ok: true }] }),
    checkDataFiles: vi.fn().mockResolvedValue({ ok: true, files: [{ uid: "1", ok: true }] }),
    getActivitySummary: vi.fn().mockResolvedValue({ total: 3, types: [{ type: "LOGIN_ONLY", activities: 2 }] }),
    getMapvizData: vi.fn().mockResolvedValue({ themes: { rogue_1: { normal: ["ro1_n_1_1"], elite: [], boss: [], zones: {} } }, grid: { constructions: [{ layerIndex: 0 }], distanceRules: [], countRules: [], layerTypes: [] } }),
    rogueSimAuto: vi.fn().mockResolvedValue({ ok: true, steps: [{ step: 1, action: "createGame", zone: 0, state: "INIT" }], final: { current: { player: { state: "END" } } } }),
    rogueSimStep: vi.fn().mockResolvedValue({ ok: true, state: { current: { player: { state: "WAIT_MOVE" } } } }),
    rogueSimState: vi.fn().mockResolvedValue({ current: { player: { state: "NONE" } } }),
    uploadPixelArt: vi.fn().mockResolvedValue({ pixelArtId: "1001", uploadToken: "t", httpResp: {} }),
    uploadPixelArtBatch: vi.fn().mockResolvedValue([{ index: 0, ok: true, pixelArtId: "1001" }, { index: 1, ok: true, pixelArtId: "1002" }]),
    getPixelArtList: vi.fn().mockResolvedValue([{ id: "1001", url: "https://x/y.dat", isBanned: false, pixels: [] }]),
    deletePixelArt: vi.fn().mockResolvedValue([{ id: "1001", ok: true }]),
  },
}));
vi.mock("@ops/admin/admin-auth", () => ({
  adminAuth: vi.fn((_req: Request, _res: Response, next: NextFunction) => next()),
}));
vi.mock("@ops/admin/cli-exec", () => ({
  cliExec: vi.fn(),
}));
vi.mock("@core/config/index", () => ({ default: {} }));
vi.mock("@capture/capture-manager", () => ({
  captureManager: {
    listSessions: vi.fn().mockResolvedValue([{ id: "s-1", name: "登录链路", source: "official", recordCount: 3 }]),
    startSession: vi.fn().mockResolvedValue({ id: "s-new", name: "x", source: "private", startedAt: 1, endedAt: null, note: null }),
    stopSession: vi.fn().mockResolvedValue(true),
    deleteSession: vi.fn().mockResolvedValue(2),
    query: vi.fn().mockResolvedValue({ total: 1, offset: 0, limit: 100, items: [{ id: 1, rid: "R-1", path: "/a" }] }),
    getRecordDetail: vi.fn().mockResolvedValue({ id: 1, rid: "R-1", reqBody: {}, resBody: {}, missingFiles: [] }),
    deleteRecord: vi.fn().mockResolvedValue(true),
    clearAll: vi.fn().mockResolvedValue({ cleared: 5 }),
    stats: vi.fn().mockResolvedValue({ total: 5, sessions: 1, bySource: { private: 5 }, byStatus: {}, byDay: [] }),
    exportSession: vi.fn().mockResolvedValue({ path: "tmp/capture/exports/x.zip", records: 3, size: 10 }),
    exportRecord: vi.fn().mockResolvedValue({ path: "tmp/capture/exports/r.zip", records: 1, size: 10 }),
    subscribe: vi.fn(() => () => {}),
  },
}));
vi.mock("@logs/log-service", () => ({
  logService: {
    readServerLog: vi.fn().mockResolvedValue({ total: 1, offset: 0, limit: 100, items: [{ ts: "2026-01-01 10:00:00", level: "INFO", tag: "index", text: "hi", raw: "..." }] }),
    listServerLogDates: vi.fn().mockResolvedValue(["20260814"]),
    readWatchdogLog: vi.fn().mockResolvedValue({ files: ["watchdog-20260814.log"], entries: [{ file: "watchdog-20260814.log", line: "x" }] }),
    readAuditLog: vi.fn().mockResolvedValue([{ ts: 1, action: "grantItem", uid: "1", detail: "x" }]),
    clearServerLogs: vi.fn().mockResolvedValue({ cleared: 2 }),
    subscribeServer: vi.fn(() => () => {}),
    subscribeAudit: vi.fn(() => () => {}),
  },
}));
vi.mock("@utils/sse", () => ({
  createSse: vi.fn(() => () => {}),
  sseSend: vi.fn(),
}));

import adminRouter from "@ops/admin/admin-router";
import { cliExec } from "@ops/admin/cli-exec";
import { adminService } from "@ops/admin/admin-service";
import { captureManager } from "@capture/capture-manager";
import { logService } from "@logs/log-service";
import { createSse, sseSend } from "@utils/sse";

/** rogueSimAuto 成功/失败返回值（含可选 error） */
type RogueSimAutoResult = Awaited<ReturnType<typeof adminService.rogueSimAuto>>;

/** rogueSimStep 成功/失败返回值（含可选 error） */
type RogueSimStepResult = Awaited<ReturnType<typeof adminService.rogueSimStep>>;

/** res.sendFile 的单签名视图（真实为重载签名，vitest Mock 不可赋给重载函数类型） */
type SendFileFn = (...args: Parameters<Response["sendFile"]>) => void;

/** res.write 的单签名视图（真实为重载签名） */
type ResWriteFn = (...args: Parameters<Response["write"]>) => boolean;

/** 路由测试请求视图：只声明被测分支读到的成员 */
interface MockReq {
  method: string;
  url: string;
  query?: Request["query"];
  params?: Request["params"];
  body?: Record<string, JsonValue>;
  on?: Request["on"];
}

/** 路由测试响应视图：只声明被测分支读到的成员（SSE 流另需 write/flushHeaders） */
interface MockRes {
  send: Response["send"];
  sendFile: SendFileFn;
  status: Response["status"];
  json: Response["json"];
  sendStatus: Response["sendStatus"];
  set: Response["set"];
  write: ResWriteFn;
  flushHeaders: () => void;
}

/** /api/spec 响应体视图（用例只读 endpoints 的 path） */
interface SpecPayload {
  endpoints: { path: string }[];
}

function mockRes(): MockRes {
  return {
    send: vi.fn<Response["send"]>(),
    sendFile: vi.fn<SendFileFn>(),
    status: vi.fn<Response["status"]>().mockReturnThis(),
    json: vi.fn<Response["json"]>(),
    sendStatus: vi.fn<Response["sendStatus"]>(),
    set: vi.fn<Response["set"]>().mockReturnThis(),
    write: vi.fn<ResWriteFn>(),
    flushHeaders: vi.fn(),
  };
}

type RouterReq = Parameters<typeof adminRouter>[0];

async function call(req: MockReq, res: MockRes) {
  adminRouter(req as RouterReq, res as Response, () => {});
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

describe("admin 路由", () => {
  it("GET /dashboard 应返回静态页面", async () => {
    const res = mockRes();
    await call({ method: "GET", url: "/dashboard" }, res);
    expect(res.sendFile).toHaveBeenCalledWith(expect.stringContaining("index.html"));
  });

  it("GET /api/status 应返回服务器状态", async () => {
    const res = mockRes();
    await call({ method: "GET", url: "/api/status" }, res);
    expect(adminService.status).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ online: true });
  });

  it("GET /api/users 应返回用户列表", async () => {
    const res = mockRes();
    await call({ method: "GET", url: "/api/users" }, res);
    expect(res.json).toHaveBeenCalledWith([{ uid: "1" }]);
  });

  it("GET /api/users?filter= 应透传过滤关键字", async () => {
    const res = mockRes();
    await call({ method: "GET", url: "/api/users", query: { filter: "阿米娅" } }, res);
    expect(adminService.listUsers).toHaveBeenCalledWith("阿米娅");
  });

  it("GET /api/users/:uid 用户不存在应返回 404", async () => {
    const res = mockRes();
    await call({ method: "GET", url: "/api/users/999", params: { uid: "999" } }, res);
    expect(adminService.getUserInfo).toHaveBeenCalledWith("999");
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("POST /api/users 应创建用户并返回 201", async () => {
    const res = mockRes();
    await call({ method: "POST", url: "/api/users", body: { phone: "13800000001", password: "pwd" } }, res);
    expect(adminService.createUser).toHaveBeenCalledWith("13800000001", "pwd");
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe("admin 路由（扩展能力）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST /api/users/:uid/grant 应发放物品", async () => {
    const res = mockRes();
    await call(
      { method: "POST", url: "/api/users/1/grant", params: { uid: "1" }, body: { itemId: "4001", count: 100 } },
      res,
    );
    expect(adminService.grantItem).toHaveBeenCalledWith("1", "4001", 100);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it("POST /api/users/:uid/grantchar 应发放干员", async () => {
    const res = mockRes();
    await call(
      { method: "POST", url: "/api/users/1/grantchar", params: { uid: "1" }, body: { charId: "char_002_amiya" } },
      res,
    );
    expect(adminService.grantChar).toHaveBeenCalledWith("1", "char_002_amiya");
    expect(res.json).toHaveBeenCalledWith({ isNew: 1, name: "阿米娅" });
  });

  it("POST /api/users/:uid/grantskin 应解锁皮肤", async () => {
    const res = mockRes();
    await call(
      { method: "POST", url: "/api/users/1/grantskin", params: { uid: "1" }, body: { skinId: "char_002_amiya#2" } },
      res,
    );
    expect(adminService.grantSkin).toHaveBeenCalledWith("1", "char_002_amiya#2");
  });

  it("GET /api/users/:uid/chars 应返回干员列表", async () => {
    const res = mockRes();
    await call({ method: "GET", url: "/api/users/1/chars", params: { uid: "1" } }, res);
    expect(adminService.listChars).toHaveBeenCalledWith("1");
    expect(res.json).toHaveBeenCalledWith([{ instId: 1, name: "阿米娅" }]);
  });

  it("GET /api/users/:uid/chars/:instId 详情与商店汇总应透传", async () => {
    // 干员详情：不存在应 404
    const res1 = mockRes();
    await call({ method: "GET", url: "/api/users/1/chars/99", params: { uid: "1", instId: "99" } }, res1);
    expect(adminService.getCharDetail).toHaveBeenCalledWith("1", 99);
    expect(res1.status).toHaveBeenCalledWith(404);

    const res2 = mockRes();
    await call({ method: "GET", url: "/api/users/1/shop", params: { uid: "1" } }, res2);
    expect(adminService.getShopSummary).toHaveBeenCalledWith("1");
    expect(res2.json).toHaveBeenCalledWith({ types: [{ type: "LS", items: 1 }], total: 1 });
  });

  it("签到端点应透传（状态/重置/代签）", async () => {
    const res1 = mockRes();
    await call({ method: "GET", url: "/api/users/1/checkin", params: { uid: "1" } }, res1);
    expect(adminService.getCheckInState).toHaveBeenCalledWith("1");

    const res2 = mockRes();
    await call({ method: "POST", url: "/api/users/1/checkin/reset", params: { uid: "1" }, body: {} }, res2);
    expect(adminService.resetCheckIn).toHaveBeenCalledWith("1");

    const res3 = mockRes();
    await call({ method: "POST", url: "/api/users/1/checkin/do", params: { uid: "1" }, body: {} }, res3);
    expect(adminService.doCheckIn).toHaveBeenCalledWith("1");
    expect(res3.json).toHaveBeenCalledWith({
      rewards: [{ id: "4001", name: "龙门币", count: 100 }],
      state: {},
    });
  });

  it("POST /api/users/:uid/chars 应修改干员属性", async () => {
    const res = mockRes();
    await call(
      { method: "POST", url: "/api/users/1/chars", params: { uid: "1" }, body: { instId: 1, level: 90 } },
      res,
    );
    expect(adminService.setCharAttrs).toHaveBeenCalledWith("1", 1, { level: 90 });
  });

  it("POST /api/users/:uid/maxout 应返回满配统计", async () => {
    const res = mockRes();
    await call({ method: "POST", url: "/api/users/1/maxout", params: { uid: "1" }, body: {} }, res);
    expect(adminService.maxOutAccount).toHaveBeenCalledWith("1");
    expect(res.json).toHaveBeenCalledWith({ chars: 1, items: 10, skins: 2, rooms: 1 });
  });

  it("POST /api/users/:uid/building-max 应满级基建", async () => {
    const res = mockRes();
    await call({ method: "POST", url: "/api/users/1/building-max", params: { uid: "1" }, body: {} }, res);
    expect(adminService.buildingMax).toHaveBeenCalledWith("1");
  });

  it("POST /api/users/:uid/backup 与 GET backups / POST restore 应透传", async () => {
    const res1 = mockRes();
    await call({ method: "POST", url: "/api/users/1/backup", params: { uid: "1" }, body: {} }, res1);
    expect(adminService.backup).toHaveBeenCalledWith("1");

    const res2 = mockRes();
    await call({ method: "GET", url: "/api/users/1/backups", params: { uid: "1" } }, res2);
    expect(adminService.listBackups).toHaveBeenCalledWith("1");

    const res3 = mockRes();
    await call(
      { method: "POST", url: "/api/users/1/restore", params: { uid: "1" }, body: { backup: "1-20250101000000.json" } },
      res3,
    );
    expect(adminService.restore).toHaveBeenCalledWith("1", "1-20250101000000.json");
  });

  it("GET /api/users/:uid/raw 应返回原始数据", async () => {
    const res = mockRes();
    await call({ method: "GET", url: "/api/users/1/raw", params: { uid: "1" } }, res);
    expect(adminService.getRawJson).toHaveBeenCalledWith("1");
    expect(res.json).toHaveBeenCalledWith({ status: { uid: "1" } });
  });

  it("GET /api/users/:uid/mails 与 DELETE mails/:mailId 应透传", async () => {
    const res1 = mockRes();
    await call({ method: "GET", url: "/api/users/1/mails", params: { uid: "1" } }, res1);
    expect(adminService.listMails).toHaveBeenCalledWith("1");

    const res2 = mockRes();
    await call({ method: "DELETE", url: "/api/users/1/mails/1000001", params: { uid: "1", mailId: "1000001" } }, res2);
    expect(adminService.deleteMail).toHaveBeenCalledWith("1", 1000001);
  });

  it("POST /api/mail 与 /api/mail/all 应区分单发/群发", async () => {
    const res1 = mockRes();
    await call(
      { method: "POST", url: "/api/mail", body: { uid: "1", subject: "hi", content: "", items: [] } },
      res1,
    );
    expect(adminService.sendMail).toHaveBeenCalled();

    const res2 = mockRes();
    await call(
      { method: "POST", url: "/api/mail/all", body: { subject: "公告", content: "", items: [] } },
      res2,
    );
    expect(adminService.sendMailAll).toHaveBeenCalledWith({
      subject: "公告",
      content: "",
      items: [],
    });
    expect(res2.status).toHaveBeenCalledWith(201);
  });

  it("POST /api/users/:uid/refresh 与 /save 应透传", async () => {
    const res1 = mockRes();
    await call({ method: "POST", url: "/api/users/1/refresh", params: { uid: "1" }, body: {} }, res1);
    expect(adminService.refreshUser).toHaveBeenCalledWith("1");

    const res2 = mockRes();
    await call({ method: "POST", url: "/api/users/1/save", params: { uid: "1" }, body: {} }, res2);
    expect(adminService.saveUser).toHaveBeenCalledWith("1");
  });

  it("GET /api/stats /api/logs /api/common-items 应返回数据", async () => {
    const res1 = mockRes();
    await call({ method: "GET", url: "/api/stats" }, res1);
    expect(adminService.stats).toHaveBeenCalled();

    const res2 = mockRes();
    await call({ method: "GET", url: "/api/logs", query: { limit: "10" } }, res2);
    expect(adminService.logs).toHaveBeenCalledWith(10);

    const res3 = mockRes();
    await call({ method: "GET", url: "/api/common-items" }, res3);
    expect(adminService.getCommonItems).toHaveBeenCalled();

    const res4 = mockRes();
    await call({ method: "GET", url: "/api/mail-templates" }, res4);
    expect(adminService.getMailTemplates).toHaveBeenCalled();
    expect(res4.json).toHaveBeenCalledWith([{ name: "补偿", subject: "补偿发放", items: 2 }]);
  });

  it("GET /api/mapviz-data 应返回主题 + gridzone 构造数据，缺失时 404", async () => {
    const res1 = mockRes();
    await call({ method: "GET", url: "/api/mapviz-data" }, res1);
    expect(adminService.getMapvizData).toHaveBeenCalled();
    expect(res1.json).toHaveBeenCalledWith(
      expect.objectContaining({
        themes: expect.objectContaining({ rogue_1: expect.any(Object) }),
        grid: expect.any(Object),
      }),
    );

    // 数据缺失 → 404
    vi.mocked(adminService.getMapvizData).mockResolvedValueOnce(null);
    const res2 = mockRes();
    await call({ method: "GET", url: "/api/mapviz-data" }, res2);
    expect(res2.status).toHaveBeenCalledWith(404);
  });

  it("POST /api/rogue/sim-auto 应透传 uid/theme 并返回步骤与最终快照", async () => {
    const res = mockRes();
    await call({ method: "POST", url: "/api/rogue/sim-auto", body: { uid: "1", theme: "rogue_1", maxZone: 3 } }, res);
    expect(adminService.rogueSimAuto).toHaveBeenCalledWith("1", "rogue_1", 3);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, steps: expect.any(Array) }),
    );

    // 模拟失败 → 400
    vi.mocked(adminService.rogueSimAuto).mockResolvedValueOnce(
      asModel<RogueSimAutoResult>({ ok: false, error: "rlv2 失败" }),
    );
    const res2 = mockRes();
    await call({ method: "POST", url: "/api/rogue/sim-auto", body: { uid: "1", theme: "rogue_1" } }, res2);
    expect(res2.status).toHaveBeenCalledWith(400);
  });

  it("POST /api/rogue/sim-step 应透传 action/body 并返回快照", async () => {
    const res = mockRes();
    await call({ method: "POST", url: "/api/rogue/sim-step", body: { uid: "1", action: "moveTo", body: { to: { x: 0, y: 0 } } } }, res);
    expect(adminService.rogueSimStep).toHaveBeenCalledWith("1", "moveTo", { to: { x: 0, y: 0 } });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, state: expect.any(Object) }));

    // 非法 action → 400
    vi.mocked(adminService.rogueSimStep).mockResolvedValueOnce(
      asModel<RogueSimStepResult>({ ok: false, error: "非法操作: hack" }),
    );
    const res2 = mockRes();
    await call({ method: "POST", url: "/api/rogue/sim-step", body: { uid: "1", action: "hack" } }, res2);
    expect(res2.status).toHaveBeenCalledWith(400);
  });

  it("GET /api/rogue/state 应返回当前 rlv2 快照", async () => {
    const res = mockRes();
    await call({ method: "GET", url: "/api/rogue/state?uid=1" }, res);
    expect(adminService.rogueSimState).toHaveBeenCalledWith("1");
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ current: expect.any(Object) }));
  });

  it("POST /api/pixel/upload-batch 应透传 pixelDataList 并返回逐张结果", async () => {
    const res = mockRes();
    await call({ method: "POST", url: "/api/pixel/upload-batch", body: { phone: "13800000000", pwd: "pwd", pixelDataList: [new Array(1728).fill(255)] } }, res);
    expect(adminService.uploadPixelArtBatch).toHaveBeenCalledWith("13800000000", "pwd", [expect.any(Array)]);
    expect(res.json).toHaveBeenCalledWith(expect.any(Array));
  });

  it("POST /api/pixel/upload-batch 非数组 pixelDataList 应传空数组", async () => {
    const res = mockRes();
    await call({ method: "POST", url: "/api/pixel/upload-batch", body: { phone: "1", pwd: "2", pixelDataList: null } }, res);
    expect(adminService.uploadPixelArtBatch).toHaveBeenCalledWith("1", "2", []);
  });

  it("POST /api/pixel/list-official 应透传并返回像素列表", async () => {
    const res = mockRes();
    await call({ method: "POST", url: "/api/pixel/list-official", body: { phone: "1", pwd: "2", pixelArtIds: [1001] } }, res);
    expect(adminService.getPixelArtList).toHaveBeenCalledWith("1", "2", [1001]);
    expect(res.json).toHaveBeenCalledWith(expect.any(Array));
  });

  it("POST /api/pixel/delete-official 应透传并返回逐张结果", async () => {
    const res = mockRes();
    await call({ method: "POST", url: "/api/pixel/delete-official", body: { phone: "1", pwd: "2", pixelArtIds: [1001] } }, res);
    expect(adminService.deletePixelArt).toHaveBeenCalledWith("1", "2", [1001]);
    expect(res.json).toHaveBeenCalledWith(expect.any(Array));
  });

  it("GET /api/spec 应返回端点规范清单", async () => {
    const res = mockRes();
    await call({ method: "GET", url: "/api/spec" }, res);
    expect(res.json).toHaveBeenCalledWith({
      endpoints: expect.any(Array),
    });
    const payload = vi.mocked(res.json).mock.calls[0][0] as SpecPayload;
    expect(payload.endpoints.length).toBeGreaterThan(10);
    // 规范里应含游戏代理端点（供控制台使用）
    expect(
      payload.endpoints.some((e) => e.path === "/api/game-proxy"),
    ).toBe(true);
  });

  it("POST /api/game-proxy 应透传 uid/path/method/body", async () => {
    const res = mockRes();
    await call(
      {
        method: "POST",
        url: "/api/game-proxy",
        body: { uid: "1", path: "/user/info", method: "get", body: { a: 1 } },
      },
      res,
    );
    expect(adminService.gameProxy).toHaveBeenCalledWith("1", "/user/info", "GET", { a: 1 });
    expect(res.json).toHaveBeenCalledWith({ status: 200, data: {}, uid: "1" });
  });

  it("POST /api/game-proxy 方法缺省为 GET", async () => {
    const res = mockRes();
    await call(
      { method: "POST", url: "/api/game-proxy", body: { uid: "1", path: "/user/info" } },
      res,
    );
    expect(adminService.gameProxy).toHaveBeenCalledWith("1", "/user/info", "GET", undefined);
  });

  it("卡池相关端点应透传（list/pool/玩家状态/UP/保底）", async () => {
    const res1 = mockRes();
    await call({ method: "GET", url: "/api/pools" }, res1);
    expect(adminService.listPools).toHaveBeenCalled();

    // 卡池详情：不存在应 404
    const res2 = mockRes();
    await call({ method: "GET", url: "/api/pools/NO_SUCH", params: { poolId: "NO_SUCH" } }, res2);
    expect(adminService.poolDetail).toHaveBeenCalledWith("NO_SUCH");
    expect(res2.status).toHaveBeenCalledWith(404);

    const res3 = mockRes();
    await call(
      { method: "GET", url: "/api/users/1/pools/NORMAL_0_1", params: { uid: "1", poolId: "NORMAL_0_1" } },
      res3,
    );
    expect(adminService.getPlayerPoolState).toHaveBeenCalledWith("1", "NORMAL_0_1");

    const res4 = mockRes();
    await call(
      {
        method: "POST",
        url: "/api/users/1/pools/NORMAL_0_1/up",
        params: { uid: "1", poolId: "NORMAL_0_1" },
        body: { charIds: ["char_002_amiya"] },
      },
      res4,
    );
    expect(adminService.setPlayerPoolUp).toHaveBeenCalledWith("1", "NORMAL_0_1", ["char_002_amiya"]);

    const res5 = mockRes();
    await call(
      { method: "POST", url: "/api/users/1/pity", params: { uid: "1" }, body: { ruleType: "NORMAL", count: 42 } },
      res5,
    );
    expect(adminService.setPlayerPity).toHaveBeenCalledWith("1", "NORMAL", 42);
    expect(res5.json).toHaveBeenCalledWith({ uid: "1", ruleType: "NORMAL", beforeNonHitCnt: 42 });
  });

  it("POST /api/official/migrate 应透传账号文本与模板 uid", async () => {
    const res = mockRes();
    await call(
      {
        method: "POST",
        url: "/api/official/migrate",
        body: { accounts: "13800000000 pwd", templateUid: "1" },
      },
      res,
    );
    expect(adminService.migrateOfficial).toHaveBeenCalledWith("13800000000 pwd", "1");
    expect(res.json).toHaveBeenCalledWith({
      results: [{ phone: "13800000000", uid: "2", nickName: "A" }],
    });
  });

  it("POST /api/official/action 应透传手机号/密码/操作", async () => {
    const res = mockRes();
    await call(
      {
        method: "POST",
        url: "/api/official/action",
        body: { phone: "13800000000", pwd: "pwd", action: "signin" },
      },
      res,
    );
    expect(adminService.officialAction).toHaveBeenCalledWith("13800000000", "pwd", "signin");
    expect(res.json).toHaveBeenCalledWith({ action: "signin", ok: true, data: "签到成功" });
  });

  it("POST /api/cli/exec 应执行 CLI 命令并返回输出", async () => {
    vi.mocked(cliExec).mockResolvedValue({ ok: true, output: "hello" });
    const res = mockRes();
    await call({ method: "POST", url: "/api/cli/exec", body: { command: "users list --json" } }, res);
    expect(cliExec).toHaveBeenCalledWith("users list --json");
    expect(res.json).toHaveBeenCalledWith({ ok: true, output: "hello" });
  });

  it("POST /api/cli/exec 命令失败应 400 并返回 error", async () => {
    vi.mocked(cliExec).mockResolvedValue({ ok: false, output: "x", error: "boom" });
    const res = mockRes();
    await call({ method: "POST", url: "/api/cli/exec", body: { command: "users bad" } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ ok: false, output: "x", error: "boom" });
  });

  it("POST /api/official/call 应透传手机号/密码/cgi/body", async () => {
    const res = mockRes();
    await call(
      {
        method: "POST",
        url: "/api/official/call",
        body: { phone: "13800000000", pwd: "pwd", cgi: "/mail/getMetaInfoList", body: { from: 0 } },
      },
      res,
    );
    expect(adminService.officialCall).toHaveBeenCalledWith("13800000000", "pwd", "/mail/getMetaInfoList", { from: 0 });
    expect(res.json).toHaveBeenCalledWith({ cgi: "/mail/getMetaInfoList", result: {} });
  });

  it("POST /api/official/sync-gacha 应透传（缺省池列表）", async () => {
    const res = mockRes();
    await call(
      { method: "POST", url: "/api/official/sync-gacha", body: { phone: "13800000000", pwd: "pwd" } },
      res,
    );
    expect(adminService.syncGachaPools).toHaveBeenCalledWith("13800000000", "pwd", undefined, { refresh: false });
    expect(res.json).toHaveBeenCalledWith({ total: 2, ok: 1, failed: [], updated: 1 });
  });

  it("批量工具端点应透传（grant-all/maxchars/stages）", async () => {
    const res1 = mockRes();
    await call(
      { method: "POST", url: "/api/users/1/grant-all", params: { uid: "1" }, body: { count: 5 } },
      res1,
    );
    expect(adminService.grantAllItems).toHaveBeenCalledWith("1", 5);

    const res2 = mockRes();
    await call({ method: "POST", url: "/api/users/1/maxchars", params: { uid: "1" }, body: {} }, res2);
    expect(adminService.maxAllChars).toHaveBeenCalledWith("1");

    const res2b = mockRes();
    await call({ method: "POST", url: "/api/users/1/repair-chars", params: { uid: "1" }, body: {} }, res2b);
    expect(adminService.repairChars).toHaveBeenCalledWith("1");
    expect(res2b.json).toHaveBeenCalledWith({ chars: 3, fields: 8 });

    const res3 = mockRes();
    await call({ method: "GET", url: "/api/users/1/stages", params: { uid: "1" } }, res3);
    expect(adminService.listStages).toHaveBeenCalledWith("1");
    expect(res3.json).toHaveBeenCalledWith({ total: 2, done: 1, stages: [] });
  });

  it("GET /api/openapi.json 应返回 OpenAPI 文档", async () => {
    const res = mockRes();
    await call({ method: "GET", url: "/api/openapi.json" }, res);
    const payload = vi.mocked(res.json).mock.calls[0][0];
    expect(payload.openapi).toBe("3.0.3");
    expect(payload.paths["/api/users/{uid}"]).toBeDefined();
  });

  it("关卡解锁/物品搜索/任务统计端点应透传", async () => {
    const res1 = mockRes();
    await call(
      { method: "POST", url: "/api/users/1/stages/unlock", params: { uid: "1" }, body: { stageId: "main_01-01" } },
      res1,
    );
    expect(adminService.unlockStage).toHaveBeenCalledWith("1", "main_01-01");

    const res2 = mockRes();
    await call(
      { method: "POST", url: "/api/users/1/stages/unlock-all", params: { uid: "1" }, body: {} },
      res2,
    );
    expect(adminService.unlockAllStages).toHaveBeenCalledWith("1");

    const res3 = mockRes();
    await call({ method: "GET", url: "/api/items", query: { q: "龙门币" } }, res3);
    expect(adminService.searchItems).toHaveBeenCalledWith("龙门币", 50);
    expect(res3.json).toHaveBeenCalledWith([{ id: "4001", name: "龙门币", classifyType: "NORMAL" }]);

    const res4 = mockRes();
    await call({ method: "GET", url: "/api/users/1/missions", params: { uid: "1" } }, res4);
    expect(adminService.listMissionStats).toHaveBeenCalledWith("1");

    const res5 = mockRes();
    await call({ method: "GET", url: "/api/users/1/medals", params: { uid: "1" } }, res5);
    expect(adminService.listMedals).toHaveBeenCalledWith("1");
    expect(res5.json).toHaveBeenCalledWith({ total: 5, unlocked: 2, medals: [] });
  });

  it("导出/导入/校验端点应透传", async () => {
    const res1 = mockRes();
    await call(
      { method: "POST", url: "/api/users/1/export", params: { uid: "1" }, body: { path: "./tmp/out.json" } },
      res1,
    );
    expect(adminService.exportUser).toHaveBeenCalledWith("1", "./tmp/out.json");

    const res2 = mockRes();
    await call(
      { method: "POST", url: "/api/import", body: { filePath: "./tmp/in.json", uid: "1" } },
      res2,
    );
    expect(adminService.importUser).toHaveBeenCalledWith("./tmp/in.json", "1");

    const res3 = mockRes();
    await call({ method: "GET", url: "/api/check" }, res3);
    expect(adminService.checkData).toHaveBeenCalled();
    expect(res3.json).toHaveBeenCalledWith({ ok: true, users: [{ uid: "1", ok: true }] });
  });

  it("check-files / activity 端点应透传", async () => {
    const res1 = mockRes();
    await call({ method: "GET", url: "/api/check-files" }, res1);
    expect(adminService.checkDataFiles).toHaveBeenCalled();

    const res2 = mockRes();
    await call({ method: "GET", url: "/api/users/1/activity", params: { uid: "1" } }, res2);
    expect(adminService.getActivitySummary).toHaveBeenCalledWith("1");
    expect(res2.json).toHaveBeenCalledWith({ total: 3, types: [{ type: "LOGIN_ONLY", activities: 2 }] });
  });
});

describe("admin 路由（统一抓包管理）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /api/capture/sessions 应返回会话列表", async () => {
    const res = mockRes();
    await call({ method: "GET", url: "/api/capture/sessions" }, res);
    expect(captureManager.listSessions).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith([{ id: "s-1", name: "登录链路", source: "official", recordCount: 3 }]);
  });

  it("POST /api/capture/sessions 应新建会话（201）", async () => {
    const res = mockRes();
    await call(
      { method: "POST", url: "/api/capture/sessions", body: { name: "商店对比", source: "official" } },
      res,
    );
    expect(captureManager.startSession).toHaveBeenCalledWith("商店对比", "official", "");
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("POST /api/capture/sessions/:id/stop 与 DELETE 应透传", async () => {
    const res1 = mockRes();
    await call({ method: "POST", url: "/api/capture/sessions/s-1/stop", params: { id: "s-1" } }, res1);
    expect(captureManager.stopSession).toHaveBeenCalledWith("s-1");

    const res2 = mockRes();
    await call({ method: "DELETE", url: "/api/capture/sessions/s-1", params: { id: "s-1" } }, res2);
    expect(captureManager.deleteSession).toHaveBeenCalledWith("s-1");
    expect(res2.json).toHaveBeenCalledWith({ deleted: 2 });
  });

  it("GET /api/capture/records 应透传过滤条件", async () => {
    const res = mockRes();
    await call(
      {
        method: "GET",
        url: "/api/capture/records",
        query: { source: "official", status: "200", path: "/account/", limit: "20", offset: "0" },
      },
      res,
    );
    expect(captureManager.query).toHaveBeenCalledWith(
      expect.objectContaining({ source: "official", status: 200, path: "/account/", limit: 20, offset: 0 }),
    );
  });

  it("GET /api/capture/records/:id 详情与 DELETE 应透传", async () => {
    const res1 = mockRes();
    await call({ method: "GET", url: "/api/capture/records/R-1", params: { id: "R-1" } }, res1);
    expect(captureManager.getRecordDetail).toHaveBeenCalledWith("R-1");
    expect(res1.json).toHaveBeenCalledWith(expect.objectContaining({ rid: "R-1" }));

    const res2 = mockRes();
    await call({ method: "DELETE", url: "/api/capture/records/R-1", params: { id: "R-1" } }, res2);
    expect(captureManager.deleteRecord).toHaveBeenCalledWith("R-1");
    expect(res2.json).toHaveBeenCalledWith({ ok: true });
  });

  it("POST /api/capture/clear 与 GET /api/capture/stats 应透传", async () => {
    const res1 = mockRes();
    await call({ method: "POST", url: "/api/capture/clear", body: { confirmWord: "CLEAR" } }, res1);
    expect(captureManager.clearAll).toHaveBeenCalledWith("CLEAR");
    expect(res1.json).toHaveBeenCalledWith({ cleared: 5 });

    const res2 = mockRes();
    await call({ method: "GET", url: "/api/capture/stats" }, res2);
    expect(captureManager.stats).toHaveBeenCalled();
  });

  it("GET /api/capture/sessions/:id/export 应触发 zip 下载", async () => {
    const res = mockRes();
    await call({ method: "GET", url: "/api/capture/sessions/s-1/export", params: { id: "s-1" } }, res);
    expect(captureManager.exportSession).toHaveBeenCalledWith("s-1");
    expect(res.sendFile).toHaveBeenCalled();
  });

  it("GET /api/capture/stream 应建立 SSE 并订阅", async () => {
    const res = mockRes();
    res.write = vi.fn();
    res.flushHeaders = vi.fn();
    await call({ method: "GET", url: "/api/capture/stream", on: vi.fn() }, res);
    expect(createSse).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 20));
    expect(sseSend).toHaveBeenCalledWith(res, "record", expect.objectContaining({ type: "backfill" }));
  });
});

describe("admin 路由（统一日志管理）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /api/logs/server 应透传过滤条件", async () => {
    const res = mockRes();
    await call(
      { method: "GET", url: "/api/logs/server", query: { date: "20260101", level: "ERROR", q: "boom", limit: "50" } },
      res,
    );
    expect(logService.readServerLog).toHaveBeenCalledWith(
      expect.objectContaining({ date: "20260101", level: "ERROR", q: "boom", limit: 50 }),
    );
  });

  it("GET /api/logs/server/dates 与 /api/logs/watchdog 应透传", async () => {
    const res1 = mockRes();
    await call({ method: "GET", url: "/api/logs/server/dates" }, res1);
    expect(logService.listServerLogDates).toHaveBeenCalled();
    expect(res1.json).toHaveBeenCalledWith(["20260814"]);

    const res2 = mockRes();
    await call({ method: "GET", url: "/api/logs/watchdog" }, res2);
    expect(logService.readWatchdogLog).toHaveBeenCalled();
  });

  it("GET /api/logs/audit 应透传 action/uid 过滤", async () => {
    const res = mockRes();
    await call({ method: "GET", url: "/api/logs/audit", query: { action: "grantItem", uid: "1" } }, res);
    expect(logService.readAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "grantItem", uid: "1" }));
  });

  it("POST /api/logs/server/clear 应透传确认词", async () => {
    const res = mockRes();
    await call({ method: "POST", url: "/api/logs/server/clear", body: { confirmWord: "CLEAR" } }, res);
    expect(logService.clearServerLogs).toHaveBeenCalledWith("CLEAR");
    expect(res.json).toHaveBeenCalledWith({ cleared: 2 });
  });

  it("GET /api/logs/stream?kind=server 应建立 SSE 并回填", async () => {
    const res = mockRes();
    res.write = vi.fn();
    res.flushHeaders = vi.fn();
    await call({ method: "GET", url: "/api/logs/stream", query: { kind: "server" }, on: vi.fn() }, res);
    expect(createSse).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 20));
    expect(sseSend).toHaveBeenCalledWith(res, "log", expect.objectContaining({ kind: "server", type: "backfill" }));
  });
});
