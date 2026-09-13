/**
 * 存档健康检查与自动修复
 *
 * 自动检测玩家存档（data/user/databases/{uid}.json）的常见损坏并尝试修复：
 * 1. 必填顶层结构缺失（status/troop/dungeon/activity/building）
 * 2. troop.chars 内非法干员（非对象/缺 charId）
 * 3. building.rooms.PRIVATE[].owners 含 null 条目（setPrivateDormOwner 字段名 bug 残留）
 * 4. status.uid 类型错误
 * 5. dexNav.character[].charInstId 与 troop.chars 一致性（roster 重建后悬空重指向）
 * 6. troop.chars 干员模板字段归一化（自引用空 currentTmpl/旧 null 结构 → 移除）
 * 7. troop.chars 技能回填（按等级/精英化解锁——历史新干员建档空 skills）
 * 8. troop.chars 模组回填与精二显示校正（hide=0/locked/currentEquip——历史精二未处理模组）
 * 9. building.rooms.TRAINING[].trainee/trainer 空对象修复（旧结算 trainee=null 残留）
 *
 * 修复为幂等（对合规结构无副作用）且保守（不做破坏性重建）——结构性损坏可安全修复，
 * 非法 JSON 无法自动修复（由加载层记录并备份）。
 */
import { logger } from "@utils/logger";
import type { JsonValue } from "@excel/json-value";
import type {
  PlayerActivity,
  PlayerBuildingTrainee,
  PlayerBuildingTrainer,
  PlayerCharPatch,
  PlayerDungeon,
} from "./playerdata";
import type { CharEquipsLike, CharSkillsLike } from "./char-skills";
import {
  reconcileCharEquips,
  reconcileCharSkills,
  unlockedSkillIds,
} from "./char-skills";

/** 存档问题记录 */
export interface SaveIssue {
  /** 问题路径（如 building.rooms.PRIVATE.slot_47.owners） */
  path: string;
  message: string;
  /** 是否已修复 */
  fixed: boolean;
}

/**
 * status 基础结构（uid 允许数字——修复分支会转字符串）
 */
interface SaveStatusEntry {
  uid?: string | number;
  nickName?: string;
  nickNumber?: string;
  level?: number;
  exp?: number;
}

/**
 * troop.chars 干员条目
 *
 * 与 char-skills 的 {@link CharSkillsLike} / {@link CharEquipsLike} 兼容，
 * 使技能/模组回填可直接原地修改；阿米娅升变模板字段另行声明。
 */
interface SaveCharEntry extends CharSkillsLike, CharEquipsLike {
  /** 升变模板表（仅 char_002_amiya 合法携带；本模块只看有无/键数） */
  tmpl?: Record<string, PlayerCharPatch> | null;
  /** 当前升变形态（无有效模板映射时须移除，否则客户端卡死） */
  currentTmpl?: string | null;
}

/** 私人宿舍（building.rooms.PRIVATE[slotId]） */
interface SavePrivateRoom {
  /** 宿舍干员 instId 列表（历史 bug 会残留 null 条目） */
  owners?: (number | null)[] | null;
}

/** 训练室（building.rooms.TRAINING[slotId]） */
interface SaveTrainingRoom {
  /** 受训干员（旧结算残留 null；修复分支重置为官方空态） */
  trainee?: PlayerBuildingTrainee | null;
  /** 教官（同上） */
  trainer?: PlayerBuildingTrainer | null;
}

/** 干员图鉴条目（dexNav.character[charId]） */
interface SaveDexChar {
  charInstId?: number;
}

/** arkodc 主题（arkodc.topics[topicId]） */
interface SaveArkTopic {
  position?: { x: number; y: number; z: number } | null;
}

/**
 * 存档视图（不可信 JSON 输入）
 *
 * 只声明本模块真正访问/修复的字段：这些类型描述**期望的线格式**，而输入来自
 * 磁盘上的任意 JSON——每个分支仍有 `typeof` / `Array.isArray` / 真值守卫兜底，
 * 与历史 `any` 实现的运行时行为逐分支一致。未列出的字段一律透传保留。
 */
