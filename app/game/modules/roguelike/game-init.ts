/**
 * 集成战略（rlv2）分区逻辑：开局（创建游戏/主题初始化/首发招募/开局遗物/放弃/置顶）
 *
 * 由 RoguelikeV2Manager 拆分而来：函数首参 mgr 为管理器实例，
 * 类侧保留同名薄委派（见 logic.ts）。
 */
import type { RoguelikeV2Manager } from "./logic";
import type { PlayerRoguelikeV2 } from "./rlv2";
import excel from "@excel/excel";
import type {
  RoguelikeTopicMonthMission,
  RoguelikeTopicUpdate,
} from "@excel/excel";
import { now } from "@utils/time";
import { PlayerDataModel } from "../../kernel/playerdata";
import { random } from "@utils/random";

  /**
   * 规范化 rlv2 持久态为可写（autoFreeze 兼容）
   *
   * Immer finishDraft 在 autoFreeze=true 下会冻结整个 _playerdata（含 rlv2 子树的
   * current/outer）。JS 无法解冻已冻结对象 → 用深可变副本替换 _playerdata.rlv2 并重建
   * 顶层 _playerdata（其余子树保持 finishDraft 冻结，仅 rlv2 可写孤岛解锁，与
   * AccountManager.deepFreezeExcept 排除 rlv2 的约定一致）。
   *
   * autoFreeze=false 下 rlv2 未冻结，原样返回（零开销，且维持 this.outer/current 与
   * _playerdata.rlv2 的引用别名——rlv2-ref-sync 测试依赖该别名）。
   *
   * @returns 规范化后的 _playerdata（rlv2 子树可写）
   */
export function _normalizeMutablePlayerdata(mgr: RoguelikeV2Manager) : PlayerDataModel {
    const st = mgr._player.playerStatus;
    const pd = st._playerdata;
    const rlv2 = pd.rlv2;
    // 未冻结（autoFreeze=false 或构造期首帧）：保持引用别名，零开销
    if (!rlv2 || !Object.isFrozen(rlv2)) return pd;
    // 已冻结：深可变副本替换 rlv2 子树并重建顶层 _playerdata
    const mutableRlv2 = JSON.parse(JSON.stringify(rlv2)) as typeof rlv2;
    const newPd = { ...pd, rlv2: mutableRlv2 };
    st._playerdata = newPd;
    return newPd;
}

export async function setPinned(mgr: RoguelikeV2Manager, args: { id: string }) : Promise<void> {
    const { id } = args;
    await mgr.update(async (draft) => {
      draft.pinned = id;
    });
}

/** 官服自定义种子长度（ODPY 同源：os.urandom(9).hex() = 18 位；本地随机种子亦为 18 位） */
export const RLV2_SEED_LENGTH = 18;

/** 官服自定义种子字符集（数字 + 大小写字母） */
const RLV2_SEED_CHARSET = /^[0-9A-Za-z]+$/;

/**
 * 设置自定义种子（客户端 /rlv2/setSeed，CS: RoguelikeTopicSetSeedRequest）
 *
 * 种子不落存档（官方 PlayerRoguelikeV2 无该字段，种子仅出现在 GAME_SETTLE 的 brief.seed），
 * 写入控制器内存 `_pendingSeed`，由下一局 gameSeed() 一次性消费。
 *
 * 返回值对齐 CS RoguelikeTopicSetSeedResponse.ResultCode：
 * 0 SUCCESS / 1 INVALID_LENGTH / 2 INVALID_CHARSET（3 SENSITIVE_WORD、4 FUNCTION_CLOSE、
 * 5 USER_BANNED 由官方风控/运营开关决定，私服不触发；6 FAIL 为服务端异常）。
 *
 * 注意：地图生成未按种子确定性重放（map.ts 依 random() 生成 zone 布局，对齐官服算法
 * 的资料不足），当前种子影响 GAME_SETTLE 的 brief.seed（战绩分享/复现串）。
 * @param mgr - 肉鸽管理器
 * @param args - { seed } 客户端下发种子
 * @returns ResultCode 结果码
 */
export async function setSeed(
  mgr: RoguelikeV2Manager,
  args: { seed: string },
): Promise<{ result: number }> {
  const seed = (args.seed ?? "").trim();
  if (seed.length !== RLV2_SEED_LENGTH) {
    return { result: 1 };
  }
  if (!RLV2_SEED_CHARSET.test(seed)) {
    return { result: 2 };
  }
  mgr._pendingSeed = seed;
  return { result: 0 };
}

