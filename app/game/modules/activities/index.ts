/**
 * 活动路由聚合（每活动一包：domain/activity/<family>/router.ts）
 *
 * 由 router/activity.ts 拆分：default 聚合 /activity 前缀路由，
 * rootRouter 聚合根级路由（act25side/act29side/act36side/actcheckinvs/trainingGround）。
 * 族挂载顺序与原文件首次出现顺序一致。
 */
import { Router } from "express";

import checkinRouter, { rootRouter as checkinRootRouter } from "./checkin/routes";
import milestoneRouter from "./milestone/routes";
import charmRouter from "./charm/routes";
import bossRushRouter from "./bossRush/routes";
import enemyDuelRouter from "./enemyDuel/routes";
import act24sideRouter from "./act24side/routes";
import footballRouter from "./football/routes";
import arcadeRouter from "./arcade/routes";
import act1vhalfidleRouter from "./act1vhalfidle/routes";
import act13sideRouter from "./act13side/routes";
import act35sideRouter from "./act35side/routes";
import act38sideRouter from "./act38side/routes";
import act42sideRouter from "./act42side/routes";
import act44sideRouter from "./act44side/routes";
import act45sideRouter from "./act45side/routes";
import act46sideRouter from "./act46side/routes";
import teamQuestRouter from "./teamQuest/routes";
import typeActRouter from "./typeAct/routes";
import act25sideRouter, { rootRouter as act25sideRootRouter } from "./act25side/routes";
import act29sideRouter, { rootRouter as act29sideRootRouter } from "./act29side/routes";
import act36sideRouter, { rootRouter as act36sideRootRouter } from "./act36side/routes";
import trainingGroundRouter, { rootRouter as trainingGroundRootRouter } from "./trainingGround/routes";
import arkhubRouter, { rootRouter as arkhubRootRouter } from "./arkhub/routes";
import interlockRefreshRouter from "./interlockRefresh/routes";

const router = Router();
router.use(checkinRouter);
router.use(milestoneRouter);
router.use(charmRouter);
router.use(bossRushRouter);
router.use(enemyDuelRouter);
router.use(act24sideRouter);
router.use(footballRouter);
router.use(arcadeRouter);
router.use(act1vhalfidleRouter);
router.use(act13sideRouter);
router.use(act35sideRouter);
router.use(act38sideRouter);
router.use(act42sideRouter);
router.use(act44sideRouter);
router.use(act45sideRouter);
router.use(act46sideRouter);
router.use(teamQuestRouter);
router.use(typeActRouter);
router.use(act25sideRouter);
router.use(act29sideRouter);
router.use(act36sideRouter);
router.use(trainingGroundRouter);
router.use(arkhubRouter);
router.use(interlockRefreshRouter);

const rootRouter = Router();
rootRouter.use(checkinRootRouter);
rootRouter.use(act25sideRootRouter);
rootRouter.use(act29sideRootRouter);
rootRouter.use(act36sideRootRouter);
rootRouter.use(trainingGroundRootRouter);
rootRouter.use(arkhubRootRouter);

export default router;
export { rootRouter };
