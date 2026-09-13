/**
 * 客户端事件批量上报路由模块
 *
 * 客户端定期批量上报行为事件（关卡、抽卡、UI 等），私服无需处理业务逻辑，
 * 返回空响应即可（客户端只认状态码）。
 *
 * 路径：POST /batch_event（游戏域 ak-gs-* 根级接口，mitmweb 重定向后 Host 为 127.0.0.1）
 */
import { Router } from "express";
import { validateBody } from "@core/http/validate-body";
import { BatchEventRequest, BatchEventResponse } from "./batchEvent";
import { batchEventSchema } from "./batchEvent.schema";

const router = Router();

/** 客户端事件批量上报（统计/BI 类接口，返回空对象） */
router.post("/batch_event", validateBody(batchEventSchema), async (req, res) => {
  req.body as BatchEventRequest;
  res.send({} satisfies BatchEventResponse);
});

export default router;
