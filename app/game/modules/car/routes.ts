/**
 * 出战战车路由模块
 *
 * 路径：/car/confirmBattleCar（根路径挂载），参考 OBS misc_bp 直接写 playerData。
 */
import { Router } from "express";
import { getPlayer } from "../../kernel/http/request-context";
import { validateBody } from "@core/http/validate-body";
import { ConfirmBattleCarRequest, ConfirmBattleCarResponse } from "./car";
import { confirmBattleCarSchema } from "./car.schema";

const router = Router();

/** 确认出战战车（服务端自定义 { car }） */
router.post("/car/confirmBattleCar", validateBody(confirmBattleCarSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ConfirmBattleCarRequest;
  // 参考 OBS misc_bp.car_confirmBattleCar：car.battleCar = car
  await player.update(async (draft) => {
    draft.car.battleCar = body.car;
  });
  res.send(player.delta satisfies ConfirmBattleCarResponse);
});

export default router;
