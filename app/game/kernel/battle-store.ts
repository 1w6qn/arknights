/**
 * 战斗数据存储（B-1 拆分）
 *
 * 封装回放（replays 表）与结算信息（battle_infos / battle_records 表）的读写——
 * 大对象独立于用户配置存储，避免每次保存配置时全量重写（R4 + A3）。
 * 由 AccountManager 持有并委托（门面保留原公共方法签名）。
 *
 * 方法均为异步：主数据层支持 MySQL / PostgreSQL 后端，仓储 API 统一异步。
 */
import type { BattleInfo, BattleRecord } from "./battle-info-store";
import type { ReplayRepository } from "@core/db/replay-repo";

export class BattleStore {
  /** @param _replayRepo - 战斗数据仓储（未注入时全部方法为 no-op） */
  constructor(private _replayRepo?: ReplayRepository) {}

  /**
   * 获取战斗回放（无则返回空串）
   * @param uid - 账号 uid
   * @param stageId - 关卡 id
   */
  async getReplay(uid: string, stageId: string): Promise<string> {
    return (await this._replayRepo?.get(uid, stageId)) ?? "";
  }

  /**
   * 保存战斗回放
   * @param uid - 账号 uid
   * @param stageId - 关卡 id
   * @param replay - 回放数据
   */
  async saveReplay(uid: string, stageId: string, replay: string): Promise<void> {
    await this._replayRepo?.upsert(uid, stageId, replay);
  }

  /**
   * 获取战斗结算信息（无则 undefined）
   * @param uid - 账号 uid
   * @param battleId - 战斗 id
   */
  async getInfo(uid: string, battleId: string): Promise<BattleInfo | undefined> {
    return await this._replayRepo?.getInfo(uid, battleId);
  }

  /**
   * 保存战斗结算信息
   * @param uid - 账号 uid
   * @param battleId - 战斗 id
   * @param info - 结算信息
   */
  async saveInfo(uid: string, battleId: string, info: BattleInfo): Promise<void> {
    await this._replayRepo?.upsertInfo(uid, battleId, info);
  }

  /**
   * 留存战斗结束记录
   * @param record - 战斗结束记录
   */
  async saveRecord(record: BattleRecord): Promise<void> {
    await this._replayRepo?.saveRecord(record);
  }

  /**
   * 读取战斗结束记录（无则 undefined）
   * @param uid - 账号 uid
   * @param battleId - 战斗 id
   */
  async getRecord(uid: string, battleId: string): Promise<BattleRecord | undefined> {
    return await this._replayRepo?.getRecord(uid, battleId);
  }

  /**
   * 读取最近 N 条战斗结束记录
   * @param uid - 账号 uid
   * @param limit - 最大条数
   */
  async listRecords(uid: string, limit = 50): Promise<BattleRecord[]> {
    return (await this._replayRepo?.listRecords(uid, limit)) ?? [];
  }
}
