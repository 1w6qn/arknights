/**
 * 奇象巡展（ARK_HUB）宠物继承：从官服网关抓包户籍还原生物图鉴/扫描仪个体
 *
 * 背景（2026-08-27 取证实锤）：官服 playerdata（syncData）**不含**枢纽宠物——
 * `activity.ARK_HUB.act1arkhub` 仅有 coin/secretary/squads/globalBan（官服完成态快照
 * 对照 design-spec §26.1）。宠物（图鉴收录/扫描仪个体）只存在于官服网关侧户籍：
 * EnterSceneNotify（0x38b37d3d）的 PlayerSyncData.f5 CreatureData（creatures/collections）
 * 与 f6 ArkhubItemData（coin/道具箱）。因此「从旧存档（官服账号）导入」时宠物只能
 * 从该账号的官服网关抓包还原——本模块负责提取 + 映射为私服扩展形状并合并进存档。
 *
 * 抓包来源：统一抓包存储（tmp/capture/，gateway-bidi 记录，up.bin 登录帧 f1 = 官服 uid）。
 */
import fs from "node:fs";
import path from "node:path";
import { captureManager } from "@capture/capture-manager";
import {
  parseGatewayStream,
  arkdexIsAlter,
  arkdexAlterBase,
  arkdexActiveMap,
  ARKHUB_ACT_ID,
  type GatewayFrame,
  type PbField,
} from "@game/modules/activities/arkhub/public";
import type { PlayerDataManager } from "@game/kernel/PlayerDataManager";
import { logger } from "@utils/logger";

/** 从官服户籍提取的枢纽数据（私服扩展形状） */
export interface ArkhubImportedDocs {
  /** 生物图鉴：{ [numId]: { numId, isAlter, alterOf? } } */
  dex: Record<string, { numId: number; isAlter: boolean; alterOf?: number }>;
  /** 扫描仪个体：[{ id, numId, isAlter, alterOf?, persona? }] */
  scanBag: Array<{ id: number; numId: number; isAlter: boolean; alterOf?: number; persona?: number }>;
  /** 道具箱：{ [numId]: { count, uses } }（uses=count：继承的道具按满生效次数） */
  props: Record<string, { count: number; uses: number }>;
  /** 奇象兑换券 */
  coin: number;
}

/** EnterSceneNotify low32（场景数据帧，官服户籍载体） */
const LOW_SCENE_NOTIFY = "38b37d3d";
/** 登录帧 low32（up 流，f1 = 官服 uid） */
const LOW_LOGIN_REQ = "00000fa1";

/** 取字段的嵌套子字段列表 */
function nested(f: PbField | undefined): PbField[] {
  return f?.nested ?? [];
}

/**
 * 从官服场景帧（EnterSceneNotify）提取枢纽户籍（PlayerSyncData.f5/f6）
 * - f5 CreatureData：f1 creatures[] {1:unique_id, 2:template_id, 3:persona, 5:gain_ts}；
 *   f2 collections[] {1:template_id, 3:caught_count}
 * - f6 ArkhubItemData：f1 coin，f2 items[] {1:item_id, 2:count}
 */
export function extractArkhubDocsFromSceneFrame(frame: GatewayFrame): ArkhubImportedDocs | null {
  const sync = frame.fields.find((f) => f.field === 2);
  const creatureData = nested(sync).find((f) => f.field === 5);
  if (!creatureData) return null;
  const dex: ArkhubImportedDocs["dex"] = {};
  const scanBag: ArkhubImportedDocs["scanBag"] = [];
  const addDex = (numId: number) => {
    if (!numId || dex[String(numId)]) return;
    const isAlter = arkdexIsAlter(numId);
    const alterOf = arkdexAlterBase(numId);
    dex[String(numId)] = { numId, isAlter, ...(alterOf ? { alterOf } : {}) };
  };
  // f1 creatures[] → scanBag 个体 + 图鉴
  for (const c of nested(creatureData).filter((f) => f.field === 1)) {
    const kids = nested(c);
    const id = Number(kids.find((k) => k.field === 1)?.varint ?? 0);
    const numId = Number(kids.find((k) => k.field === 2)?.varint ?? 0);
    const persona = Number(kids.find((k) => k.field === 3)?.varint ?? 0);
    if (!id || !numId) continue;
    addDex(numId);
    const isAlter = arkdexIsAlter(numId);
    const alterOf = arkdexAlterBase(numId);
    scanBag.push({
      id,
      numId,
      isAlter,
      ...(alterOf ? { alterOf } : {}),
      ...(persona ? { persona } : {}),
    });
  }
  // f2 collections[] → 图鉴（含未在个体列表中的收录种类）
  for (const col of nested(creatureData).filter((f) => f.field === 2)) {
    const numId = Number(nested(col).find((k) => k.field === 1)?.varint ?? 0);
    if (numId) addDex(numId);
  }
  // f6 ArkhubItemData → coin / 道具箱
  const itemData = nested(sync).find((f) => f.field === 6);
  let coin = 0;
  const props: ArkhubImportedDocs["props"] = {};
  if (itemData) {
    coin = Number(nested(itemData).find((f) => f.field === 1)?.varint ?? 0);
    for (const it of nested(itemData).filter((f) => f.field === 2)) {
      const kids = nested(it);
      const itemId = Number(kids.find((k) => k.field === 1)?.varint ?? 0);
      const count = Number(kids.find((k) => k.field === 2)?.varint ?? 0);
      if (itemId && count > 0) props[String(itemId)] = { count, uses: count };
    }
  }
  if (Object.keys(dex).length === 0 && scanBag.length === 0) return null;
  return { dex, scanBag, props, coin };
}

