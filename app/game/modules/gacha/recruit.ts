import excel from "@excel/excel";
import { GachaResult } from "./gacha";
import {
  randomChoice,
  randomChoices,
  randomInt,
  randomSample,
} from "@utils/random";
import { now } from "@utils/time";
import { PlayerDataManager } from "../../kernel/player-data-manager";
import { BadRequestError } from "@core/http/errors";
import { TypedEventEmitter } from "../../kernel/events/runtime";
import { rarityToIndex } from "@utils/rarity";
import type { PlayerBuildingHire } from "../../kernel/playerdata";

/** 人力办公室房间视图（服务端扩展：`refreshStock` 为旧存档回退字段，官方字段为 `refreshCount`） */
type HireRoomView = PlayerBuildingHire & { refreshStock?: number };

export class RecruitManager {
  _player: PlayerDataManager;
  _trigger: TypedEventEmitter;

  constructor(player: PlayerDataManager, _trigger: TypedEventEmitter) {
    this._player = player;
    this._trigger = _trigger;
    this._trigger.on("recruit:refresh:tags", async ([args]) => {
      await this.refreshTags(args);
    });
  }

  async refreshTags(args: { slotId: number }): Promise<void> {
    const { slotId } = args;
    await this._player.update(async (draft) => {
      // 官方人脉资源消耗（2026-08-25 基建对齐，办公室页）：标签刷新消耗人力办公室
      // 联络库存（building.rooms.HIRE[].refreshStock，_accrueHire 每 12h 充能 1 次，
      // 上限 3）——库存 0 时拒绝刷新；私服兑底：无人力办公室/未进驻 → 免消耗放行，
      // 避免公开招募锁死。
      let stationedRoom: HireRoomView | null = null;
      for (const [hireSlotId, roomRaw] of Object.entries(
        draft.building?.rooms?.HIRE ?? {},
      )) {
        const stationed = (
          draft.building.roomSlots[hireSlotId]?.charInstIds ?? []
        ).some((i: number) => i > 0);
        if (stationed) {
          stationedRoom = roomRaw;
          break;
        }
      }
      if (stationedRoom) {
        // 修复（2026-09-09）：人脉库存读官服字段 refreshCount（原实现读服务端自建
        // refreshStock，官服迁移存档只有 refreshCount → 恒判 0，标签刷新被拒）
        const stock =
          stationedRoom.refreshCount ?? stationedRoom.refreshStock ?? 0;
        if (stock <= 0) return; // 人脉不足
        stationedRoom.refreshCount = stock - 1;
        stationedRoom.refreshStock = stock - 1;
      }
      draft.recruit.normal.slots[slotId].tags =
        await RecruitTools.refreshTagList();
    });
  }

  /**
   * 同步招募状态
   * 将已到期的招募槽位标记为可领取（state=3），供客户端刷新招募页
   */
  async sync() {
    await this._player.update(async (draft) => {
      const slots = draft.recruit.normal.slots;
      for (const slotId of Object.keys(slots)) {
        const slot = slots[slotId];
        if (
          slot.state === 2 &&
          slot.realFinishTs !== -1 &&
          slot.realFinishTs <= now()
        ) {
          slot.state = 3;
        }
      }
    });
  }

  async cancel(args: { slotId: number }) {
    await this._player.update(async (draft) => {
      const { slotId } = args;
      // 防御：客户端可能请求未初始化的槽位（如满级号仅 4 槽但客户端发 4/5），
      // 缺失时按空槽重置而非 500（fix: cancelNormalGacha 满级号 500）
      const slot = draft.recruit.normal.slots[slotId];
      if (!slot) {
        draft.recruit.normal.slots[slotId] = {
          state: 1,
          selectTags: [],
          startTs: -1,
          maxFinishTs: -1,
          realFinishTs: -1,
          durationInSec: -1,
          tags: await RecruitTools.refreshTagList(),
        };
        return;
      }
      slot.state = 1;
      slot.selectTags = [];
      slot.startTs = -1;
      slot.maxFinishTs = -1;
      slot.realFinishTs = -1;
      slot.durationInSec = -1;
      slot.tags = await RecruitTools.refreshTagList();
    });
  }

