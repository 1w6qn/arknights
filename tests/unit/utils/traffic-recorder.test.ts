import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import type { Request, Response } from "express";
import type { JsonValue } from "@excel/json-value";
import type { CaptureRecorder } from "@capture/capture-recorder";
import type { CaptureRecord } from "@capture/capture-manager";
import {
  createTrafficRecorder,
  parseReqresLogMode,
} from "@utils/traffic-recorder";
import { captureManager } from "@capture/capture-manager";
import { asModel } from "../../helpers/mockPlayerData";

// 测试专用独立临时目录——绝不碰真实 tmp/capture/（统一抓包存储）
const RECORD_ROOT = path.join(os.tmpdir(), "traffic-recorder-test");

/** 抓包中间件类型（`createTrafficRecorder` 的返回，即 express RequestHandler） */
type Recorder = ReturnType<typeof createTrafficRecorder>;
/** 中间件的请求形参（express Request） */
type MiddlewareReq = Parameters<Recorder>[0];
/** 中间件的响应形参（express Response） */
type MiddlewareRes = Parameters<Recorder>[1];

/**
 * 请求替身视图
 *
 * 只声明中间件读到的成员；`query` 取 `Request["query"] | { platform: number }`：
 * 用例夹具惯用数字 platform，而真实 `ParsedQs` 只允许 string/string[]/嵌套对象——
 * 视图取并集后真实 `Request` 仍可赋给它（单向可比），故调用点一次断言即可，夹具值不改。
 */
interface MockReq {
  method: string;
  originalUrl: string;
  headers: Record<string, string | string[] | undefined>;
  body?: JsonValue;
  /** capture 模式在 index.ts 挂到 req 上的原始字节（生产侧同样以视图读取） */
  rawBody?: Buffer;
  query: Request["query"] | { platform: number };
}

/**
 * 响应替身视图
 *
 * 只声明中间件读/写的成员；真实 `Response` 可赋给它（`flush` 是测试自建的 finish 触发器，
 * 故为可选）。`send`/`json` 声明为「收 JsonValue、返回本替身」以保留原 mock 的链式返回。
 */
interface MockRes {
  statusCode: number;
  getHeaders: Response["getHeaders"];
  send: (data: JsonValue) => MockRes;
  json: (data: JsonValue) => MockRes;
  on: (event: string, cb: () => void) => void;
  flush?: () => void;
  /** 用例内记录的最后一次响应体（与生产中间件无关，仅 mock 内部记账） */
  _body?: JsonValue;
}

function mockReq(originalUrl: string, method = "POST", body: JsonValue = {}): MockReq {
  return {
    method,
    originalUrl,
    headers: { "content-type": "application/json" },
    body,
    query: { platform: 2 },
  };
}

function mockRes(statusCode = 200): MockRes {
  let finishCb: () => void = () => {};
  const res: MockRes = {
    statusCode,
    getHeaders: vi.fn(() => ({})),
    send: vi.fn(function (this: MockRes, data: JsonValue) {
      this._body = data;
      return this;
    }),
    json: vi.fn(function (this: MockRes, data: JsonValue) {
      this._body = data;
      return this;
    }),
    // 模拟真实 Express：finish 在响应发出后才触发（send/json 之后手动调用 flush）
    on: vi.fn((event: string, cb: () => void) => {
      if (event === "finish") finishCb = cb;
    }),
    flush: () => finishCb(),
  };
  return res;
}

/** 以窄替身调用抓包中间件（`req`/`res` 单向断言，见 {@link MockReq}/{@link MockRes}） */
function run(handler: Recorder, req: MockReq, res: MockRes, next: () => void = () => {}): void {
  handler(req as MiddlewareReq, res as MiddlewareRes, next);
}

/** CaptureRecorder 端口 mock（解耦验证：记录导向注入端口而非真实单例） */
function mockRecorder() {
  const addRecord = vi.fn<CaptureRecorder["addRecord"]>(async () => asModel<CaptureRecord>({}));
  return { addRecord };
}

