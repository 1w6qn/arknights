import { describe, it, expect } from "vitest";
import type { JsonValue } from "@excel/json-value";
import { setIn } from "@utils/json-path";
import { convertOfficialData } from "../../../scripts/official-convert";

/** 官服数据入参类型（syncData 的 user 字段） */
type OfficialInput = Parameters<typeof convertOfficialData>[0];

/**
 * 官服数据夹具视图
 *
 * `OfficialPlayerData` 只建模 `status`，其余顶层键为 `ServerPayload`（两层），
 * 而夹具沿用官服真实形状（recruit/openServer 等三层以上）并会写 `level` 等字段；
 * 故按夹具形状声明视图（真实类型可赋给该视图），经 {@link asOfficialData} 交给入参。
 * 运行期对象不变。
 */
interface OfficialFixture {
  status?: NonNullable<OfficialInput["status"]> & { level?: number };
  [key: string]: JsonValue | OfficialInput["status"] | undefined;
}

/** 夹具视图 → 官服数据入参（单向断言，见 {@link OfficialFixture}） */
function asOfficialData(fixture: OfficialFixture): OfficialInput {
  return fixture as OfficialInput;
}

/** 调用被测转换函数（两处入参均按夹具视图收口） */
function convert(
  official: OfficialFixture,
  opts: { newUid: string; template: OfficialFixture },
): OfficialInput {
  return convertOfficialData(asOfficialData(official), {
    newUid: opts.newUid,
    template: asOfficialData(opts.template),
  });
}

/**
 * 在转换结果上写入 recruit.normal.slots.<slotId>
 *
 * `recruit` 在 `OfficialPlayerData` 中只到 `ServerPayload`（两层），夹具为三层；
 * 故走服务端既有的 JSON 路径写入口（写入口径与 `data.recruit.normal.slots[id] = 1` 一致），
 * 避免为夹具新增断言。用途：证明深拷贝（模板对象未被改动）。
 */
function writeRecruitSlot(data: OfficialInput, slotId: string): void {
  setIn(data, ["recruit", "normal", "slots", slotId], 1);
}

describe("convertOfficialData", () => {
  it("应保留官服主体字段并替换 uid", () => {
    const data = convert(
      {
        status: { uid: "10001", nickName: "A", level: 60 },
        troop: { chars: {} },
        dungeon: { stages: {} },
      },
      { newUid: "3001", template: {} },
    );
    expect(data.status!.uid).toBe("3001");
    expect(data.status!.nickName).toBe("A");
    expect(data.troop).toBeDefined();
    expect(data.dungeon).toBeDefined();
  });

  it("私服特有字段应从模板兜底", () => {
    const template = {
      recruit: { normal: { slots: {} } },
      checkIn: { canCheckIn: 0 },
      openServer: { checkIn: { isAvailable: false } },
    };
    const data = convert(
      { status: { uid: "10001" } },
      { newUid: "3001", template: template },
    );
    expect(data.recruit).toEqual(template.recruit);
    expect(data.checkIn).toEqual(template.checkIn);
    expect(data.openServer).toEqual(template.openServer);
  });

  it("官方已有私服特有字段时应优先保留官方数据", () => {
    const template = { recruit: { normal: { slots: { "0": { state: 1 } } } } };
    const officialRecruit = { normal: { slots: { "0": { state: 3 } } } };
    const data = convert(
      { status: { uid: "10001" }, recruit: officialRecruit },
      { newUid: "3001", template: template },
    );
    expect(data.recruit).toEqual(officialRecruit);
  });

  it("应移除官服连接态字段", () => {
    const data = convert(
      { status: { uid: "10001" }, secret: "s", seqnum: 1 },
      { newUid: "3001", template: {} },
    );
    expect(data.secret).toBeUndefined();
    expect(data.seqnum).toBeUndefined();
  });

  it("不应修改模板对象（深拷贝）", () => {
    const template = { recruit: { normal: { slots: {} } } };
    const data = convert(
      { status: { uid: "10001" } },
      { newUid: "3001", template: template },
    );
    writeRecruitSlot(data, "x");
    expect(template.recruit.normal.slots).toEqual({});
  });
});