export interface SaveDataShape {
  status?: SaveStatusEntry;
  troop?: { chars?: Record<string, SaveCharEntry | null | undefined> };
  /**
   * 关卡进度（本模块只做存在性检查/重建，不读字段）
   *
   * 联合生成模型（真实存档，接口无索引签名故不能直接收窄为 JsonValue 字典）
   * 与通用 JSON 袋（测试夹具/未建模结构）。
   */
  dungeon?: PlayerDungeon | Record<string, JsonValue>;
  /** 活动状态（同上，仅存在性检查/重建） */
  activity?: PlayerActivity | Record<string, JsonValue>;
  building?: {
    rooms?: {
      PRIVATE?: Record<string, SavePrivateRoom | null | undefined>;
      TRAINING?: Record<string, SaveTrainingRoom | null | undefined>;
    };
  };
  dexNav?: { character?: Record<string, SaveDexChar | null | undefined> };
  arkodc?: { topics?: Record<string, SaveArkTopic | null | undefined> };
}

/** 必填顶层结构（缺失时重建空对象） */
const REQUIRED_TOP_LEVEL = ["status", "troop", "dungeon", "activity", "building"] as const;

/**
 * 校验并修复玩家存档（幂等）
 * @param data - 从文件读取的存档对象（原地修改）
 * @returns 发现的问题列表（含是否已修复）
 */
