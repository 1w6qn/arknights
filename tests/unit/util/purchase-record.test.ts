import { describe, it, expect } from "vitest";
import { recordPurchase, PurchaseRecord } from "@game/kernel/util/purchase-record";

describe("recordPurchase（商店购买记录单点实现）", () => {
  it("空数组：追加新记录", () => {
    const info: PurchaseRecord[] = [];
    recordPurchase(info, "GOOD_1", 2);
    expect(info).toEqual([{ id: "GOOD_1", count: 2 }]);
  });

  it("已存在同 id 记录：累加 count 而非追加", () => {
    const info: PurchaseRecord[] = [
      { id: "GOOD_1", count: 1 },
      { id: "GOOD_2", count: 5 },
    ];
    recordPurchase(info, "GOOD_2", 3);
    expect(info).toEqual([
      { id: "GOOD_1", count: 1 },
      { id: "GOOD_2", count: 8 },
    ]);
    expect(info.length).toBe(2);
  });

  it("多次购买同一商品持续累加", () => {
    const info: PurchaseRecord[] = [];
    recordPurchase(info, "GOOD_1", 1);
    recordPurchase(info, "GOOD_1", 2);
    recordPurchase(info, "GOOD_1", 3);
    expect(info).toEqual([{ id: "GOOD_1", count: 6 }]);
  });

  it("直接变异传入数组（mutative draft 场景兼容）", () => {
    const info: PurchaseRecord[] = [{ id: "A", count: 1 }];
    const ret = recordPurchase(info, "B", 1);
    expect(ret).toBeUndefined();
    expect(info.length).toBe(2);
    expect(info[1]).toEqual({ id: "B", count: 1 });
  });
});