/**
 * 从一个官服网关抓包记录提取户籍（取 down 流最后一份含 CreatureData 的场景帧——数据最全）
 * @returns 提取的户籍数据（无户籍返回 null）
 */
export function extractArkhubDocsFromRecord(recordDir: string): ArkhubImportedDocs | null {
  const downPath = path.join(recordDir, "down.bin");
  if (!fs.existsSync(downPath)) return null;
  const down = parseGatewayStream(fs.readFileSync(downPath), "down").frames;
  let best: ArkhubImportedDocs | null = null;
  for (const f of down) {
    if (f.headerHex.slice(-8) !== LOW_SCENE_NOTIFY) continue;
    const docs = extractArkhubDocsFromSceneFrame(f);
    if (docs && (!best || docs.scanBag.length > best.scanBag.length)) best = docs;
  }
  return best;
}

/** 读网关记录 up 流登录帧的官服 uid（无登录帧返回 ""） */
export function readCaptureLoginUid(recordDir: string): string {
  const upPath = path.join(recordDir, "up.bin");
  if (!fs.existsSync(upPath)) return "";
  const up = parseGatewayStream(fs.readFileSync(upPath), "up").frames;
  const login = up.find((f) => f.headerHex.slice(-8) === LOW_LOGIN_REQ);
  const uidField = login?.fields.find((f) => f.field === 1);
  return uidField?.str ?? "";
}

/**
 * 按官服 uid 查找对应的网关抓包记录（up 流登录帧 f1 匹配；取最新一条）
 * @returns 记录目录（未找到返回 ""）
 */
export async function findCaptureDirByOfficialUid(officialUid: string): Promise<string> {
  if (!officialUid) return "";
  await captureManager.ensureInit();
  const { items } = await captureManager.query({ direction: "gateway-bidi", limit: 200 });
  // items 按时间倒序——优先最新抓包（户籍数据最全）
  for (const rec of items) {
    const dir = path.join(captureManager.recordsDir(), rec.rid);
    try {
      if (readCaptureLoginUid(dir) === officialUid) return dir;
    } catch (e) {
      logger.debug("arkhub-pets", `抓包记录 ${rec.rid} 登录帧解析失败: ${(e as Error).message}`);
    }
  }
  return "";
}

/**
 * 把官服户籍合并进玩家存档（幂等：按 id/numId 合并去重，券/道具取较大值）
 * @returns 合并结果统计（新收录种类/个体数）
 */
export async function applyArkhubDocs(
  player: PlayerDataManager,
  docs: ArkhubImportedDocs,
): Promise<{ dexAdded: number; bagAdded: number }> {
  let dexAdded = 0;
  let bagAdded = 0;
  await player.update(async (draft) => {
    const hub = draft.activity.ARK_HUB?.[ARKHUB_ACT_ID];
    if (!hub) return;
    // 图鉴合并
    hub.dex = hub.dex ?? {};
    for (const [key, entry] of Object.entries(docs.dex)) {
      if (!hub.dex[key]) {
        hub.dex[key] = entry;
        dexAdded += 1;
      }
    }
    // 扫描仪个体合并（按 unique_id 去重；上限 400 截断）
    hub.scanBag = hub.scanBag ?? [];
    const known = new Set((hub.scanBag as Array<{ id: number }>).map((b) => b.id));
    for (const b of docs.scanBag) {
      if (known.has(b.id)) continue;
      hub.scanBag.push({ ...b, sourceUid: "official" });
      bagAdded += 1;
    }
    if (hub.scanBag.length > 400) hub.scanBag = hub.scanBag.slice(-400);
    // 道具箱合并（数量取较大值——不覆盖本地已购更多）
    hub.props = hub.props ?? {};
    for (const [key, p] of Object.entries(docs.props)) {
      const cur = hub.props[key];
      if (!cur || (cur.count ?? 0) < p.count) hub.props[key] = { ...p };
    }
    // 券取较大值（继承官服进度，不减少本地已有）
    hub.coin = Math.max(hub.coin ?? 0, docs.coin);
    // 计数刷新（任务 9-14 / 勋章 02/025 数据源）
    const dexIds: number[] = Object.values(hub.dex).map((d) => Number(d.numId));
    hub.creatureCollected = dexIds.length;
    hub.alterCollected = Object.values(hub.dex).filter((d) => d.isAlter).length;
    hub.activeCreatureCollected = Object.keys(arkdexActiveMap(dexIds)).length;
  });
  return { dexAdded, bagAdded };
}
