import { now } from "@utils/time";
import { PlayerDataManager } from "../../kernel/player-data-manager";
import { TypedEventEmitter } from "../../kernel/events/runtime";

export class HomeManager {
  _player: PlayerDataManager;
  _trigger: TypedEventEmitter;

  constructor(player: PlayerDataManager, _trigger: TypedEventEmitter) {
    this._player = player;
    this._trigger = _trigger;
    this._trigger.on(
      "background:condition:update",
      async ([bgID, conditionId, target]: [string, string, number]) => {
        await this._player.update(async (draft) => {
          if (draft.background.bgs[bgID]!.conditions!) {
            const cond = draft.background.bgs[bgID]!.conditions![conditionId];
            cond.v = target;
            if (cond.t == cond.v) {
              await this._trigger.emit("background:unlock", [{ bgID }]);
            }
          }
        });
      },
    );
    this._trigger.on(
      "background:unlock",
      async ([args]: [{ bgID: string }]) => {
        const { bgID } = args;
        await this._player.update(async (draft) => {
          draft.background.bgs[bgID].unlock = now();
        });
      },
    );
    this._trigger.on("background:get", async ([id]: [string]) => {
      await this._player.update(async (draft) => {
        draft.background.bgs[id] = {
          unlock: now(),
        };
      });
    });
    this._trigger.on(
      "homeTheme:condition:update",
      async ([args]: [
        { themeId: string; conditionId: string; target: number },
      ]) => {
        const { themeId, conditionId, target } = args;
        await this._player.update(async (draft) => {
          if (draft.homeTheme.themes[themeId]!.conditions!) {
            const cond =
              draft.homeTheme!.themes[themeId]!.conditions![conditionId];
            cond.v = target;
            if (cond.t == cond.v) {
              await this._trigger.emit("homeTheme:unlock", [{ themeId }]);
            }
          }
        });
      },
    );
    this._trigger.on(
      "homeTheme:unlock",
      async ([args]: [{ themeId: string }]) => {
        const { themeId } = args;
        await this._player.update(async (draft) => {
          draft.homeTheme.themes[themeId].unlock = now();
        });
      },
    );
    this._trigger.on("homeTheme:get", async ([id]: [string]) => {
      await this._player.update(async (draft) => {
        draft.homeTheme.themes[id] = {
          unlock: now(),
        };
      });
    });
  }

  async setBackground(args: { bgID: string }) {
    const { bgID } = args;
    await this._player.update(async (draft) => {
      draft.background.selected = bgID;
    });
  }

  async setHomeTheme(args: { themeId: string }) {
    const { themeId } = args;
    await this._player.update(async (draft) => {
      draft.homeTheme.selected = themeId;
    });
  }

  async setLowPower(args: { newValue: number }) {
    const { newValue } = args;
    await this._player.update(async (draft) => {
      draft.setting.perf.lowPower = newValue;
    });
  }

  async npcAudioChangeLan(args: { id: string; voiceLan: string }) {
    const { id, voiceLan } = args;
    await this._player.update(async (draft) => {
      draft.npcAudio[id].npcShowAudioInfoFlag = voiceLan;
    });
  }
}