export function checkAndRepairSave(data: SaveDataShape): SaveIssue[] {
  const issues: SaveIssue[] = [];
  if (!data || typeof data !== "object") {
    issues.push({ path: "(root)", message: "存档根节点非对象，无法自动修复", fixed: false });
    return issues;
  }

  // 1. status 基础结构（缺失时重建）
  let status = data.status;
  if (!status || typeof status !== "object") {
    status = {
      uid: String(data.status?.uid ?? "1"),
      nickName: "博士",
      nickNumber: "1",
      level: 1,
      exp: 0,
    };
    data.status = status;
    issues.push({ path: "status", message: "status 缺失/非对象，重建基础结构", fixed: true });
  }

  // 2. 必填顶层结构
  for (const key of REQUIRED_TOP_LEVEL) {
    if (!data[key] || typeof data[key] !== "object") {
      data[key] = {};
      issues.push({ path: key, message: `${key} 缺失/非对象，重置为空结构`, fixed: true });
    }
  }

  // 3. troop.chars：过滤非法干员
  const chars = data.troop?.chars;
  if (chars && typeof chars === "object") {
    for (const [instId, c] of Object.entries(chars)) {
      if (!c || typeof c !== "object" || !c.charId) {
        delete chars[instId];
        issues.push({ path: `troop.chars[${instId}]`, message: "非法干员（非对象/缺 charId），移除", fixed: true });
      }
    }
  }

  // 4. building.rooms.PRIVATE[].owners 含 null 条目（setPrivateDormOwner 字段名 bug 残留）
  const privateRooms = data.building?.rooms?.PRIVATE;
  if (privateRooms && typeof privateRooms === "object") {
    for (const [slotId, room] of Object.entries(privateRooms)) {
      const owners = room?.owners;
      if (room && Array.isArray(owners) && owners.some((o) => o == null)) {
        room.owners = owners.filter((o) => o != null);
        issues.push({
          path: `building.rooms.PRIVATE[${slotId}].owners`,
          message: "含 null 条目（损坏残留），已过滤",
          fixed: true,
        });
      }
    }
  }

  // 5. status.uid 类型
  if (typeof status.uid !== "string") {
    status.uid = String(status.uid ?? "1");
    issues.push({ path: "status.uid", message: "uid 非字符串，转字符串", fixed: true });
  }

  // 6. dexNav.character[charId].charInstId 与 troop.chars 一致性。
  //    干员发放/满配重建 roster（instId 按 charId 编号）后，旧 dexNav 的 charInstId
  //    悬空或错指其他干员 → 客户端按 charInstId 查 troop.chars 失败 → 抽卡/招募结果
  //    "获取干员信息" 报错。修复：按 charId 在 roster 找回正确 instId 重指向；
  //    charId 不在 roster（孤儿条目）则移除，使下次获得时按新干员正确建档。
  const dexChars = data.dexNav?.character;
  const troopChars = data.troop?.chars;
  if (dexChars && troopChars) {
    for (const [charId, entry] of Object.entries(dexChars)) {
      const e = entry;
      if (!e || typeof e !== "object") continue;
      const cur = e.charInstId != null ? troopChars[e.charInstId] : undefined;
      if (cur && cur.charId === charId) continue; // 指向正确
      const found = Object.entries(troopChars).find(
        ([, c]) => c && c.charId === charId,
      );
      if (found) {
        const old = e.charInstId;
        e.charInstId = Number(found[0]);
        issues.push({
          path: `dexNav.character[${charId}].charInstId`,
          message: `悬空/错指（原 ${old ?? "无"}，roster[${old ?? "?"}]${cur ? ` 实为 ${cur.charId}` : " 不存在"}），重指向 ${found[0]}`,
          fixed: true,
        });
      } else {
        delete dexChars[charId];
        issues.push({
          path: `dexNav.character[${charId}]`,
          message: "干员不在 troop.chars（孤儿条目），移除",
          fixed: true,
        });
      }
    }
  }

  // 7. troop.chars 干员模板字段（currentTmpl/tmpl）归一化。
  //    官方参考（test.json 379 干员仅 char_002_amiya 带 currentTmpl/tmpl，且
  //    currentTmpl 指向 tmpl 内异格形态）——普通干员不应有模板字段。历史 onCharGet
  //    发放 `currentTmpl:charId + tmpl:{}` 自引用空模板（客户端干员详情按 currentTmpl
  //    查 tmpl 得 undefined → 结构破坏/卡死）；旧生成器 currentTmpl:null 同样卡死。
  //    修复：currentTmpl 无有效模板映射即移除；阿米娅合法多形态模板保留。
  if (chars && typeof chars === "object") {
    for (const [instId, ch] of Object.entries(chars)) {
      const c = ch;
      if (!c || typeof c !== "object") continue;
      const tmpl = c.tmpl;
      const hasFilledTmpl =
        tmpl && typeof tmpl === "object" && Object.keys(tmpl).length > 0;
      const cur = c.currentTmpl; // undefined / null / string
      if (cur !== undefined && cur !== null && !hasFilledTmpl) {
        delete c.currentTmpl;
        delete c.tmpl;
        issues.push({
          path: `troop.chars[${instId}]`,
          message: "currentTmpl 无有效模板映射（自引用空模板/旧结构），移除模板字段",
          fixed: true,
        });
      } else if (cur === null) {
        // 旧生成器 currentTmpl:null → 客户端干员列表卡死根因；移除（tmpl 若有填充保留）
        delete c.currentTmpl;
        if (!hasFilledTmpl) delete c.tmpl;
        issues.push({
          path: `troop.chars[${instId}]`,
          message: "currentTmpl 为 null（旧生成器结构），移除模板字段",
          fixed: true,
        });
      } else if (cur !== undefined && hasFilledTmpl && !tmpl?.[cur]) {
        delete c.currentTmpl;
        issues.push({
          path: `troop.chars[${instId}]`,
          message: "currentTmpl 指向 tmpl 中不存在的形态，移除 currentTmpl",
          fixed: true,
        });
      }
    }
  }

  // 8. troop.chars 技能回填：完全采用官服线格式。
  //    历史 onCharGet 建档 skills 恒为空 → 客户端干员详情无技能可看（新干员/发放）。
  //    按 excel skills[i].unlockCond.phase 补齐全部技能并校正 unlock（1=已解锁，
  //    0=未解锁锁定占位）；阿米娅（技能在 tmpl）/无技能干员自动跳过。官方线格式的
  //    unlock:0 锁定占位（未精一/未精二时仍列出的未来技能）会保留，不会被当作旧规则
  //    多发放移除。
  if (chars && typeof chars === "object") {
    for (const [instId, ch] of Object.entries(chars)) {
      const c = ch;
      if (!c || typeof c !== "object" || !c.charId) continue;
      if (reconcileCharSkills(c)) {
        const unlocked = unlockedSkillIds(
          c.charId,
          c.evolvePhase,
          c.level,
        );
        issues.push({
          path: `troop.chars[${instId}].skills`,
          message: `技能按官服线格式整理（解锁 ${unlocked.join(",") || "(无)"}）`,
          fixed: true,
        });
      }
    }
  }

  // 9. troop.chars 模组（uniequip）自动校正：精二干员的模组条目应显示（hide=0）。
  //    历史精二流程未处理模组 → 已解锁（locked=0）但 hide=1（隐藏）或 equip 空/缺条目、
  //    currentEquip 悬空。reconcileCharEquips 幂等补齐缺失条目、按 showEvolvePhase 校正
  //    hide（精二→0）、精二即用模组置 locked=0、修正 currentEquip。阿米娅/无模组干员跳过。
  if (chars && typeof chars === "object") {
    for (const [instId, ch] of Object.entries(chars)) {
      const c = ch;
      if (!c || typeof c !== "object" || !c.charId) continue;
      if (reconcileCharEquips(c)) {
        const hiddenUnlocked = Object.entries(c.equip ?? {}).filter(
          ([, v]) => v && v.locked === 0 && v.hide === 1,
        );
        issues.push({
          path: `troop.chars[${instId}].equip`,
          message:
            hiddenUnlocked.length > 0
              ? `精二模组隐藏→显示（${hiddenUnlocked.map(([id]) => id).join(",")}）`
              : "模组条目按官服线补齐/校正（hide/locked/currentEquip）",
          fixed: true,
        });
      }
    }
  }

  // 10. building.rooms.TRAINING[].trainee/trainer 必须为对象（官方线格式恒为对象——
  //    旧实现结算后 trainee=null → 客户端读 trainee.charInstId 崩溃 → 存档破坏）。
  //    修复为官方空态（4.json 官服快照）：trainee {charInstId:-1,state:0,targetSkill:-1,
  //    processPoint:-1,speed:1}、trainer {charInstId:-1,state:0}。
  const trainingRooms = data.building?.rooms?.TRAINING;
  if (trainingRooms && typeof trainingRooms === "object") {
    for (const [slotId, room] of Object.entries(trainingRooms)) {
      const r = room;
      if (!r || typeof r !== "object") continue;
      const EMPTY_TRAINEE = {
        charInstId: -1,
        state: 0,
        targetSkill: -1,
        processPoint: -1,
        speed: 1,
      };
      if (r.trainee == null || typeof r.trainee !== "object") {
        r.trainee = { ...EMPTY_TRAINEE };
        issues.push({
          path: `building.rooms.TRAINING[${slotId}].trainee`,
          message: "trainee 为 null/非法（旧结算残留），重置为空对象",
          fixed: true,
        });
      }
      if (r.trainer == null || typeof r.trainer !== "object") {
        r.trainer = { charInstId: -1, state: 0 };
        issues.push({
          path: `building.rooms.TRAINING[${slotId}].trainer`,
          message: "trainer 为 null/非法，重置为空对象",
          fixed: true,
        });
      }
    }
  }

  // 9. arkodc 主题残留清理：
  //    - topics["undefined"]（旧版 /arkodc/restart|savePosition 缺失 topicId 时写入的
  //      JSON 键 "undefined" 脏数据，新账号从模板继承）
  //    - position 为 null 的主题（restart 置空残留；客户端期望 {x,y,z}）
  const arkTopics = data.arkodc?.topics;
  if (arkTopics && typeof arkTopics === "object") {
    for (const [tid, t] of Object.entries(arkTopics)) {
      if (tid === "undefined" || tid.length === 0) {
        delete arkTopics[tid];
        issues.push({
          path: `arkodc.topics[${tid}]`,
          message: "非法主题键（undefined/空串），移除",
          fixed: true,
        });
        continue;
      }
      const topic = t;
      if (topic && topic.position == null) {
        topic.position = { x: 0, y: 0, z: 0 };
        issues.push({
          path: `arkodc.topics[${tid}].position`,
          message: "position 为 null（restart 残留），重置为原点",
          fixed: true,
        });
      }
    }
  }

  return issues;
}

/**
 * 校验存档并输出健康报告（不修改数据）
 * @param data - 存档对象（深拷贝后修复，原件不受影响）
 * @returns 是否存在可修复的问题
 */
export function hasRepairableIssues(data: SaveDataShape): boolean {
  return checkAndRepairSave(structuredClone ? structuredClone(data) : JSON.parse(JSON.stringify(data))).some(
    (i) => i.fixed,
  );
}

/**
 * 记录修复结果（供加载/保存层调用）
 */
export function logSaveRepair(uid: string, issues: SaveIssue[]): void {
  for (const issue of issues) {
    if (issue.fixed) {
      logger.warn("save-health", `存档 ${uid} ${issue.path}: ${issue.message}`);
    } else {
      logger.error("save-health", `存档 ${uid} ${issue.path}: ${issue.message}`);
    }
  }
}
