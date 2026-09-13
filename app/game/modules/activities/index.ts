/**
 * 活动路由聚合（每活动一包：domain/activity/<family>/router.ts）
 *
 * 由 router/activity.ts 拆分：default 聚合 /activity 前缀路由，
 * rootRouter 聚合根级路由（act25side/act29side/act36side/actcheckinvs/trainingGround）。
 * 族挂载顺序与原文件首次出现顺序一致。
 */
import { Router } from "express";

import checkinRouter, { rootRouter as checkinRootRouter } from "./checkin/router";
import milestoneRouter from "./milestone/router";
import charmRouter from "./charm/router";
import bossRushRouter from "./bossRush/router";
import enemyDuelRouter from "./enemyDuel/router";
import act24sideRouter from "./act24side/router";
import footballRouter from "./football/router";
import arcadeRouter from "./arcade/router";
import act1vhalfidleRouter from "./act1vhalfidle/router";
import act13sideRouter from "./act13side/router";
import act35sideRouter from "./act35side/router";
import act38sideRouter from "./act38side/router";
import act42sideRouter from "./act42side/router";
import act44sideRouter from "./act44side/router";
import act45sideRouter from "./act45side/router";
import act46sideRouter from "./act46side/router";
import teamQuestRouter from "./teamQuest/router";
import typeActRouter from "./typeAct/router";
import act25sideRouter, { rootRouter as act25sideRootRouter } from "./act25side/router";
import act29sideRouter, { rootRouter as act29sideRootRouter } from "./act29side/router";
import act36sideRouter, { rootRouter as act36sideRootRouter } from "./act36side/router";
import trainingGroundRouter, { rootRouter as trainingGroundRootRouter } from "./trainingGround/router";
import arkhubRouter, { rootRouter as arkhubRootRouter } from "./arkhub/router";
import interlockRefreshRouter from "./interlockRefresh/router";

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
