import { PlayerDataManager } from "../../kernel/player-data-manager";
import { TypedEventEmitter } from "../../kernel/events/runtime";
import { PlayerCharRotationSlot } from "../../kernel/playerdata";
import { original } from "mutative";

export class CharRotationManager {
  _player: PlayerDataManager;
  _trigger: TypedEventEmitter;

  constructor(player: PlayerDataManager, _trigger: TypedEventEmitter) {
    this._player = player;
    this._trigger = _trigger;
  }

  async setCurrent(args: { instId: string }) {
    await this._player.update(async (draft) => {
      const { instId } = args;
      const preset = draft.charRotation.preset[instId];
      // 防御：未知预设直接返回（不 500）
      if (!preset) return;
      draft.charRotation.current = instId;
      draft.background.selected = preset.background;
      draft.homeTheme.selected = preset.homeTheme;
      draft.status.secretarySkinId = preset.profile;
      // 修复：profileInst 可能指向重编号后不存在的干员（满配号生成器重排 charInstId），
      // 查不到时回退到 profile 字符串（"char_xxx#皮肤" → 取 # 前 charId）
      const profileChar = draft.troop.chars[preset.profileInst];
      if (profileChar?.charId) {
        draft.status.secretary = profileChar.charId;
      } else if (preset.profile) {
        draft.status.secretary = String(preset.profile).split("#")[0];
      }
    });
  }

  async createPreset() {
    return await this._player.update(async (draft) => {
      // 修复：原实现 maxBy(Object.keys(...)) 对数字字符串键做字典序比较
      //（"9" > "10"）→ 每次创建都覆盖最高档预设、预设永远建不上去；
      // 改为取最大数值 id + 1 分配新 id
      const maxId = Object.keys(draft.charRotation.preset).reduce(
        (max, k) => Math.max(max, parseInt(k, 10) || 0),
        0,
      );
      const instId = String(maxId + 1);
      draft.charRotation.preset[instId] = {
        name: "未命名界面配置",
        background: "bg_rhodes_day",
        homeTheme: "tm_rhodes_day",
        profile: "char_002_amiya#1",
        profileInst: 1,
        profileSp: false,
        slots: [
          {
            charId: "char_002_amiya",
            skinId: "char_002_amiya#1",
            skinSp: false,
          },
        ],
      };
      return instId;
    });
  }

  async updatePreset(args: CharRotationUpdatePresetRequest) {
    await this._player.update(async (draft) => {
      const { instId, data } = args;
      if (data?.name) {
        draft.charRotation.preset[instId].name = data.name;
      }
      if (data?.background) {
        draft.charRotation.preset[instId].background = data.background;
        draft.background.selected = data.background;
      }
      if (data?.homeTheme) {
        draft.charRotation.preset[instId].homeTheme = data.homeTheme;
        draft.homeTheme.selected = data.homeTheme;
      }
      if (data?.secretarySkinId) {
        draft.charRotation.preset[instId].profile = data.secretarySkinId;
        draft.status.secretarySkinId = data.secretarySkinId;
      }
      if (data?.secretaryCharInstId) {
        // 防御：干员不存在（已删/损坏存档/乱传）时不 500
        const char = draft.troop.chars[data.secretaryCharInstId];
        if (char?.charId) {
          draft.charRotation.preset[instId].profileInst = parseInt(
            data.secretaryCharInstId,
          );
          draft.status.secretary = char.charId;
        }
      }
      if (data?.slots) {
        draft.charRotation.preset[instId].slots = data.slots;
      }
    });
  }

  async deletePreset(args: { instId: string }) {
    await this._player.update(async (draft) => {
      const { instId } = args;
      delete draft.charRotation.preset[instId];
    });
  }
}

export interface CharRotationUpdatePresetRequest {
  instId: string;
  flag: number;
  data: {
    name?: string;
    background?: string;
    homeTheme?: string;
    secretarySkinId?: string;
    secretaryCharInstId?: string;
    slots?: PlayerCharRotationSlot[];
  };
}
