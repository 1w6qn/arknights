import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("express-http-context2", () => ({
  default: { get: vi.fn(), set: vi.fn() },
}));

/** excel mock 行形状（本文件用到的字段子集） */
interface ExcelRowMock {
  name?: string;
}

/** 干员行夹具形状（本文件用到的字段子集） */
interface ExcelCharRowMock {
  charId?: string;
  rarity?: string;
  profession?: string;
}

vi.mock("@excel/excel", () => ({
  default: {
    ItemTable: undefined as { items?: Record<string, ExcelRowMock> } | undefined,
    CharacterTable: undefined as Record<string, ExcelCharRowMock> | undefined,
    StageTable: undefined as { stages?: Record<string, ExcelRowMock> } | undefined,
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    getItem(id: string): ExcelRowMock | undefined { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string): ExcelCharRowMock | undefined { return this.CharacterTable?.[charId]; },
    stageData(stageId: string): ExcelRowMock | undefined { return this.StageTable?.stages?.[stageId]; },

    ShopTable: {
      skinGoodList: { goodList: [] },
      lowGoodList: { goodList: [], groups: [], shopEndTime: 0, newFlag: [] },
      highGoodList: { goodList: [], progressGoodList: {}, newFlag: [] },
      classicGoodList: { goodList: [], progressGoodList: {}, newFlag: [] },
      LMTGSGoodList: { goodList: [], newFlag: [] },
      EPGSGoodList: { goodList: [], newFlag: [] },
      REPGoodList: { goodList: [], newFlag: [] },
    },
    SkinTable: { charSkins: {} },
  },
}));

import type { Response } from "express";
import httpContext from "express-http-context2";
import shopRouter from "@game/modules/shop/routes";
import { mockPlayerData, asModel } from "../../helpers";
import type { SkinGoodList } from "@excel/excel";
import type { SkinTable } from "@excel/types_excel_gen";
import type { PlayerShop } from "@game/kernel/playerdata";

/** 商店请求体视图（本文件各端点字段合集） */
interface ShopBody {
  goodIdMap?: { [shopKey: string]: string[] };
}

/** 路由测试请求视图（只声明被测分支读到的三个成员） */
interface MockReq {
  method: string;
  url: string;
  body: ShopBody;
}

/** 路由测试响应视图（只声明被测分支读到的四个方法） */
interface MockRes {
  send: Response["send"];
  status: Response["status"];
  sendStatus: Response["sendStatus"];
  json: Response["json"];
}

type RouterReq = Parameters<typeof shopRouter>[0];

function mockRes(): MockRes {
  return {
    send: vi.fn<Response["send"]>(),
    status: vi.fn<Response["status"]>().mockReturnThis(),
    sendStatus: vi.fn<Response["sendStatus"]>(),
    json: vi.fn<Response["json"]>(),
  };
}

/**
 * 组装 shop 用例的玩家组合根
 *
 * 路由跨周期刷新经 `player.modules.shop` 访问（组合根替身的窄接口不含 modules），
 * 故用 `Object.assign` 在运行时挂载管理器替身，其余成员保持 mock 原样。
 */
function makePlayer() {
  const mock = mockPlayerData({
    shop: {
      LS: { info: [{ id: "LS_good_1", count: 2 }] },
      HS: { info: [] },
      GP: {
        oneTime: { info: [{ id: "GP_Once_330", count: 1 }] },
        weekly: { info: [] },
      },
      CASH: { info: [{ id: "CS_1_r1", count: 1 }] },
      SOCIAL: { info: [] },
      CLASSIC: { info: [] },
    },
  });
  return Object.assign(mock, {
    // 商店管理器（路由跨周期刷新依赖，经 player.modules.shop 访问）
    modules: {
      shop: {
        todayLowShopId: () => "lggShdShopnumber88",
        todayExtraShopId: () => "xShdShopnumber5",
        monthlyRefresh: vi.fn(async () => {
          mock._playerdata.shop.LS.curShopId = "lggShdShopnumber88";
          mock._playerdata.shop.LS.info = [];
        }),
        refreshExtraShop: vi.fn(async () => {
          mock._playerdata.shop.ES.curShopId = "xShdShopnumber5";
          mock._playerdata.shop.ES.info = [];
        }),
        todaySocialShopId: () => "SOCIAL20260818",
        refreshSocialShop: vi.fn(async () => {}),
      },
    },
  });
}

type PlayerFixture = ReturnType<typeof makePlayer>;

