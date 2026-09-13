/**
 * 陷阱队路由模块
 *
 * 路径：/templateTrap/setTrapSquad（根路径挂载），参考 OBS misc_bp 直接写 playerData。
 */
import { Router } from "express";
import { getPlayer } from "../../kernel/http/request-context";
import { validateBody } from "../../kernel/http/validate-body";
import { SetTrapSquadRequest, SetTrapSquadResponse } from "./templateTrap";
import { setTrapSquadSchema } from "./templateTrap.schema";

const router = Router();

/** 设置陷阱队（CS: SetTemplateTrapRequest { trapDomainId, trapSquad }） */
router.post("/templateTrap/setTrapSquad", validateBody(setTrapSquadSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as SetTrapSquadRequest;
  // 修复：缺 trapDomainId/trapSquad 必填参数时返回业务错误，而非 500
  if (typeof body?.trapDomainId !== "string" || !Array.isArray(body?.trapSquad)) {
    return res.send({ result: 1, ...player.delta });
  }
  // 参考 OBS misc_bp.templateTrap_setTrapSquad：templateTrap.domains[id].squad = trapSquad
  await player.update(async (draft) => {
    draft.templateTrap.domains[body.trapDomainId].squad = body.trapSquad;
  });
  res.send({
    trapDomainId: body.trapDomainId,
    trapSquad: body.trapSquad,
    ...player.delta,
  } satisfies SetTrapSquadResponse);
});

export default router;
