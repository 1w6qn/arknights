import { PlayerDataManager } from "../../kernel/player-data-manager";
import { TypedEventEmitter } from "../../kernel/events/runtime";

export class DexNavManager {
  _player: PlayerDataManager;
  _trigger: TypedEventEmitter;

  constructor(player: PlayerDataManager, _trigger: TypedEventEmitter) {
    this._player = player;
    this._trigger = _trigger;
  }

  get teamV2Info(): { [key: string]: number } {
    // 防御：全新号 dexNav 可能为空对象（无 teamV2 子树）
    return Object.entries(this._player._playerdata.dexNav.teamV2 ?? {}).reduce(
      (acc, [k, v]) => ({ ...acc, [k]: Object.keys(v).length }),
      {},
    );
  }
}
