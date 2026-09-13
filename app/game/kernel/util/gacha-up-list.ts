/**
 * 抽卡共享工具（domain/util 公共件）
 *
 * GACHA_RULE_TYPE（gachaRuleType → 玩家数据子结构名）与 resolveEffectiveUpPerCharList
 * （生效 UP 干员列表纯函数）原属 gacha 模块、ShopManager 等跨模块消费；
 * 2026-09-13 上移 `kernel/util`（本文件），gacha/shop 统一从本层取用，消除 shop → gacha 值级耦合。
 * `gacha/gacha.ts` 仍 re-export `GACHA_RULE_TYPE` 以兼容既有消费点。
 */
import type {
  GachaDetailData,
  GachaDetailTable,
  GachaPerChar,
  GachaPoolClientData,
} from "@excel/excel";
import type { PlayerGacha } from "../playerdata";
import { getIn } from "@utils/json-path";

export const GACHA_RULE_TYPE: { [rule: string]: string } = {
    NORMAL: "normal",
    ATTAIN: "attain",
    LIMITED: "limit",
    SINGLE: "single",
    CLASSIC: "classic",
    CLASSIC_ATTAIN: "classic",
    CLASSIC_DOUBLE: "doubleGacha",
    FESCLASSIC: "fesClassic",
    SPECIAL: "special",
    BACKFLOW: "backflow",
    DOUBLE: "double",
    NEWBEE: "newbee",
    LINKAGE: "linkage",
};


/**
 * 生效 UP 干员列表（纯函数版，供 ShopManager 等跨模块直接调用）
 *
 * 内联 GachaManager.effectiveUpPerCharList/_selfSelectedUpDict 的实现：
 * 静态 upCharInfo.perCharList 为基座，按稀有度用玩家自选 charIdList 覆盖。
 * 详情缺失时回退首个结构完整卡池（upCharInfo 置空走通用池）。返回克隆，不改共享详情。
 *
 * @param table - 抽卡详情表（excel.GachaDetailTable）
 * @param poolConfigs - 卡池客户端配置列表（excel.GachaTable.gachaPoolClient）
 * @param gacha - 玩家抽卡数据（含自选 UP 字典）
 * @param poolId - 抽卡池ID
 * @returns 合并玩家自选后的 perCharList（克隆）
 */
/**
 * 卡池详情回退构造（通用池）
 *
 * `gacha_detail_table.details` 可能缺池（新池未合并详情），此时回退「通用池」：
 *  - 有任一结构完整卡池时取其结构，但 **upCharInfo / limitedChar / weightUpCharInfoList 置空**
 *    （首池的限定/加权干员属于别的池，照搬会让展示错位）；
 *  - 完全空表时给最小结构（空 perCharList / perAvailList + `gachaObjGroups: null`）。
 *
 * `gachaObjGroups` 是客户端解析必需字段（CS 声明必填），统一补 `null`。
 * 本函数是 gacha 模块内**唯一**的「最小通用池 → 完整 GachaDetailData」断言点：
 * 断言目标写成 `构造物 & GachaDetailData`（交叉类型与构造物必然重叠，故不需要
 * `as unknown as`），运行期就是这份对象，缺的字段由客户端按缺省处理（与旧实现同一对象）。
 * @param details - 详情表（`excel.GachaDetailTable.details`）
 * @returns 通用池详情
 */
export function buildFallbackGachaDetail(
  details: GachaDetailTable["details"],
): GachaDetailData {
  const first = Object.values(details).find(
    (x) => x?.availCharInfo?.perAvailList?.length,
  );
  if (first) {
    return {
      ...first,
      upCharInfo: { perCharList: [] },
      limitedChar: [],
      weightUpCharInfoList: [],
      gachaObjGroups: null,
    } as GachaDetailData;
  }
  const minimal = {
    upCharInfo: { perCharList: [] },
    availCharInfo: { perAvailList: [] },
    gachaObjGroups: null,
  };
  return minimal as typeof minimal & GachaDetailData;
}

export function resolveEffectiveUpPerCharList(
  table: GachaDetailTable,
  poolConfigs: GachaPoolClientData[],
  gacha: PlayerGacha | undefined,
  poolId: string,
): GachaPerChar[] {
  // 缺详情回退通用池（无缓存，每次重建）
  const d = table.details[poolId] ?? buildFallbackGachaDetail(table.details);
  // 格式归一：CS GachaDetailData.gachaObjGroups 为客户端解析必需字段，缺失时补 null
  // （用 hasOwnProperty 而非 `in`：TS 已知该属性为必填，`in` 反查会收窄成 never）
  if (d && !Object.prototype.hasOwnProperty.call(d, "gachaObjGroups")) {
    d.gachaObjGroups = null;
  }
  const base: GachaPerChar[] = (d.upCharInfo?.perCharList ?? []).map(
    (c) => ({ ...c, charIdList: [...c.charIdList] }),
  );
  // _selfSelectedUpDict 内联：字典形态（{稀有度: 干员列表}）才合并
  const cfg = poolConfigs.find((g) => g.gachaPoolId === poolId);
  const gachaType = GACHA_RULE_TYPE[cfg?.gachaRuleType ?? ""] ?? "single";
  // gachaType 为运行时字符串（服务端按规则类型动态建键）→ 经 json-path 下钻，返回 JSON 域值
  const upChar = getIn(gacha, [gachaType, poolId, "upChar"]);
  if (!upChar || typeof upChar !== "object" || Array.isArray(upChar)) {
    return base;
  }
  const result = base.map((c) => ({ ...c, charIdList: [...c.charIdList] }));
  for (const [rankKey, charIds] of Object.entries(upChar)) {
    const rank = Number(rankKey);
    if (!Number.isInteger(rank) || !Array.isArray(charIds) || !charIds.length) {
      continue;
    }
    const charIdList = charIds as string[];
    const ex = result.find((c) => c.rarityRank === rank);
    if (ex) {
      ex.charIdList = [...charIdList];
      ex.count = 1;
    } else {
      result.push({
        rarityRank: rank,
        charIdList: [...charIdList],
        percent: 0.35,
        count: 1,
      });
    }
  }
  return result;
}