  async buyRecruitSlot(args: { slotId: number }) {
    await this._player.update(async (draft) => {
      const { slotId } = args;
      draft.recruit.normal.slots[slotId].state = 1;
    });
  }

  async normalGacha(args: {
    slotId: number;
    tagList: number[];
    specialTagId: number;
    duration: number;
  }) {
    await this._player.update(async (draft) => {
      const { slotId, tagList, duration } = args;
      draft.recruit.normal.slots[slotId] = {
        state: 2,
        selectTags: tagList.map((tag) => ({ tagId: tag, pick: 1 })),
        startTs: now(),
        maxFinishTs: now() + duration,
        realFinishTs: now() + duration,
        durationInSec: duration,
        tags: await RecruitTools.refreshTagList(),
      };
      await this._player.gainItem.setTarget("7001", "TKT_RECRUIT", 1).use();
      await this._trigger.emit("NormalGacha", []);
    });
  }

  /**
   * 结算公开招募（出干员）
   *
   * 修复（2026-09-09）：原实现**无任何时间校验** —— 开始招募后立即调用本接口即可
   * 零成本秒出干员，完全绕过「等待 duration」与「消耗 1 张加急许可（7002）加速」
   * 两条正规路径。现要求招募确已完成（realFinishTs ≤ now；加急后同样满足）。
   *
   * @param args.slotId - 招募槽位
   * @throws BadRequestError 槽位不存在或招募尚未完成
   */
  async finish(args: { slotId: number }): Promise<GachaResult> {
    return await this._player.update(async (draft) => {
      const { slotId } = args;
      const slot = draft.recruit.normal.slots[slotId];
      if (!slot) {
        throw new BadRequestError(`招募槽位 ${slotId} 不存在`);
      }
      if (Number(slot.realFinishTs ?? -1) > now()) {
        throw new BadRequestError("招募尚未完成（请等待或用加急许可加速）");
      }
      const { durationInSec, selectTags } =
        this._player._playerdata.recruit.normal.slots[slotId];
      const [char_id, filtered] = await RecruitTools.generateValidTags(
        durationInSec,
        selectTags.map((v) => v.tagId),
      );
      draft.recruit.normal.slots[slotId].selectTags = selectTags.map((tag) => ({
        tagId: tag.tagId,
        pick: filtered.includes(tag.tagId) ? 1 : 0,
      }));
      await this.cancel(args);
      let result!: GachaResult;
      await this._trigger.emit("char:get", [
        char_id,
        { from: "NORMAL" },
        (res: GachaResult) => {
          result = res;
        },
      ]);
      // 修复：勋章 RecruitCount 事件从未 emit → 招募次数勋章永不推进
      await this._trigger.emit("RecruitCount", []);
      return result;
    });
  }

  /**
   * 加急完成公开招募（消耗 1 张加急许可）
   *
   * 修复（2026-09-09，两处）：
   * 1. **扣错物品**：原实现扣 @@{ id: "7001", type: "TKT_INST_FIN" }@@ —— id 是**招聘许可**
   *    （7001 / TKT_RECRUIT），与 type 不一致；官方加急许可 id = **7002**
   *    （本地权威数据：@@data/shop/SocialGoodList.json@@ 的信用商店条目
   *    @@{"id":"7002","count":1,"type":"TKT_INST_FIN"}@@，物品名「加急许可」）。
   *    扣费按 type 落到 @@status.instantFinishTicket@@ 故数值看似正常，但载荷 id 会让
   *    按 id 记账的消费方与「物品不足：7001」错误文案错位。
   * 2. **完成态**：原实现写 @@state = 2@@（进行中），而 @@sync()@@ 的规则是「realFinishTs
   *    ≤ now → state 3（可领取）」——加急后客户端须再调一次 @@syncNormalGacha@@ 才显示可领取。
   *    现直接写 3，与 sync 同口径。
   * 另补防御：非「进行中」（state ≠ 2）或槽位不存在时不消耗加急许可。
   *
   * @param args.slotId - 招募槽位
   * @param args.buy - CS 字段，语义（是否就地购买加急许可）无本地权威数据，暂不读取
   */
  async boost(args: { slotId: number; buy: number }) {
    await this._player.update(async (draft) => {
      const { slotId } = args;
      const slot = draft.recruit.normal.slots[slotId];
      // 防御：空槽/已完成槽不消耗加急许可（原实现无条件扣券）
      if (!slot || slot.state !== 2) return;
      slot.realFinishTs = now();
      slot.state = 3; // 立即完成 → 可领取（与 sync() 同口径）
      await this._trigger.emit("BoostNormalGacha", []);
      await this._player.gainItem.setTarget("7002", "TKT_INST_FIN", 1).use();
    });
  }
}
interface CharData {
  [charId: string]: {
    name: string;
    rarity: number;
    tags: number[];
  };
}
export class RecruitTools {
  static async refreshTagList(): Promise<number[]> {
    const rankWeights = {
      "6star": 0.210417,
      "5star": 0.523127,
      "4star": 14.988323,
      "3star": 79.11354,
      "2star": 3.51041,
      "1star": 0.554183,
    };
    let tagsSet: number[] = [];

    const [charsList, charData] = await this.generateRecruitableData();
    const ranks = Object.keys(rankWeights);
    const probs = Object.values(rankWeights);

    while (tagsSet.length < 5) {
      const randomGroup = randomChoices(ranks, probs, 10);
      const charPool = randomGroup.map((group) =>
        randomChoice(charsList[parseInt(group[0]) - 1]),
      );
      tagsSet = [
        ...new Set(charPool.flatMap((char) => charData[char].tags)),
      ] as number[];
    }
    return randomSample(tagsSet, 5).sort((a, b) => a - b);
  }