describe("shop 路由", () => {
  let player: PlayerFixture;
  let res: MockRes;

  beforeEach(() => {
    vi.clearAllMocks();
    player = makePlayer();
    res = mockRes();
    vi.mocked(httpContext.get).mockReturnValue(player);
  });

  async function call(url: string, body: ShopBody) {
    const req: MockReq = { method: "POST", url, body };
    // mock 请求/响应只覆盖被测分支用到的成员，故按窄视图断言为 express Request/Response
    shopRouter(req as RouterReq, res as Response, () => {});
    await new Promise((r) => setTimeout(r, 20));
  }

  it("getGoodPurchaseState 应返回扁平 {goodId: 1|-1}（已购 -1 / 可购 1），对齐 CS 与抓包", async () => {
    await call("/getGoodPurchaseState", {
      goodIdMap: {
        LS: ["LS_good_1", "LS_not_bought"],
        GP: ["GP_Once_330"], // 嵌套结构（oneTime.info）
        CASH: ["CS_1_r1"],
        HS: [],
      },
    });
    const sent = vi.mocked(res.send).mock.calls[0][0];
    expect(sent.result).toEqual({
      LS_good_1: -1, // 已购买
      LS_not_bought: 1, // 可购买
      GP_Once_330: -1, // GP 嵌套信息正确识别
      CS_1_r1: -1,
    });
    expect(Object.keys(sent.result).length).toBe(4); // 只返回请求的 goodId，而非全部 info
  });

  it("getGoodPurchaseState 空 goodIdMap 应返回空 result", async () => {
    await call("/getGoodPurchaseState", { goodIdMap: {} });
    const sent = vi.mocked(res.send).mock.calls[0][0];
    expect(sent.result).toEqual({});
  });

  it("getSkinGoodList 应过滤皮肤表缺失条目并重排唯一 slotId", async () => {
    const excelMock = await import("@excel/excel");
    const excel = excelMock.default;
    // 构造含冲突 slotId + 无效皮肤的数据（夹具只声明被测分支读到的字段）
    excel.ShopTable.skinGoodList = asModel<SkinGoodList>({
      goodList: [
        { goodId: "SS_skin_a#1", skinId: "skin_a#1", charId: "char_a", price: 18, slotId: 45 },
        { goodId: "SS_skin_b#1", skinId: "skin_b#1", charId: "char_b", price: 18, slotId: 45 }, // 与上冲突
        { goodId: "SS_bad#1", skinId: "not_in_table#1", charId: "char_b", price: 18, slotId: 46 }, // 皮肤表缺失
      ],
    });
    excel.SkinTable = asModel<SkinTable>({
      charSkins: {
        "skin_a#1": { charId: "char_a", skinId: "skin_a#1", isBuySkin: true },
        "skin_b#1": { charId: "char_b", skinId: "skin_b#1", isBuySkin: true },
      },
    });
    // 注：data/config.json 的 config.shop.skinSellAll=true → 走「售卖全部可购买皮肤」自动
    // 生成路径（仅收录 charSkins 中 isBuySkin 的皮肤，天然过滤皮肤表缺失条目并重排 slotId）
    await call("/getSkinGoodList", {});
    const sent = vi.mocked(res.send).mock.calls[0][0];
    // 无效皮肤被过滤（2 条）
    expect(sent.goodList).toHaveLength(2);
    // slotId 唯一连续（1..n），无冲突
    /** 皮肤商品行响应视图（本用例读 slotId） */
    interface SkinGoodRowView { slotId: number }
    const ids = (sent.goodList as SkinGoodRowView[]).map((g) => g.slotId);
    expect(new Set(ids).size).toBe(2);
    expect(ids.sort((a: number, b: number) => a - b)).toEqual([1, 2]);
  });

  it("getLowGoodList 旧月份 curShopId 应跨月重置（剩余时间不为负）", async () => {
    // 玩家 LS.curShopId 停留在旧月份（迁移数据）
    player._playerdata.shop.LS.curShopId = "lggShdShopnumber69";
    await call("/getLowGoodList", {});
    // 触发 monthlyRefresh → delta 更新当月 curShopId
    expect(player.modules.shop.monthlyRefresh).toHaveBeenCalled();
    expect(player._playerdata.shop.LS.curShopId).toBe("lggShdShopnumber88");
    expect(player._playerdata.shop.LS.info).toEqual([]);
  });

  it("getExtraGoodList 旧年份 curShopId 应跨年重置（剩余时间不为负）", async () => {
    player._playerdata.shop.ES = asModel<PlayerShop["ES"]>({ curShopId: "xShdShopnumber2", info: [{ id: "ES_xShdShopnumber2_1", count: 6 }] });
    await call("/getExtraGoodList", {});
    expect(player.modules.shop.refreshExtraShop).toHaveBeenCalled();
    expect(player._playerdata.shop.ES.curShopId).toBe("xShdShopnumber5");
    expect(player._playerdata.shop.ES.info).toEqual([]);
  });
});