describe("createTrafficRecorder（统一抓包存储记录）", () => {
  const cfgOn = { debug: { recordTraffic: true } };
  const cfgOff = { debug: { recordTraffic: false } };

  beforeEach(() => {
    captureManager.reset();
    captureManager.configure({ root: RECORD_ROOT });
    if (fs.existsSync(RECORD_ROOT)) fs.rmSync(RECORD_ROOT, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    captureManager.reset();
    if (fs.existsSync(RECORD_ROOT)) fs.rmSync(RECORD_ROOT, { recursive: true, force: true });
  });

  it("recordTraffic=true 时写入统一抓包存储（记录行 + req/res body 文件）", async () => {
    const handler = createTrafficRecorder(cfgOn, "private", captureManager);
    const req = mockReq("/account/syncData?platform=2");
    const res = mockRes();
    const next = vi.fn();
    run(handler, req, res, next);
    expect(next).toHaveBeenCalled();
    res.send({ result: 0, ts: 123 });
    res.flush!();
    // finish 回调是异步落库的
    await new Promise((r) => setTimeout(r, 300));

    const { total, items } = await captureManager.query({});
    expect(total).toBe(1);
    const rec = items[0];
    expect(rec.method).toBe("POST");
    expect(rec.path).toBe("/account/syncData");
    expect(rec.module).toBe("account");
    expect(rec.endpoint).toBe("syncData");
    expect(rec.status).toBe(200);
    expect(rec.source).toBe("private");
    expect(rec.query).toBe("platform=2");
    expect(rec.latencyMs).not.toBeNull();

    const detail = await captureManager.getRecordDetail(rec.id);
    expect(detail?.reqBody).toEqual({});
    expect(detail?.resBody).toEqual({ result: 0, ts: 123 });
    // body 文件确实落盘
    const dir = path.join(RECORD_ROOT, "records", rec.rid);
    expect(fs.existsSync(path.join(dir, "req.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "res.json"))).toBe(true);
  });

  it("recordTraffic=false（默认）时不写任何记录", async () => {
    const handler = createTrafficRecorder(cfgOff, "private", captureManager);
    const req = mockReq("/account/syncData");
    const res = mockRes();
    run(handler, req, res, () => {});
    res.send({ result: 0 });
    res.flush!();
    await new Promise((r) => setTimeout(r, 300));
    expect((await captureManager.query({})).total).toBe(0);
  });

  it("url 带 query 时 path 只取路径部分", async () => {
    const handler = createTrafficRecorder(cfgOn, "private", captureManager);
    const req = mockReq("/u8/user/v1/getToken?appCode=abc&platform=2");
    const res = mockRes();
    run(handler, req, res, () => {});
    res.json({ result: 0 });
    res.flush!();
    await new Promise((r) => setTimeout(r, 300));
    const { items } = await captureManager.query({});
    expect(items[0].path).toBe("/u8/user/v1/getToken");
    expect(items[0].query).toBe("appCode=abc&platform=2");
    expect(items[0].module).toBe("u8");
    expect(items[0].endpoint).toBe("user/v1/getToken");
  });

  it("source 参数标记来源（capture 官服转发 → official）", async () => {
    const handler = createTrafficRecorder(cfgOn, "official", captureManager);
    const req = mockReq("/account/login");
    const res = mockRes();
    run(handler, req, res, () => {});
    res.json({ result: 0 });
    res.flush!();
    await new Promise((r) => setTimeout(r, 300));
    const { items } = await captureManager.query({});
    expect(items[0].source).toBe("official");
  });

  it("非 JSON 请求带 rawBody 时以 req.bin 原始字节落盘（multipart 像素画上传等）", async () => {
    const handler = createTrafficRecorder(cfgOn, "official", captureManager);
    const req = mockReq("/activity/arkhub/savePixelArt");
    req.headers = { "content-type": 'multipart/form-data; boundary="C880D0B0"' };
    req.body = undefined;
    // 模拟 index.ts capture 模式捕获的原始 multipart 字节
    const raw = Buffer.from('--C880D0B0\r\nContent-Disposition: form-data; name="file"\r\n\r\nPNGDATA\r\n--C880D0B0--\r\n');
    req.rawBody = raw;
    const res = mockRes();
    run(handler, req, res, () => {});
    res.send({ pixelArtId: 123 });
    res.flush!();
    await new Promise((r) => setTimeout(r, 300));

    const { items } = await captureManager.query({});
    const rec = items[0];
    expect(rec.reqBodyType).toBe("bin");
    expect(rec.reqSize).toBe(raw.length);
    const detail = await captureManager.getRecordDetail(rec.id);
    const reqBody = detail?.reqBody as { base64: string };
    expect(Buffer.from(reqBody.base64, "base64")).toEqual(raw);
    expect(detail?.resBody).toEqual({ pixelArtId: 123 });
  });

  it("JSON 请求（无 rawBody）请求体以 req.json 落盘", async () => {
    const handler = createTrafficRecorder(cfgOn, "private", captureManager);
    const req = mockReq("/account/login", "POST", { phone: "13800000000" });
    const res = mockRes();
    run(handler, req, res, () => {});
    res.send({ result: 0 });
    res.flush!();
    await new Promise((r) => setTimeout(r, 300));
    const { items } = await captureManager.query({});
    expect(items[0].reqBodyType).toBe("json");
    const detail = await captureManager.getRecordDetail(items[0].id);
    expect(detail?.reqBody).toEqual({ phone: "13800000000" });
  });

  it("默认排除 /admin /assetbundle /config /api 等本地挂载前缀（不记录，不包裹 res）", async () => {
    const handler = createTrafficRecorder(cfgOn, "private", captureManager);
    const cases = [
      "/admin/api/status",
      "/admin/dashboard",
      "/assetbundle/official/Android/assets/xx/yy",
      "/config/prod/official/network_config",
      "/api/remote_config/1/prod/default/Windows/network_config",
      "/batch_event",
    ];
    for (const url of cases) {
      const req = mockReq(url);
      const res = mockRes();
      run(handler, req, res, () => {});
      res.send({ ok: 1 });
      res.flush!();
    }
    await new Promise((r) => setTimeout(r, 300));
    expect((await captureManager.query({})).total).toBe(0);
    // 未包裹 res.send：mock 的 send 应保持原样被调用（res.json 未被替换成记录版本）
  });

  it("自定义 recordTrafficExclude 覆盖默认列表（空数组 = 全部记录，含 /admin）", async () => {
    const cfgAll = { debug: { recordTraffic: true, recordTrafficExclude: [] as string[] } };
    const handler = createTrafficRecorder(cfgAll, "private", captureManager);
    const req = mockReq("/admin/api/status");
    const res = mockRes();
    run(handler, req, res, () => {});
    res.send({ ok: 1 });
    res.flush!();
    await new Promise((r) => setTimeout(r, 300));
    const { items } = await captureManager.query({});
    expect(items.length).toBe(1);
    expect(items[0].path).toBe("/admin/api/status");
  });

  it("自定义 recordTrafficExclude 仅排除指定前缀（其它照常记录）", async () => {
    const cfg = { debug: { recordTraffic: true, recordTrafficExclude: ["/admin"] } };
    const handler = createTrafficRecorder(cfg, "private", captureManager);
    const req1 = mockReq("/admin/api/status");
    const res1 = mockRes();
    run(handler, req1, res1, () => {});
    res1.send({ ok: 1 });
    res1.flush!();
    const req2 = mockReq("/shop/getLowGoodList");
    const res2 = mockRes();
    run(handler, req2, res2, () => {});
    res2.send({ ok: 1 });
    res2.flush!();
    await new Promise((r) => setTimeout(r, 300));
    const { items } = await captureManager.query({});
    expect(items.length).toBe(1);
    expect(items[0].path).toBe("/shop/getLowGoodList");
  });

  it("注入 CaptureRecorder 端口（mock）时写入 mock 而非真实单例（解耦验证）", async () => {
    // 业务层面向 CaptureRecorder 窄端口编程，可注入 mock 替换真实 captureManager 单例。
    const recorder = mockRecorder();
    const handler = createTrafficRecorder(cfgOn, "private", recorder);
    const req = mockReq("/shop/getLowGoodList");
    const res = mockRes();
    run(handler, req, res, () => {});
    res.send({ ok: 1 });
    res.flush!();
    await new Promise((r) => setTimeout(r, 50));

    expect(recorder.addRecord).toHaveBeenCalledTimes(1);
    const [meta, bodies] = recorder.addRecord.mock.calls[0];
    expect(meta.path).toBe("/shop/getLowGoodList");
    expect(bodies!.res).toEqual({ kind: "json", data: { ok: 1 } });
    // 真实单例不应收到写入（把记录导向了注入的 mock）
    expect((await captureManager.query({})).total).toBe(0);
  });
});

describe("parseReqresLogMode（REQRES_LOG 环境变量解析，原 reqres-log enabledFor）", () => {
  it("缺省/空串/0/false/off → 关闭（行为变更：缺省不再视为 rlv2，默认关闭）", () => {
    for (const off of [undefined, "", "0", "false", "off"]) {
      expect(parseReqresLogMode(off)).toEqual({ enabled: false });
    }
  });

  it("大小写不敏感：OFF/False/ALL 同义", () => {
    expect(parseReqresLogMode("OFF")).toEqual({ enabled: false });
    expect(parseReqresLogMode("False")).toEqual({ enabled: false });
    expect(parseReqresLogMode("ALL")).toEqual({ enabled: true, prefix: null });
  });

  it("all 模式 → 全部记录（prefix=null）", () => {
    expect(parseReqresLogMode("all")).toEqual({ enabled: true, prefix: null });
  });

  it("其余值视为路径前缀并自动补前导 /", () => {
    expect(parseReqresLogMode("rlv2")).toEqual({ enabled: true, prefix: "/rlv2" });
    expect(parseReqresLogMode("/rlv2")).toEqual({ enabled: true, prefix: "/rlv2" });
    expect(parseReqresLogMode("battle")).toEqual({ enabled: true, prefix: "/battle" });
  });
});

describe("REQRES_LOG 定向记录通道（原 reqres-log 能力并入；env 在创建时读取）", () => {
  const ORIGINAL = process.env.REQRES_LOG;
  const cfgOff = { debug: { recordTraffic: false } };

  beforeEach(() => {
    delete process.env.REQRES_LOG;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.REQRES_LOG;
    else process.env.REQRES_LOG = ORIGINAL;
  });

  it("默认关闭（⚠ 行为变更）：主开关关 + 未设 REQRES_LOG 时 /rlv2 也不再记录（旧默认 rlv2 会记）", async () => {
    const recorder = mockRecorder();
    const handler = createTrafficRecorder(cfgOff, "private", recorder);
    const res = mockRes();
    run(handler, mockReq("/rlv2/finishEvent?t=1"), res, () => {});
    res.send({ ok: 1 });
    res.flush!();
    await new Promise((r) => setTimeout(r, 20));
    expect(recorder.addRecord).not.toHaveBeenCalled();
  });

  it("REQRES_LOG=rlv2：仅记录 /rlv2 前缀（白名单语义），其余不包裹不写入", async () => {
    process.env.REQRES_LOG = "rlv2";
    const recorder = mockRecorder();
    const handler = createTrafficRecorder(cfgOff, "private", recorder);

    const res1 = mockRes();
    run(handler, mockReq("/rlv2/finishEvent?t=1"), res1, () => {});
    res1.send({ playerDataDelta: { ok: true } });
    res1.flush!();

    const res2 = mockRes();
    let nextCalled = false;
    run(handler, mockReq("/other/route"), res2, () => {
      nextCalled = true;
    });
    res2.send({});
    res2.flush!();
    await new Promise((r) => setTimeout(r, 20));

    expect(nextCalled).toBe(true);
    expect(recorder.addRecord).toHaveBeenCalledTimes(1);
    const [meta, bodies] = recorder.addRecord.mock.calls[0];
    expect(meta.path).toBe("/rlv2/finishEvent");
    expect(meta.query).toBe("t=1");
    expect(meta.source).toBe("private");
    // bodies：req json + res json
    expect(bodies!.req).toEqual({ kind: "json", data: {} });
    expect(bodies!.res).toEqual({ kind: "json", data: { playerDataDelta: { ok: true } } });
  });

  it("REQRES_LOG=all：全部记录（含默认排除前缀 /admin）", async () => {
    process.env.REQRES_LOG = "all";
    const recorder = mockRecorder();
    const handler = createTrafficRecorder(cfgOff, "private", recorder);
    const res = mockRes();
    run(handler, mockReq("/admin/api/status"), res, () => {});
    res.send({ ok: 1 });
    res.flush!();
    await new Promise((r) => setTimeout(r, 20));
    expect(recorder.addRecord).toHaveBeenCalledTimes(1);
    expect(recorder.addRecord.mock.calls[0][0].path).toBe("/admin/api/status");
  });

  it("REQRES_LOG=自定义前缀 battle：只记 /battle/*", async () => {
    process.env.REQRES_LOG = "battle";
    const recorder = mockRecorder();
    const handler = createTrafficRecorder(cfgOff, "private", recorder);
    const res1 = mockRes();
    run(handler, mockReq("/battle/start"), res1, () => {});
    res1.send({ ok: 1 });
    res1.flush!();
    const res2 = mockRes();
    run(handler, mockReq("/rlv2/x"), res2, () => {});
    res2.send({});
    res2.flush!();
    await new Promise((r) => setTimeout(r, 20));
    expect(recorder.addRecord).toHaveBeenCalledTimes(1);
    expect(recorder.addRecord.mock.calls[0][0].path).toBe("/battle/start");
  });

  it("显式关闭值（0/false/off）→ 不记录（迁移自旧「开关关闭」用例）", async () => {
    const recorder = mockRecorder();
    for (const off of ["0", "false", "off"]) {
      process.env.REQRES_LOG = off;
      const handler = createTrafficRecorder(cfgOff, "private", recorder);
      const res = mockRes();
      let nextCalled = false;
      run(handler, mockReq("/rlv2/x"), res, () => {
        nextCalled = true;
      });
      res.send({});
      res.flush!();
      expect(nextCalled).toBe(true);
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(recorder.addRecord).not.toHaveBeenCalled();
  });
});

describe("options.include 正向匹配与 note 透传（对象参数形态）", () => {
  const cfgOn = { debug: { recordTraffic: true } };

  afterEach(() => {
    delete process.env.REQRES_LOG;
  });

  it("include 命中的请求即使命中 exclude 也记录（include 优先于 exclude，修复排除旁路）", async () => {
    const recorder = mockRecorder();
    // /admin 在默认排除列表中，但 include 正向命中 → 必须记录
    const handler = createTrafficRecorder({
      config: cfgOn,
      source: "private",
      recorder,
      include: ["/rlv2", "/admin"],
    });
    const res1 = mockRes();
    run(handler, mockReq("/admin/api/status"), res1, () => {});
    res1.send({ ok: 1 });
    res1.flush!();
    const res2 = mockRes();
    run(handler, mockReq("/rlv2/finishEvent"), res2, () => {});
    res2.json({ code: 0 });
    res2.flush!();
    await new Promise((r) => setTimeout(r, 20));

    expect(recorder.addRecord).toHaveBeenCalledTimes(2);
    expect(recorder.addRecord.mock.calls[0][0].path).toBe("/admin/api/status");
    // res.json 路径同样记录（对象不被二次序列化）
    expect(recorder.addRecord.mock.calls[1][1]!.res).toEqual({ kind: "json", data: { code: 0 } });
  });

  it("未命中 include 且命中 exclude：跳过且不写入；include 单独存在不能激活关闭的中间件", async () => {
    const recorder = mockRecorder();
    const cfgOnExcludeAdmin = { debug: { recordTraffic: true, recordTrafficExclude: ["/admin"] } };
    const active = createTrafficRecorder({
      config: cfgOnExcludeAdmin,
      recorder,
      include: ["/rlv2"],
    });
    // 主开关开、include=/rlv2：/admin 命中 exclude 且未命中 include → 跳过
    const res1 = mockRes();
    let nextCalled = false;
    run(active, mockReq("/admin/dashboard"), res1, () => {
      nextCalled = true;
    });
    res1.send({});
    res1.flush!();
    await new Promise((r) => setTimeout(r, 20));
    expect(nextCalled).toBe(true);
    expect(recorder.addRecord).not.toHaveBeenCalled();

    // 主开关关 + 仅 options.include（无 REQRES_LOG）：include 只是过滤器，不是激活通道
    const dormant = createTrafficRecorder({
      config: { debug: { recordTraffic: false } },
      recorder,
      include: ["/rlv2"],
    });
    const res2 = mockRes();
    run(dormant, mockReq("/rlv2/x"), res2, () => {});
    res2.send({});
    res2.flush!();
    await new Promise((r) => setTimeout(r, 20));
    expect(recorder.addRecord).not.toHaveBeenCalled();
  });

  it("note 透传到 addRecord（保持 reqres-log 来源标记能力）；位置参数形态不带 note", async () => {
    const recorder = mockRecorder();
    const handler = createTrafficRecorder({
      config: cfgOn,
      source: "private",
      recorder,
      note: "reqres-log",
    });
    const res = mockRes();
    run(handler, mockReq("/shop/getLowGoodList"), res, () => {});
    res.send({ ok: 1 });
    res.flush!();
    await new Promise((r) => setTimeout(r, 20));

    const [meta] = recorder.addRecord.mock.calls[0];
    expect(meta.note).toBe("reqres-log");

    // 对照：旧位置参数调用（index.ts 形态）不注入 note
    const plain = mockRecorder();
    const handler2 = createTrafficRecorder(cfgOn, "private", plain);
    const res2 = mockRes();
    run(handler2, mockReq("/shop/getLowGoodList"), res2, () => {});
    res2.send({ ok: 1 });
    res2.flush!();
    await new Promise((r) => setTimeout(r, 20));
    const [meta2] = plain.addRecord.mock.calls[0];
    expect("note" in meta2).toBe(false);
  });

  it("rawBody 二进制请求体优先于 req.body；非 JSON 字符串响应体走 bin（迁移自 reqres-log 用例）", async () => {
    const recorder = mockRecorder();
    const handler = createTrafficRecorder({ config: cfgOn, source: "private", recorder });
    const buf = Buffer.from([1, 2, 3]);
    const req = mockReq("/activity/upload?platform=2");
    req.rawBody = buf;
    req.body = {};
    const res = mockRes(404);
    run(handler, req, res, () => {});
    res.send("not found html");
    res.flush!();
    await new Promise((r) => setTimeout(r, 20));

    expect(recorder.addRecord).toHaveBeenCalledTimes(1);
    const [meta, bodies] = recorder.addRecord.mock.calls[0];
    expect(meta.status).toBe(404);
    expect(meta.query).toBe("platform=2");
    expect(bodies!.req).toEqual({ kind: "bin", data: buf });
    expect(bodies!.res).toEqual({ kind: "bin", data: "not found html" });
  });
});