  static async generateValidTags(
    duration: number,
    tagList: number[],
  ): Promise<[string, number[]]> {
    const [charList, charData] = await this.generateRecruitableData();
    const selectedTags = randomSample(tagList, randomInt(0, 3));
    // 数据驱动稀有度范围（参考 ArkGachaService gacha_table.json）：
    // recruitRarityTable[时长/60]——3:50→230、7:40→460、9:00→540（key 为分钟）
    const gachaTable = excel.GachaTable;
    const durationMinutes = Math.round(duration / 60);
    const range =
      gachaTable?.recruitRarityTable?.[durationMinutes] ??
      gachaTable?.recruitRarityTable?.[540] ??
      { rarityStart: 0, rarityEnd: 3 };
    let charRange: [number, number] = [
      range.rarityStart ?? 0,
      range.rarityEnd ?? 3,
    ];
    // 特殊标签强制稀有度（specialTagRarityTable：11 高级资深干员→6星、14 资深干员→5星）；
    // 仅 9 小时（540 分钟）生效——短时招募特殊标签不保证稀有度（客户端标记为无效标签）
    if (durationMinutes >= 540) {
      const specialRaw = gachaTable?.specialTagRarityTable;
      const specialMap: Record<string, number[]> = Array.isArray(specialRaw)
        ? Object.fromEntries(specialRaw.map((s) => [s.key, s.value]))
        : (specialRaw ?? {});
      for (const [tag, rarities] of Object.entries(specialMap)) {
        if (selectedTags.includes(Number(tag))) {
          charRange = [rarities[0], rarities[rarities.length - 1]];
          break;
        }
      }
    }

    const alternateList: string[] = [];
    for (const [charId, value] of Object.entries(charData)) {
      if (charRange[0] <= value.rarity && value.rarity <= charRange[1]) {
        alternateList.push(charId);
      }
    }

    const alternateCharData = Object.fromEntries(
      Object.entries(charData).filter(([k]) => alternateList.includes(k)),
    );
    const matchingChars = Object.fromEntries(
      Object.entries(alternateCharData).filter(([char]) => {
        return selectedTags.some((tag) =>
          alternateCharData[char].tags.includes(tag),
        );
      }),
    );
    const sortedMatchingChars = Object.entries(matchingChars).sort((a, b) => {
      return (
        b[1].tags.filter((tag) => selectedTags.includes(tag)).length -
        a[1].tags.filter((tag) => selectedTags.includes(tag)).length
      );
    });

    if (selectedTags.length === 1 && !selectedTags.includes(11)) {
      const compensation = 6.3 - (duration / 600) * 0.05;
      const crossTag = randomChoices(
        [0, 1],
        [100 - compensation, compensation],
        1,
      )[0];
    }

    let randomCharId: string;
    if (sortedMatchingChars.length === 0) {
      charRange[1] += 1;
      const groupWeights = [5, 15, 77, 2, 1].slice(
        charRange[0],
        charRange[1] + 1,
      );
      const group = randomChoices(
        Array.from(
          { length: charRange[1] - charRange[0] + 1 },
          (_, i) => i + charRange[0],
        ),
        groupWeights,
        1,
      )[0];
      const allChars = charList[group];
      randomCharId = randomChoice(allChars);
    } else {
      randomCharId = randomChoice(sortedMatchingChars.map((x) => x[0]));
    }

    // 修复：划掉集合按**玩家本次选中的全部词条**计算（而非内部随机子集 selectedTags）。
    // 原实现对 selectedTags（randomSample 的 0~3 个）取反 → 玩家实际选中但干员确有的词条
    // 只要没被抽进子集就会误标 pick=0（客户端划掉）；真正该划掉的是"玩家选了但结果干员
    // 不具备"的词条。客户端按返回的 selectTags[].pick 划掉词条。
    const filterTags = tagList.filter(
      (x) => !charData[randomCharId].tags.includes(x),
    );

    return [randomCharId, filterTags];
  }