export async function giveUpGame(mgr: RoguelikeV2Manager) : Promise<void> {
    // 放弃结算：清空进行中残留事件，生成唯一 GAME_SETTLE（展示放弃结算页），保留游戏态直至 gameSettle 确认
    mgr.clearPending();
    mgr._status.runResult = "giveup";
    const { brief, record, buffBankPut } = mgr.buildSettlement(true, 0, "");
    // current.record 为 _playerdata.rlv2 引用（update() 后冻结），写入须放入配方
    await mgr.update(async (draft) => {
      draft.current.record = { brief, record };
    });
    await mgr._trigger.emit("rlv2:event:create", [
      "GAME_SETTLE",
      {
        success: 0,
        result: { brief, record, buffBankPut },
        detailStr: mgr.buildDetailStr(brief),
        popReport: false,
      },
    ]);
    mgr._status.state = "PENDING";
}

export async function createGame(mgr: RoguelikeV2Manager, args: {
    theme: string;
    mode: string;
    modeGrade: number;
    predefinedId: string | null;
  }) : Promise<void> {
    const theme = args.theme;
    // 开新局：清除上一把结算的置空标志（否则 toJSON 继续输出 current 全空）
    mgr._settled = false;
    // 修复：开新局必须清空种子缓存——原实现 _gameSeed 只在首次生成后缓存，
    // 第二局起沿用它 → 每局结算 brief.seed 相同（自定义种子 setSeed 也会被上一局缓存吃掉）。
    // 清空后由 gameSeed() 重新取用 _pendingSeed 或随机生成。
    mgr._gameSeed = null;
    // 清空上一请求的残留推送（控制器为持久实例），并收集本局创建的入场推送。
    // 官服 createGame 必带 {path:"rlv2ScrapLimit",payload:{}}（黑流树海抓包 2026-08-11）。
    mgr._pushMessages = [];
    if (theme === "rogue_6") {
      mgr.pushMessage("rlv2ScrapLimit", {}, theme);
    }
    // 迁移：current.* 与 outer[theme] 都是 _playerdata.rlv2 的引用，update() 后会被
    // Immer autoFreeze 冻结，配方外原地写会抛错 → 全部放入 update() 配方内，经 finishDraft
    // 统一刷新 mgr.outer/mgr.current 引用（后续代码用 mgr.xxx 读安全）。
    await mgr.update(async (draft) => {
      draft.current.game = {
        // 模式：MONTH_TEAM（实践者列表）保留原模式——init 表有专属条目
        // （month_team_1/2，初始招募组 recruit_group_m1/m2）；仅 CHALLENGE 无专属
        // init 条目，强制走 NORMAL 规则（此前 MONTH_TEAM 也被转 NORMAL 但 predefinedId
        // 保留 month_team_N → status.create 的 init.find 无匹配崩溃 → 开局血 0/流程卡死）
        mode: args.mode === "CHALLENGE" ? "NORMAL" : args.mode,
        // 预置剧本 id：客户端未传/传空串（NORMAL 等无预置剧本）时归一为 null，
        // 避免 game.predefined=""（Game.predefined 类型为 string|null）
        predefined: args.predefinedId ?? null,
        theme: theme,
        outer: {
          // 支援选项（GAME_INIT_SUPPORT/startbuff 3 选 1）：仅当"上一把至少通过两层"（到达过第 3 层）才出现。
          // 官方判定依据 record.stageCnt 中存在 2 层（兼容 3 层）关卡通关记录（prts.wiki
          // 「至少通过两层」；8-11/8-18 官服 createGame 抓包对照：record 无 lastZone 键，
          // 有 3 层 stageCnt 且 support=true）。原实现用自定义 lastZone>=3 字段（官服 record 无此键）。
          support: mgr.hasReachedZone3(draft.outer?.[theme]?.record?.stageCnt),
          // 上局遗留襁褓预告：官服 game.outer = { support, legacy } 结构（8-18 抓包 legacy 可含
          // 襁褓 id），但与 record.legacy/GIFT 内容不同源——8-11 抓包 legacy=[] 而 GIFT=gold10。
          // 数据不足精确复现，先输出空数组对齐 8-11 结构（GIFT 内容由 record.legacy 驱动）。
          legacy: [],
        },
        start: now(),
        modeGrade: args.modeGrade,
        equivalentGrade: args.modeGrade,
      };
      draft.current.buff = {
        tmpHP: 0,
        capsule: null,
        squadBuff: [],
      };
      draft.current.record = { brief: null };
      draft.current.map = { zones: {} };
      draft.current.troop = {
        chars: {},
        expedition: [],
        expeditionDetails: {},
        expeditionReturn: null,
        hasExpeditionReturn: false,
      };
      // 首次游玩该主题：初始化 outer[theme] 基础结构（bank/bp/buff/collect/mission 等）
      mgr.ensureOuterTheme(theme, draft.outer, draft.current.game);
    });

    // 供 rlv2:create 事件处理器读取（其内部经 update() 写，正常）
    mgr._player.markDirty();
    await mgr._trigger.emit("rlv2:create", []);

    // 开局 legacy 襁褓藏品：
    // - 特勤任务影像（难度 0 失败补偿）：开局直接获得该收藏品
    // - 襁褓猫/狗等 init_gift 效果：由 GAME_INIT_GIFT 事件统一发放（events.create 按
    //   legacy 的 init_gift buff 数据驱动生成事件与内容）——此处不再直接加金/希望，避免双发
    const legacyList: string[] = mgr.outer?.[theme]?.record?.legacy || [];
    for (const legacyId of legacyList) {
      if (legacyId === "rogue_6_relic_fight_29") {
        await mgr._trigger.emit("rlv2:relic:gain", [
          { id: legacyId, count: 1 },
        ]);
      }
    }

    // "让探索走向不同的结局"藏品：改变结局走向（附加层由 maxZone 处理，此处切换 toEnding 为 2 号结局）。
    // 官方此类藏品（残破的玩偶/恍悟/初幕、决心/观望/犹疑/深蓝之心 等）触发 2 结局路线。
    const detail2 = excel.RoguelikeTopicTable.details[theme];
    const hasEndingChangeRelic = Object.values(mgr.inventory?.relic || {}).some(
      (r) => {
        const id = r.id;
        const usage = detail2?.items?.[id]?.usage || "";
        return usage.includes("让探索走向不同的结局") || usage.includes("不同结局");
      },
    );
    if (hasEndingChangeRelic) {
      mgr._status.toEnding = `ro${theme.slice(-1)}_ending_2`;
      mgr._status.chgEnding = true;
      // 结局变更推送（rlv2ChangeEnding，触发类 RoguelikeCheckOnlyEndingChangeNotifyTrigger）
      mgr.pushMessage("rlv2ChangeEnding", {});
    }

    // 难度 buff（进阶式累积）在 rlv2:create（模块初始化完成）之后应用——
    // scrap_limit_add 等需要 SCRAP 模块实例已创建，buff.create 阶段模块可能未就绪
    await mgr._buff.applyBuffs([
      mgr._buff.difficultyBuffs(theme, mgr.current.game!.modeGrade),
    ]);
}

  /**
   * 初始化主题局外数据（首次游玩）：collect.band 分队解锁状态等
   * 客户端按 collect.band[id].state 决定开局分队可选性
   * @param outerMap 局外数据字典（配方内传 draft.outer；配方外传 this.outer）
   * @param game     当前游戏态（配方内传 draft.current.game；配方外传 this.current.game）
   */
