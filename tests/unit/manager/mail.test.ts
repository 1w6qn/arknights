import { describe, it, expect, vi, beforeEach } from "vitest";

// 拦截文件读写：构造器 readFileSync 返回测试邮件库，saveDatabase 不落盘
// 夹具显式按 MailDB 声明，使附件 type 保持 ItemType 字面量（否则被放宽为 string，
// 传给 nextMailId 时不再满足 MailDB）
const testDB = vi.hoisted((): MailDB => ({
  user: {
    "10000": [
      {
        uid: "10000",
        mailId: 1000001,
        from: "system",
        subject: "测试邮件",
        content: "你好",
        createAt: 100,
        expireAt: 200,
        receiveAt: -1,
        state: 0,
        style: { route: 0, banner: "" },
        platform: -1,
        type: 0,
        hasItem: 1,
        items: [{ id: "30012", type: "MATERIAL", count: 5 }],
      },
      {
        uid: "10000",
        mailId: 1000002,
        from: "system",
        subject: "已领取",
        content: "",
        createAt: 100,
        expireAt: 200,
        receiveAt: 150,
        state: 1,
        style: { route: 0, banner: "" },
        platform: -1,
        type: 0,
        hasItem: 0,
        items: [],
      },
    ],
  },
}));

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => JSON.stringify(testDB)),
}));
vi.mock("fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@utils/time", () => ({ now: () => 1234567890 }));
// mail.ts 使用无前缀路径 app/game/excel/excel（vitest 无此 alias），mock 拦截
vi.mock("app/game/excel/excel", () => ({ ItemBundle: {} }));

import { MailManager, buildMailItem, nextMailId } from "@game/modules/mail/mail-manager";
import type { MailDB } from "@game/modules/mail/mail-manager";
import { writeFile } from "fs/promises";

describe("MailManager", () => {
  let manager: MailManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new MailManager();
  });

  it("listMailbox 应按 id 过滤邮件", async () => {
    const result = await manager.listMailbox("10000", {
      sysMailIdList: [1000001],
      surveyMailIdList: [],
      mailIdList: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0].mailId).toBe(1000001);
  });

  it("receiveMail 应领取未读邮件的附件", async () => {
    const items = await manager.receiveMail("10000", { mailId: 1000001, type: 0 });
    expect(items).toEqual([{ id: "30012", type: "MATERIAL", count: 5 }]);
    const mail = manager.database.user["10000"][0];
    expect(mail.receiveAt).toBe(1234567890);
  });

  it("receiveMail 已领取的邮件不应重复返回附件", async () => {
    const items = await manager.receiveMail("10000", { mailId: 1000002, type: 0 });
    expect(items).toEqual([]);
  });

  it("getMetaInfoList 应返回邮件元信息", async () => {
    const meta = await manager.getMetaInfoList("10000", { from: 0 });
    expect(meta).toHaveLength(2);
    expect(meta[0]).toEqual(
      expect.objectContaining({ mailId: 1000001, hasItem: 1, type: 0 }),
    );
  });

  it("receiveAllMail 应批量领取全部未读附件", async () => {
    // 两封：一封未读（有附件）、一封已读
    const items = await manager.receiveAllMail("10000", {
      sysMailIdList: [1000001, 1000002],
      surveyMailIdList: [],
      mailIdList: [],
    });
    expect(items).toHaveLength(1);
  });

  it("removeAllReceivedMail 应移除指定邮件", async () => {
    await manager.removeAllReceivedMail("10000", {
      sysMailIdList: [1000001],
      surveyMailIdList: [],
      mailIdList: [],
    });
    expect(manager.database.user["10000"]).toHaveLength(1);
  });

  it("sendMail 应创建新邮件并落盘", async () => {
    const mail = await manager.sendMail("10000", {
      subject: "新邮件",
      content: "内容",
      items: [{ id: "4001", type: "GOLD", count: 100 }],
    });
    expect(mail.mailId).toBeGreaterThanOrEqual(1000000);
    expect(mail.hasItem).toBe(1);
    expect(manager.database.user["10000"]).toHaveLength(3);
    expect(writeFile).toHaveBeenCalled();
  });

  it("listAllMail 应返回某用户全部邮件（不做过滤）", () => {
    const all = manager.listAllMail("10000");
    expect(all).toHaveLength(2);
    expect(all.map((m) => m.mailId)).toEqual([1000001, 1000002]);
  });

  it("listAllMail 对无邮件用户应返回空数组", () => {
    expect(manager.listAllMail("99999")).toEqual([]);
  });

  it("deleteMail 应删除单封邮件并落盘", async () => {
    const ok = await manager.deleteMail("10000", 1000001);
    expect(ok).toBe(true);
    expect(manager.database.user["10000"].map((m) => m.mailId)).toEqual([1000002]);
    expect(writeFile).toHaveBeenCalled();
  });

  it("deleteMail 对不存在邮件应返回 false", async () => {
    expect(await manager.deleteMail("10000", 999999)).toBe(false);
  });

  it("uid 无邮件时 getMetaInfoList 应返回空数组（不 500）", async () => {
    const meta = await manager.getMetaInfoList("99999", { from: 0 });
    expect(meta).toEqual([]);
  });

  it("uid 无邮件时 listMailbox / receiveAllMail 应返回空数组（不 500）", async () => {
    const emptyArgs = { sysMailIdList: [], surveyMailIdList: [], mailIdList: [] };
    await expect(manager.listMailbox("99999", emptyArgs)).resolves.toEqual([]);
    await expect(manager.receiveAllMail("99999", emptyArgs)).resolves.toEqual([]);
  });

  it("uid 无邮件时 removeAllReceivedMail 不应抛错且不产生 undefined 键", async () => {
    await manager.removeAllReceivedMail("99999", {
      sysMailIdList: [],
      surveyMailIdList: [],
      mailIdList: [],
    });
    expect(manager.database.user["99999"]).toEqual([]);
  });
});

describe("nextMailId / buildMailItem", () => {
  it("nextMailId 应在现有最大值基础上 +1", () => {
    expect(nextMailId(testDB)).toBe(1000003);
  });

  it("nextMailId 最小值为 1000000", () => {
    expect(nextMailId({ user: {} })).toBe(1000000);
  });

  it("buildMailItem 应构造完整邮件对象", () => {
    const mail = buildMailItem("10000", { subject: "S", content: "C", items: [] }, 2000000);
    expect(mail.mailId).toBe(2000000);
    expect(mail.hasItem).toBe(0);
    expect(mail.receiveAt).toBe(-1);
    expect(mail.expireAt).toBe(1234567890 + 30 * 24 * 3600);
  });
});
