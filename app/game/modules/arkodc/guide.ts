/**
 * arkodc 业务逻辑（act53side「直到大地变成一颗酸橙」旅行小记，活动模式 ODC 小游戏）
 *
 * 自 routes.ts 下沉：跨模块（home /story/finishStory）经 arkodc/public 门面调用，
 * 路由文件不再导出业务函数（裁决见 docs/architecture-coupling-adjudication.md）。
 * 状态逻辑参考 ODPY arkodc 类（写入 user.arkodc.topics[topicId].position / rewards）。
 */
import { PlayerDataManager } from "../../kernel/player-data-manager";
import excel from "@excel/excel";
import { isJsonObject } from "@excel/json-value";
import type { JsonValue } from "@excel/json-value";
import type { PlayerArkOdcTopic } from "@excel/types-playerdata";
import type { PlayerDataModel } from "../../kernel/playerdata";
import type { Draft } from "mutative";
import { activityDictKey } from "../activities/shared/unlockActivity";

/**
 * 惰性获取（并播种）arkodc 主题——draft.arkodc.topics[topicId] 不存在时创建默认结构。
 * 奇象巡展主题未在解锁播种中创建（真实时间模式/旧存档）时，路由不再静默丢弃。
 */
export function ensureArkOdcTopic(draft: Draft<PlayerDataModel>, topicId: string): PlayerArkOdcTopic {
  const arkodc = (draft.arkodc ??= { topics: {} });
  const topics = (arkodc.topics ??= {});
  let topic = topics[topicId];
  if (!topic) {
    topic = topics[topicId] = {
      varSeqs: {},
      rewards: {},
      position: { x: 0, y: 0, z: 0 },
    };
  }
  topic.varSeqs = topic.varSeqs ?? {};
  topic.rewards = topic.rewards ?? {};
  topic.position = topic.position ?? { x: 0, y: 0, z: 0 };
  return topic;
}

/** ODC 新手教程剧情 id（客户端 /story/finishStory 提交；trigger CUSTOM_OPERATION=PlayArkodcTutorial） */
export const ARK_ODC_GUIDE_STORY_ID = "activities/act53side/ark_odc_act53side_guide";

/**
 * ODC 新手教程完成同步（home.ts /story/finishStory 调用）
 *
 * 客户端教程（story ark_odc_act53side_guide）提交后，除 status.flags 标记外还需把
 * 主题 varSeq `bool_end_guide_done` 置 1——logic_game_end_p1 的 actorShowCondition
 * （q003_prog==4 && bool_end_guide_done==0 && q003_banner_showed==1）要求其为 0 才
 * AUTO_ONCE 触发 PlayArkodcTutorial；缺失该 varSeq → 每次进图都重放新手教程。
 * （官服完成态快照：varSeqs.bool_end_guide_done=1）
 */
export async function finishArkOdcGuideStory(
  player: PlayerDataManager,
  storyId: string,
): Promise<void> {
  if (storyId !== ARK_ODC_GUIDE_STORY_ID) return;
  // topicId 从 excel 活动配置取（数据版本键名多变时 activityDictKey 动态命中）
  const detail = excel.ActivityTable?.activity?.[
    activityDictKey("TYPE_ACT53SIDE") ?? "tYPE_ACT53SIDE"
  ];
  const detailEntries: JsonValue[] = isJsonObject(detail) ? Object.values(detail) : [];
  let topicId = "ark_odc_act53side";
  for (const data of detailEntries) {
    if (!isJsonObject(data)) continue;
    const constData = data.constData;
    const candidate = isJsonObject(constData) ? constData.arkOdcTopicId : undefined;
    if (candidate) {
      topicId = String(candidate);
      break;
    }
  }
  await player.update(async (draft) => {
    const topic = ensureArkOdcTopic(draft, topicId);
    topic.varSeqs.bool_end_guide_done = 1;
  });
}