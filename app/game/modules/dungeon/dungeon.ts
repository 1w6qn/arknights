import { PlayerDataManager } from "../../kernel/player-data-manager";
import { TypedEventEmitter } from "../../kernel/events/runtime";

export class DungeonManager {
  _player: PlayerDataManager;
  _trigger: TypedEventEmitter;

  constructor(player: PlayerDataManager, _trigger: TypedEventEmitter) {
    this._player = player;
    this._trigger = _trigger;
    this._trigger.on("stage:update", this.update.bind(this));
  }

  async update() {
    await this.initStages();
  }
  async initStages() {
    let changed = false;
    await this._player.update((draft) => {
      for (const stageId in this._player.excel.StageTable.stages) {
        if (!(stageId in draft.dungeon.stages)) {
          draft.dungeon.stages[stageId] = {
            completeTimes: 1,
            hasBattleReplay: 0,
            noCostCnt: 0,
            practiceTimes: 0,
            stageId: stageId,
            startTimes: 1,
            state: 3,
          };
          changed = true;
        }
      }
      return Promise.resolve();
    });
    // 配方内补全产生 Immer 补丁，无需 markDirty；changed 仅用于日志/短路
    return changed;
  }
}
