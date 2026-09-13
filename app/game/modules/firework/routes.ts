/**
 * 烟花路由模块
 *
 * 路径：/firework/{savePlateSlots,changeAnimal}（根路径挂载）。
 * 参考 OBS misc_bp 直接写 playerData 子树，暂无独立 manager。
 */
import { Router } from "express";
import { getPlayer } from "../../kernel/http/request-context";
import { validateBody } from "@core/http/validate-body";
import {
  FireworkChangeAnimalRequest,
  FireworkChangeAnimalResponse,
  FireworkSavePlateSlotsRequest,
  FireworkSavePlateSlotsResponse,
} from "./firework";
import {
  fireworkChangeAnimalSchema,
  fireworkSavePlateSlotsSchema,
} from "./firework.schema";

const router = Router();

/** 保存烟花棋盘槽位（CS: FireworkSavePlateSlotRequest { groupId?, slots }） */
router.post("/firework/savePlateSlots", validateBody(fireworkSavePlateSlotsSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as FireworkSavePlateSlotsRequest;
  // 参考 OBS misc_bp.firework_savePlateSlots：firework.plate.slots = slots
  await player.update(async (draft) => {
    // 修复：firework 数据未初始化时兜底，避免 .plate.slots 抛「reading 'plate'」500
    const fw = (draft.firework ??= {});
    fw.plate ??= {};
    fw.plate.slots = body.slots;
  });
  res.send(player.delta satisfies FireworkSavePlateSlotsResponse);
});

/** 更换烟花动物（CS: FireworkChangeAnimalRequest { animal, groupId? }） */
router.post("/firework/changeAnimal", validateBody(fireworkChangeAnimalSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as FireworkChangeAnimalRequest;
  // 参考 OBS misc_bp.firework_changeAnimal：firework.animal.select = animal
  await player.update(async (draft) => {
    // 修复：firework 数据未初始化时兜底，避免 .animal.select 抛「reading 'animal'」500
    const fw = (draft.firework ??= {});
    fw.animal ??= {};
    fw.animal.select = body.animal;
  });
  res.send({ animal: body.animal, ...player.delta } satisfies FireworkChangeAnimalResponse);
});

export default router;
