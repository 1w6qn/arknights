import {
  PlayerRoguelikeNode,
  PlayerRoguelikeV2Dungeon,
  PlayerRoguelikeV2Zone,
  RoguelikeBuff,
  TorappuRoguelikeEventType,
} from "./rlv2";
import { RoguelikeV2Manager } from "./logic";
import { TypedEventEmitter } from "../../kernel/events/runtime";
import excel from "@excel/excel";
import * as crypto from "crypto";
import { readFileSync } from "fs";
import { random } from "@utils/random";

/**
 * data/rlv2/nodesInfo.json 视图（官方 stages 提取：主题 → 区域 → 阶段列表）
 */
interface RoguelikeNodesInfo {
  themes?: {
    [theme: string]: {
      zones?: {
        [zone: string]: {
          Normal?: string[];
          Emergency?: string[];
          Boss?: string[];
        };
      };
    };
  };
}

export class RoguelikeMapManager implements PlayerRoguelikeV2Dungeon {
  zones: { [key: string]: PlayerRoguelikeV2Zone };
  _player: RoguelikeV2Manager;
  _trigger: TypedEventEmitter;
  _nodesInfo: RoguelikeNodesInfo | null;

  constructor(player: RoguelikeV2Manager, _trigger: TypedEventEmitter) {
    this.zones = {};
    this._player = player;
    this._trigger = _trigger;
    this._trigger.on("rlv2:init", this.init.bind(this));
    this._trigger.on("rlv2:continue", this.continue.bind(this));
    this._trigger.on("rlv2:create", this.create.bind(this));
    this._trigger.on("rlv2:zone:new", this.generate.bind(this));
    try {
      this._nodesInfo = JSON.parse(
        readFileSync(`${__dirname}/../../../../data/rlv2/nodesInfo.json`, "utf-8"),
      );
    } catch {
      this._nodesInfo = null;
    }
  }

  init() {
    this.zones = {};
  }

  /** 重登"继续探索"：从存档 current.map.zones 恢复地图 */
  continue() {
    this.zones = this._player.current.map?.zones || {};
  }

  create() {
    this.zones = {};
  }

  randByKey(seed: string, ...keys: string[]): number {
    const hash = crypto.createHash("md5").update(`${seed}_${keys.join("_")}`).digest("hex");
    return parseInt(hash, 16);
  }

  weightedRandom(weights: { type: number; weight: number }[]): number {
    const totalWeight = weights.reduce((acc, w) => acc + w.weight, 0);
    let randSeed = this.randByKey("map_rand", random().toString(36).substring(7));
    let randomValue = randSeed % totalWeight;
    
    for (const item of weights) {
      if (randomValue < item.weight) {
        return item.type;
      }
      randomValue -= item.weight;
    }
    return weights[weights.length - 1].type;
  }