export function ensureOuterTheme(
  mgr: RoguelikeV2Manager,
  theme: string,
  outerMap?: { [theme: string]: PlayerRoguelikeV2.OuterData },
  game?: PlayerRoguelikeV2.CurrentData.Game | null,
) : void {
    const map = outerMap ?? mgr.outer;
    const gameRef = game ?? mgr.current.game;
    if (!map[theme]) {
      // 占位空对象（后续按需补齐 bank/bp/buff/mission/collect/record 各节）
      map[theme] = {} as PlayerRoguelikeV2.OuterData;
    }
    const target = map[theme];
    if (!target.collect) {
      const detail = excel.RoguelikeTopicTable.details[theme];
      // 分队全集：init.initialBandRelic（开局可选）+ bandRef 全部条目（含等级变体）
      const init = detail.init.find(
        (i) =>
          i.modeGrade == gameRef!.modeGrade &&
          i.predefinedId == gameRef!.predefined &&
          i.modeId == gameRef!.mode,
      );
      const initialBandIds: string[] = init?.initialBandRelic || [];
      const bandRef = (detail.bandRef || {}) as Record<
        string,
        { bandLevel?: number; normalBandId?: string }
      >;
      const allBandIds = [
        ...new Set([...initialBandIds, ...Object.keys(bandRef)]),
      ];
      target.collect = {
        // 分队解锁状态：基础分队（bandLevel 0）state 1 可开局选择；
        // 升级变体（bandLevel > 0）state 0 隐藏（按科技树/进度解锁，避免开局直接出高级分队）
        band: Object.fromEntries(
          allBandIds.map((id) => {
            const lv = bandRef[id]?.bandLevel ?? 0;
            return [id, { state: lv === 0 ? 1 : 0, progress: null }];
          }),
        ),
        relic: {},
        capsule: {},
        activeTool: {},
        mode: {},
        modeGrade: mgr.initModeGradeStates(theme, map, gameRef),
        recruitSet: {},
        buff: {},
        bgm: {},
        pic: {},
        chat: {},
        endBook: {},
        chatV2: {},
        // 开局仅初始化本主题用得到的图鉴节（totem/chaos/fragment/disaster/nodeUpgrade
        // 由各主题模块首次写入）；此处按运行时写入形状桥接到完整 Collection 视图
      } as PlayerRoguelikeV2.OuterData.Collection;
    }
    // 历史存档缺失 modeGrade 时补齐（难度解锁状态）
    if (!target.collect?.modeGrade) {
      target.collect.modeGrade = mgr.initModeGradeStates(theme, map, gameRef);
    }
    if (!target.bank) target.bank = { show: false, current: 0, record: 0, reward: {} };
    if (!target.bp) target.bp = { point: 0, reward: {} };
    if (!target.buff) target.buff = { pointOwned: 0, pointCost: 0, unlocked: {}, score: 0 };
    if (!target.mission) target.mission = { updateId: "", refresh: 0, list: [] };
    if (!target.record) {
      target.record = { last: 0, stageCnt: {}, bandCnt: {}, bandGrade: {} };
    }
    // 旧存档兼容：record.lastZone 是私服历史自定义字段（官服 record 无此键，
    // 8-11/8-18 抓包对照），保留读取兼容但不新增写入；新数据不再初始化。
    if (!Array.isArray(target.record.legacy)) target.record.legacy = [];
    // 分队升级可见性对齐：已有科技树解锁（如 分裂→指挥分队 band_2）时升级分队 state 1、
    // 旧分队隐藏（修复历史存档升级后旧分队未隐藏）
    const band = target.collect?.band;
    const unlocked = target.buff?.unlocked || {};
    if (band && typeof band === "object") {
      for (const buffId of Object.keys(unlocked)) {
        mgr.applyBandUpgradeVisibility(theme, buffId, band);
      }
      // 调查者增益（生灵的溯游）：难度 ≥3/6/9 时若已点亮 分裂/卵生/胎生 节点（科技树解锁），
      // 对应分队升级（指挥/后勤/矛头分队）自动生效
      const grade = gameRef?.modeGrade ?? 0;
      const lit = new Set(Object.keys(unlocked));
      const THRESHOLDS: { node: string; minGrade: number }[] = [
        { node: "rogue_6_difficulty_1", minGrade: 3 }, // 分裂（指挥分队升级）
        { node: "rogue_6_difficulty_2", minGrade: 6 }, // 卵生（后勤分队升级）
        { node: "rogue_6_difficulty_3", minGrade: 9 }, // 胎生（矛头分队升级）
      ];
      for (const { node, minGrade } of THRESHOLDS) {
        if (grade >= minGrade && lit.has(node)) {
          mgr.applyBandUpgradeVisibility(theme, node, band);
        }
      }
    }
}

  /**
   * 月度任务刷新（官方 POST /rlv2/normal/refreshMission，body { theme, index }）：
   * 按更新期（updates[index]）从 monthMission 任务池随机抽取 4 个（1A+1B+2C），
   * 写入 outer[theme].mission.list，响应并入 modified.rlv2（客户端 topic 页读取）。
   */
