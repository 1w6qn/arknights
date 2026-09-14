import { describe, it, expect, vi } from "vitest";
import { mockGainItem } from "../../helpers";

vi.mock("express-http-context2", () => ({
  default: { get: vi.fn(), set: vi.fn() },
}));
vi.mock("@game/modules/mail/mail-manager", () => ({
  MailManager: vi.fn(),
  mailManager: {
    listMailbox: vi.fn().mockResolvedValue([{ mailId: 1 }]),
    receiveMail: vi.fn().mockResolvedValue([{ id: "30012", type: "MATERIAL", count: 1 }]),
    getMetaInfoList: vi.fn().mockResolvedValue([{ mailId: 1 }]),
    receiveAllMail: vi.fn().mockResolvedValue([{ id: "4001", type: "GOLD", count: 100 }]),
    removeAllReceivedMail: vi.fn().mockResolvedValue(undefined),
  },
}));

import mailRouter from "@game/modules/mail/routes";
import httpContext from "express-http-context2";
import { mailManager } from "@game/modules/mail/mail-manager";

import type { Response } from "express";
/** 路由测试请求体视图（本文件各端点字段合集） */
interface MailBody {
  mailIdList?: number[];
  mailId?: number;
  type?: number;
  from?: number;
}

/** 路由测试请求视图（只声明被测分支读到的三个成员） */
interface MockReq {
  method: string;
  url: string;
  body: MailBody;
}

/** 路由测试响应视图（只声明被测分支读到的四个方法） */
interface MockRes {
  send: Response["send"];
  status: Response["status"];
  sendStatus: Response["sendStatus"];
  json: Response["json"];
}

type RouterReq = Parameters<typeof mailRouter>[0];

function mockRes(): MockRes {
  return {
    send: vi.fn<Response["send"]>(),
    status: vi.fn<Response["status"]>().mockReturnThis(),
    sendStatus: vi.fn<Response["sendStatus"]>(),
    json: vi.fn<Response["json"]>(),
  };
}

async function call(req: MockReq, res: MockRes): Promise<MockRes> {
  // mock 请求/响应只覆盖被测分支用到的成员，故按窄视图断言为 express Request/Response
  mailRouter(req as RouterReq, res as Response, () => {});
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

describe("mail 路由", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(httpContext.get).mockReturnValue({
      uid: "10000",
      status: { uid: "10000" },
      // receiveMail/receiveAllMail 领奖后经 player.gainItem 管道入账
      gainItem: mockGainItem(),
      _trigger: { emit: vi.fn().mockResolvedValue(undefined) },
      delta: { modified: {} },
    });
  });

  it("listMailBox 应返回邮件列表（大小写对齐 api.md）", async () => {
    const res = mockRes();
    await call({ method: "POST", url: "/listMailBox", body: { mailIdList: [1] } }, res);
    expect(mailManager.listMailbox).toHaveBeenCalledWith("10000", { mailIdList: [1] });
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ mailList: [{ mailId: 1 }] }));
  });

  it("receiveMail 应返回领取附件", async () => {
    const res = mockRes();
    await call({ method: "POST", url: "/receiveMail", body: { mailId: 1, type: 0 } }, res);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ items: [{ id: "30012", type: "MATERIAL", count: 1 }] }));
  });

  it("getMetaInfoList 应返回元信息", async () => {
    const res = mockRes();
    await call({ method: "POST", url: "/getMetaInfoList", body: { from: 0 } }, res);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ result: [{ mailId: 1 }] }));
  });

  it("receiveAllMail 应批量领取", async () => {
    const res = mockRes();
    await call({ method: "POST", url: "/receiveAllMail", body: { mailIdList: [1] } }, res);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ items: [{ id: "4001", type: "GOLD", count: 100 }] }));
  });

  it("removeAllReceivedMail 应清理邮件", async () => {
    const res = mockRes();
    await call({ method: "POST", url: "/removeAllReceivedMail", body: { mailIdList: [1] } }, res);
    expect(mailManager.removeAllReceivedMail).toHaveBeenCalledWith("10000", { mailIdList: [1] });
    expect(res.send).toHaveBeenCalledWith({ modified: {} });
  });
});