  generate([id]: [number]) {
    this._player._buff.filterBuffs("zone_into_reward").forEach((b) => {
      // 区域限定：blackboard[2].value（数字，旧格式）或 .valueStr（官方 "zone_N"）；缺失=全区
      const zoneCond = b.blackboard[2]?.value;
      const zoneStr = b.blackboard[2]?.valueStr;
      const matches =
        zoneStr !== undefined
          ? zoneStr === `zone_${id}` || zoneStr === String(id)
          : zoneCond === undefined || zoneCond == id;
      if (matches) {
        this._trigger.emit("rlv2:get:items", [
          [
            {
              id: b.blackboard[0].valueStr!,
              count: b.blackboard[1].value!,
            },
          ],
        ]);
      }
    });
    this._player._buff.filterBuffs("zone_into_cost").forEach((b) => {
      const zoneCond = b.blackboard[2]?.value;
      const zoneStr = b.blackboard[2]?.valueStr;
      const matches =
        zoneStr !== undefined
          ? zoneStr === `zone_${id}` || zoneStr === String(id)
          : zoneCond === undefined || zoneCond == id;
      if (matches) {
        this._trigger.emit("rlv2:get:items", [
          [
            {
              id: b.blackboard[0].valueStr!,
              count: -b.blackboard[1].value!,
            },
          ],
        ]);
      }
    });
    this._player._buff.filterBuffs("zone_into_buff").forEach((b) => {
      const buff: RoguelikeBuff = {
        key: b.blackboard[0].valueStr!,
        blackboard: b.blackboard.slice(1),
      };
      this._player._buff.applyBuffs([[buff]]);
    });

    const theme = this._player.current.game!.theme;
    // rogue_6 无相地图：地图由 GRID_ZONE 模块按官方构造模板生成（syncMapZones 写入本管理器），
    // 此处跳过标准网格生成，避免覆盖（rlv2:zone:new 两个监听器先后触发）。
    if (theme === "rogue_6") return;
    const roNum = parseInt(theme.split("_")[1]);
    const zone = id;

    const shopType = theme !== "rogue_1" ? 4096 : 8;
    const wishType = theme !== "rogue_1" ? 512 : 64;

    const typeWeights: { type: number; weight: number }[] = [
      { type: TorappuRoguelikeEventType.BATTLE_NORMAL, weight: 60 },
      { type: TorappuRoguelikeEventType.BATTLE_ELITE, weight: 15 },
      { type: TorappuRoguelikeEventType.INCIDENT, weight: 20 },
      { type: wishType, weight: 20 },
    ];

    if (zone > 1) {
      typeWeights.push({ type: TorappuRoguelikeEventType.REST, weight: 20 });
      switch (roNum) {
        case 1:
          typeWeights.push(
            { type: TorappuRoguelikeEventType.BATTLE_BOSS, weight: 10 },
            { type: shopType, weight: 10 },
            { type: TorappuRoguelikeEventType.TREASURE, weight: 10 },
            { type: TorappuRoguelikeEventType.ENTERTAINMENT, weight: 10 },
            { type: TorappuRoguelikeEventType.UNKNOWN, weight: 10 },
          );
          break;
        case 2:
          typeWeights.push(
            { type: TorappuRoguelikeEventType.BATTLE_BOSS, weight: 10 },
            { type: TorappuRoguelikeEventType.SACRIFICE, weight: 10 },
            { type: TorappuRoguelikeEventType.EXPEDITION, weight: 10 },
            { type: 4096, weight: 10 },
            { type: TorappuRoguelikeEventType.PORTAL, weight: 10 },
            { type: TorappuRoguelikeEventType.MISSION, weight: 10 },
          );
          break;
        case 3:
          typeWeights.push(
            { type: TorappuRoguelikeEventType.BATTLE_BOSS, weight: 10 },
            { type: TorappuRoguelikeEventType.SACRIFICE, weight: 10 },
            { type: TorappuRoguelikeEventType.EXPEDITION, weight: 10 },
            { type: 4096, weight: 10 },
            { type: TorappuRoguelikeEventType.PORTAL, weight: 10 },
            { type: TorappuRoguelikeEventType.STORY_HIDDEN, weight: 10 },
          );
          break;
        case 4:
          typeWeights.push(
            { type: TorappuRoguelikeEventType.BATTLE_BOSS, weight: 10 },
            { type: TorappuRoguelikeEventType.ENTERTAINMENT, weight: 10 },
            { type: TorappuRoguelikeEventType.UNKNOWN, weight: 10 },
            { type: TorappuRoguelikeEventType.SACRIFICE, weight: 10 },
            { type: TorappuRoguelikeEventType.EXPEDITION, weight: 10 },
            { type: 4096, weight: 10 },
            { type: TorappuRoguelikeEventType.PORTAL, weight: 10 },
            { type: TorappuRoguelikeEventType.ALCHEMY, weight: 10 },
            { type: TorappuRoguelikeEventType.DUEL, weight: 10 },
          );
          break;
        case 5:
          typeWeights.push(
            { type: TorappuRoguelikeEventType.BATTLE_BOSS, weight: 10 },
            { type: TorappuRoguelikeEventType.SACRIFICE, weight: 10 },
            { type: TorappuRoguelikeEventType.EXPEDITION, weight: 10 },
            { type: 4096, weight: 10 },
            { type: TorappuRoguelikeEventType.PORTAL, weight: 10 },
            { type: TorappuRoguelikeEventType.DUEL, weight: 10 },
          );
          break;
      }
    }

    const yMax = [0, 2, 3, 4, 4, 4, 4, 4, 4];
    const stages = Object.keys(excel.RoguelikeTopicTable.details[theme].stages || {});
    // 关卡列表优先读 data/rlv2/nodesInfo.json（官方 stages 提取），缺失回退动态过滤
    const nodeInfo = this._nodesInfo?.themes?.[theme]?.zones?.[String(zone)];
    const normalList = nodeInfo?.Normal?.length
      ? nodeInfo.Normal
      : stages.filter((s) => s.startsWith(`ro${roNum}_n_${zone}_`));
    const eliteList = nodeInfo?.Emergency?.length
      ? nodeInfo.Emergency
      : stages.filter((s) => s.startsWith(`ro${roNum}_e_${zone}_`));
    const bossList = nodeInfo?.Boss?.length
      ? nodeInfo.Boss
      : stages.filter((s) => /^ro\d+_b_[1-9]$/.test(s));

    const nodesByX: { [key: number]: number[] } = {};
    let canAddShop = true;
    const isZone1 = zone === 1;

    const nodes: { [key: string]: PlayerRoguelikeNode } = {};

    const maxX = isZone1 ? 3 : zone * 2;
    for (let x = 0; x <= maxX; x++) {
      nodesByX[x] = [];
      const isEndCol = !isZone1 && x === maxX;

      if (isEndCol) {
        // 层尾规则（官方）：黑流树海前主题 1 层尾=商店、3/5 层尾=boss（奇数层含 1 为商店特例）；
        // 2/4 层尾=得偿所愿(512)/商店 视主题。奇数层（除 1）必 boss。
        const isOdd = zone % 2 === 1;
        let endType: number;
        let endCount: number;
        if (zone === 1) {
          endType = shopType; // 1 层尾必为商店（黑流树海前主题）
          endCount = 1;
        } else if (isOdd) {
          endType = TorappuRoguelikeEventType.BATTLE_BOSS; // 3、5 层尾必 boss
          endCount = 1;
        } else if (zone === 2) {
          endType = 512;
          endCount = 2;
        } else {
          endType = shopType;
          endCount = 1;
        }

        for (let y = 0; y < endCount; y++) {
          const nodeIndex = x * 100 + y;
          const node: PlayerRoguelikeNode = {
            index: `${nodeIndex}`,
            pos: { x, y },
            next: [],
            type: endType,
            zone_end: true,
            visibility: 0,
            refresh: { usedCount: 0, count: 99, cost: 1 },
          };

          if (endType === TorappuRoguelikeEventType.BATTLE_BOSS && bossList.length > 0) {
            const randomIndex = this.randByKey("boss_stage", zone.toString()) % bossList.length;
            node.stage = bossList[randomIndex];
          }

          nodes[`${nodeIndex}`] = node;
          nodesByX[x].push(y);
        }
        continue;
      }

      if (isZone1 && x >= 2) continue;

      const ySize = (this.randByKey("y_size", zone.toString(), x.toString()) % yMax[zone]) + 1;

      let currentTypeWeights = [...typeWeights];
      if (canAddShop && x > 0) {
        currentTypeWeights.push({ type: shopType, weight: 10 });
        canAddShop = false;
      }

      for (let y = 0; y < ySize; y++) {
        const nodeIndex = x * 100 + y;
        const nodeType = this.weightedRandom(currentTypeWeights);

        const node: PlayerRoguelikeNode = {
          index: `${nodeIndex}`,
          pos: { x, y },
          next: [],
          type: nodeType,
          visibility: 0,
            refresh: { usedCount: 0, count: 99, cost: 1 },
        };

        if (nodeType === TorappuRoguelikeEventType.BATTLE_NORMAL && normalList.length > 0) {
          const randomIndex = this.randByKey("normal_stage", zone.toString(), x.toString(), y.toString()) % normalList.length;
          node.stage = normalList[randomIndex];
        } else if (nodeType === TorappuRoguelikeEventType.BATTLE_ELITE && eliteList.length > 0) {
          const randomIndex = this.randByKey("elite_stage", zone.toString(), x.toString(), y.toString()) % eliteList.length;
          node.stage = eliteList[randomIndex];
        }

        nodes[`${nodeIndex}`] = node;
        nodesByX[x].push(y);
      }
    }

    if (isZone1) {
      const z1NodeType = TorappuRoguelikeEventType.INCIDENT;
      const endType = shopType; // 1 层尾必为商店（黑流树海前主题统一）

      const zone1Nodes: { [key: string]: PlayerRoguelikeNode } = {
        "200": {
          index: "200",
          pos: { x: 2, y: 0 },
          next: [{ x: 3, y: 0 }],
          type: z1NodeType,
          visibility: 0,
            refresh: { usedCount: 0, count: 99, cost: 1 },
        },
        "201": {
          index: "201",
          pos: { x: 2, y: 1 },
          next: [{ x: 3, y: 0 }],
          type: z1NodeType,
          visibility: 0,
            refresh: { usedCount: 0, count: 99, cost: 1 },
        },
        "300": {
          index: "300",
          pos: { x: 3, y: 0 },
          next: [],
          type: endType,
          zone_end: true,
          visibility: 0,
            refresh: { usedCount: 0, count: 99, cost: 1 },
        },
      };

      Object.assign(nodes, zone1Nodes);
      nodesByX[2] = [0, 1];
      nodesByX[3] = [0];
    }

    for (const [idx, node] of Object.entries(nodes)) {
      const { x, y } = node.pos;
      if (isZone1 && x >= 2) continue;

      node.next = [];

      if (x + 1 in nodesByX) {
        const candidates: { x: number; y: number }[] = [];
        for (const ny of [y - 1, y, y + 1]) {
          if (nodesByX[x + 1].includes(ny)) {
            candidates.push({ x: x + 1, y: ny });
          }
        }

        if (candidates.length > 0) {
          const k = Math.min(2, candidates.length);
          const shuffled = candidates.sort(() => random() - 0.5);
          node.next.push(...shuffled.slice(0, k));
        }
      }

      if (x !== 0) {
        for (const ny of [y - 1, y + 1]) {
          if (nodesByX[x].includes(ny)) {
            if (random() < 0.3) {
              const edge: { x: number; y: number; key?: boolean } = { x, y: ny };
              if (random() < 0.5) {
                edge.key = true;
              }
              node.next.push(edge);
            }
          }
        }
      }
    }

    const incoming: { [key: string]: boolean } = {};
    Object.keys(nodes).forEach((idx) => {
      incoming[idx] = false;
    });

    for (const [srcIdx, src] of Object.entries(nodes)) {
      const sx = src.pos.x;
      for (const e of src.next) {
        if (e.x === sx + 1) {
          const tidx = `${e.x * 100 + e.y}`;
          if (tidx in incoming) {
            incoming[tidx] = true;
          }
        }
      }
    }

    const hasOutgoing = (node: PlayerRoguelikeNode): boolean => {
      const x = node.pos.x;
      return node.next.some((e) => e.x === x + 1);
    };

    const xLast = Math.max(...Object.keys(nodesByX).map(Number));

    for (const [idx, node] of Object.entries(nodes)) {
      const { x, y } = node.pos;
      if (isZone1 && x >= 2) continue;

      const inOk = incoming[idx];
      const outOk = hasOutgoing(node);

      if (x === 0) {
        if (outOk) continue;

        const ny = nodesByX[x + 1].reduce((prev, curr) =>
          Math.abs(curr - y) < Math.abs(prev - y) ? curr : prev,
        );
        node.next.push({ x: x + 1, y: ny });
        continue;
      }

      if (x === xLast) {
        if (inOk) continue;

        const py = nodesByX[x - 1].reduce((prev, curr) =>
          Math.abs(curr - y) < Math.abs(prev - y) ? curr : prev,
        );
        const prevIdx = `${(x - 1) * 100 + py}`;
        nodes[prevIdx].next.push({ x, y });
        continue;
      }

      if (!inOk) {
        const py = nodesByX[x - 1].reduce((prev, curr) =>
          Math.abs(curr - y) < Math.abs(prev - y) ? curr : prev,
        );
        const prevIdx = `${(x - 1) * 100 + py}`;
        nodes[prevIdx].next.push({ x, y });
      }

      if (!outOk) {
        const ny = nodesByX[x + 1].reduce((prev, curr) =>
          Math.abs(curr - y) < Math.abs(prev - y) ? curr : prev,
        );
        node.next.push({ x: x + 1, y: ny });
      }
    }

    for (const node of Object.values(nodes)) {
      if (node.next) {
        node.next.sort((a, b) => {
          if (a.x !== b.x) return a.x - b.x;
          return a.y - b.y;
        });
      }
    }

    this.zones[id] = {
      id: `zone_${id}`,
      index: id,
      nodes: nodes,
      variation: [],
    };
  }

  findNode(
    zone_id: number,
    pos: { x: number; y: number },
  ): PlayerRoguelikeNode {
    return this.zones[zone_id].nodes[100 * pos.x + pos.y];
  }

  toJSON(): PlayerRoguelikeV2Dungeon {
    return {
      zones: this.zones,
    };
  }
}