export async function refreshMission(mgr: RoguelikeV2Manager, args: { theme?: string; index?: number }) : Promise<void> {
    const theme = args.theme || mgr.current.game?.theme || "";
    if (!theme) return;
    const detail = excel.RoguelikeTopicTable.details[theme];
    const monthMission: RoguelikeTopicMonthMission[] = detail?.monthMission || [];
    if (monthMission.length === 0) return;

    // 更新期（index 指向 updates 数组；缺省取最后一个）
    const updates: RoguelikeTopicUpdate[] = detail?.updates || [];
    const idx = args.index ?? Math.max(0, updates.length - 1);
    const update = updates[idx] || updates[updates.length - 1];
    const updateId = update?.updateId || "";

    // 任务池按 class 分组（A/B/C），每组随机抽；tmpl 即 excel template
    const poolByClass: { [key: string]: RoguelikeTopicMonthMission[] } = {
      A: [],
      B: [],
      C: [],
    };
    for (const t of monthMission) {
      const cls = (t.taskClass || "C") as string;
      if (poolByClass[cls]) poolByClass[cls].push(t);
    }
    // 每类抽取数量：A×1、B×1、C×2（官方月度任务 4 槽位）
    const picks: { cls: string; task: RoguelikeTopicMonthMission }[] = [];
    for (const cls of ["A", "B", "C"]) {
      const count = cls === "C" ? 2 : 1;
      const copy = [...(poolByClass[cls] || [])];
      for (let i = 0; i < count && copy.length > 0; i++) {
        const task = copy.splice(Math.floor(random() * copy.length), 1)[0];
        picks.push({ cls, task });
      }
    }
    // 保底：C 类不足时从 A/B 补足到 4 槽
    while (picks.length < 4 && poolByClass.C.length > 0) {
      const task = poolByClass.C[Math.floor(random() * poolByClass.C.length)];
      picks.push({ cls: "C", task });
    }

    const list = picks.map(({ cls, task }) => {
      const target = parseInt(task.paramList?.[0] ?? "0", 10) || 1;
      return {
        type: cls,
        mission: {
          type: cls,
          tmpl: task.template,
          id: task.id,
          state: 0,
          target,
          value: 0,
        },
      };
    });

    // outer[theme] 为 _playerdata.rlv2 引用（update() 后冻结），写入须放入配方
    await mgr.update(async (draft) => {
      mgr.ensureOuterTheme(theme, draft.outer, draft.current.game);
      const outer = draft.outer[theme];
      outer.mission = {
        updateId,
        refresh: (outer.mission?.refresh ?? 0) + 1,
        list,
      };
    });
}