  private static parseRecruitableChars(s: string): Set<string> {
    const ret = new Set<string>();
    let minPos = s.indexOf("★" + "\\n");
    for (let rarity = 1; rarity <= 6; rarity++) {
      const startS = "★".repeat(rarity) + "\\n";
      const startPos = s.indexOf(startS, minPos) + startS.length;
      const endPos = s.indexOf("\n-", startPos);
      let s2: string;
      if (endPos === -1) {
        s2 = s.substring(startPos);
      } else {
        s2 = s.substring(startPos, endPos);
      }
      minPos = endPos;
      s2 = s2.replace(/<.*?>/g, "");
      const sl = s2.split("/");
      for (const v of sl) {
        ret.add(v.trim());
      }
    }
    return ret;
  }

  private static async generateRecruitableData(): Promise<
    [Record<number, string[]>, CharData]
  > {
    const tag2name = excel.GachaTable.gachaTags.slice(0, -2).reduce(
      (acc, v) => {
        acc[v.tagId] = v.tagName;
        return acc;
      },
      {} as Record<number, string>,
    );
    const name2tag = Object.fromEntries(
      Object.entries(tag2name).map(([k, v]) => [v, parseInt(k)]),
    );
    const profession2tag: Record<string, number> = {
      MEDIC: 4,
      WARRIOR: 1,
      PIONEER: 8,
      TANK: 3,
      SNIPER: 2,
      CASTER: 6,
      SUPPORT: 5,
      SPECIAL: 7,
    };
    const charsList: Record<number, string[]> = {};
    const charData: CharData = {};

    const recruitable = this.parseRecruitableChars(
      excel.GachaTable.recruitDetail,
    );

    for (const [charId, value] of Object.entries(excel.CharacterTable)) {
      // 修复：tagList 可能为 undefined（部分干员缺字段）——旧守卫仅判 === null
      // → generateRecruitableData 崩溃 500（finishNormalGacha）
      if (value.tagList == null || !recruitable.has(value.name)) {
        continue;
      }
      const data = {
        name: value.name,
        rarity: rarityToIndex(value.rarity), // 数字稀有度索引（0-5）——旧实现存字符串，
        // 与 charRange 数值比较恒 false → 招募永远匹配不到干员
        tags: [] as number[],
      };

      const tags = value.tagList
        .map((tag_name: string) => name2tag[tag_name])
        .filter((t: number | undefined): t is number => t !== undefined);
      if (data.rarity === 5) tags.push(11);
      else if (data.rarity === 4) tags.push(14);
      if (value.position === "MELEE") tags.push(9);
      else if (value.position === "RANGED") tags.push(10);
      const profTag = profession2tag[value.profession];
      if (profTag !== undefined) tags.push(profTag);

      data.tags = tags;
      charData[charId] = data;
    }

    for (const char of Object.keys(charData)) {
      if (char.startsWith("char_")) {
        const rarityIdx = rarityToIndex(charData[char].rarity);
        if (!charsList[rarityIdx]) {
          charsList[rarityIdx] = [];
        }
        charsList[rarityIdx].push(char);
      }
    }

    return [charsList, charData];
  }
}