export async function chooseInitialRelic(mgr: RoguelikeV2Manager, args: { select: string }) {
    // 防御：RELIC 事件可能已被消费（客户端重复调用/乱序）——按类型查找而非盲目 shift
    const event = mgr._status.pending.find(
      (e) => e.type === "GAME_INIT_RELIC",
    );
    if (!event) return;
    const relic = event.content.initRelic?.items?.[args.select];
    if (!relic) return;
    // 记录所选分队（结算 brief.band）
    mgr._bandId = relic.id;
    await mgr.inventory!._relic.gain([relic]);
    mgr._status.pending.splice(mgr._status.pending.indexOf(event), 1);
}

export async function chooseInitialRecruitSet(mgr: RoguelikeV2Manager, args: { select: string }) {
    const theme = mgr.current.game!.theme;
    // RECRUIT_SET 可能已被 finishEvent 消费（部分客户端流程）→ 按索引查找移除
    const recSetIdx = mgr._status.pending.findIndex(
      (e) => e.type === "GAME_INIT_RECRUIT_SET",
    );
    if (recSetIdx >= 0) mgr._status.pending.splice(recSetIdx, 1);
    const recruitEvt = mgr._status.pending.find(
      (e) => e.type === "GAME_INIT_RECRUIT",
    );

    // 招募组 → 具体职业券映射（官方 recruitGrps 仅带 desc 文本"XX、YY、ZZ招募券各一张"，
    // 按 desc 中职业顺序映射到标准职业券；group_random 抽 3 张随机标准票）
    // 标准职业列表从 excel recruitTickets 键推导：`_recruit_ticket_<职业>` 后缀，
    // 顺序即 excel 键顺序（实证与职业枚举顺序一致）
    const CLASS_TICKET_RE =
      /_recruit_ticket_(pioneer|warrior|tank|sniper|caster|support|medic|special)$/;
    const recruitTickets =
      excel.RoguelikeTopicTable.details[theme]?.recruitTickets ?? {};
    const PROFESSIONS = Object.keys(recruitTickets)
      .filter((t) => CLASS_TICKET_RE.test(t))
      .map((t) => CLASS_TICKET_RE.exec(t)![1]);
    const roNum = theme.slice(-1);
    // 招募组 → 具体职业券映射（官方 recruitGrps 仅带 desc 文本"XX、YY、ZZ招募券各一张"，
    // 按 desc 中职业顺序映射到标准职业券；组合表在 data/rlv2/recruit-groups.json）
    const GROUP_PROFESSIONS: { [key: string]: string[] } = mgr._data.recruitGroups;
    // 随心所欲：第 1 张 5 星临时招募券（含 5 星）、第 2 张近战四职业（近卫/先锋/重装/特种）、
    // 第 3 张远程四职业（狙击/术师/医疗/辅助）；ticket 存在性由 excel 校验
    const GROUP_TICKETS: { [key: string]: string[] } = {
      recruit_group_random: ["5star", "quad_melee", "quad_ranged"]
        .map((kind) => `${theme}_recruit_ticket_${kind}`)
        .filter((t) => recruitTickets[t]),
    };
    const pool = PROFESSIONS.map((p) => `rogue_${roNum}_recruit_ticket_${p}`).filter(
      (t) => excel.RoguelikeTopicTable.details[theme]?.recruitTickets?.[t],
    );
    let picked: string[];
    const groupTickets = GROUP_TICKETS[args.select] || [];
    if (/^recruit_group_m[12]$/.test(args.select)) {
      // 实践者列表（recruit_group_m1/m2 "支援作战"）：两张随机的招募券
      const shuffled = [...pool].sort(() => random() - 0.5);
      picked = shuffled.slice(0, 2);
    } else if (groupTickets.length > 0) {
      // 随心所欲专用券（5star/quad_melee/quad_ranged）——校验存在，缺失回退随机
      const valid = groupTickets.filter(
        (t) => excel.RoguelikeTopicTable.details[theme]?.recruitTickets?.[t],
      );
      if (valid.length === 3) {
        picked = valid;
      } else {
        const shuffled = [...pool].sort(() => random() - 0.5);
        picked = shuffled.slice(0, 3);
      }
    } else {
      const groupProfs =
        GROUP_PROFESSIONS[args.select] || GROUP_PROFESSIONS["recruit_group_random"];
      if (args.select === "recruit_group_random" || !groupProfs) {
        const shuffled = [...pool].sort(() => random() - 0.5);
        picked = shuffled.slice(0, 3);
      } else {
        // 按组合职业顺序取对应标准券（"先锋、狙击、特种招募券各一张"）
        picked = groupProfs
          .map((p) => `rogue_${roNum}_recruit_ticket_${p}`)
          .filter((t) => pool.includes(t));
        // 保底：组合职业券缺失时用随机补足 3 张
        while (picked.length < 3) {
          const rest = pool.filter((t) => !picked.includes(t));
          if (rest.length === 0) break;
          picked.push(rest[Math.floor(random() * rest.length)]);
        }
      }
    }
    for (const r of picked) {
      await mgr._trigger.emit("rlv2:recruit:gain", [r, "initial", 0]);
    }
    if (recruitEvt) {
      recruitEvt.content.initRecruit!.tickets = Object.values(
        mgr.inventory!.recruit,
      )
        .filter((r) => r.from == "initial")
        .map((r) => r.index);
    }
}

  /** 选择初始探索工具（CS: RoguelikeSelectInitialExploreToolRequest { select }） */
export async function chooseInitialExploreTool(mgr: RoguelikeV2Manager, args: { select: string }) : Promise<void> {
    const event = mgr._status.pending.find(
      (e) => e.type === "GAME_INIT_EXPLORE_TOOL",
    );
    if (!event) return;
    const item = event.content.initExploreTool?.items[args.select];
    if (!item) return;
    mgr._status.pending.splice(
      mgr._status.pending.indexOf(event),
      1,
    );
    await mgr._trigger.emit("rlv2:get:items", [[item]]);
    mgr._status.state = "WAIT_MOVE";
}
