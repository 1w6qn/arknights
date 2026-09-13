/**
 * 邮件收藏路由模块
 *
 * 处理邮件收藏（mailCollection）相关请求。
 * 参考实现：reference/OpenBachelorS-master/src/openbachelors/bp/bp_mail.py mailCollection_getList
 * 请求/响应类型见 @game/modules/mail/mailCollection（参考 CS 2.7.61 协议类）。
 */

import { Router } from "express";
import excel from "@excel/excel";
import { validateBody } from "@core/http/validate-body";
import { getListSchema } from "./mailCollection.schema";
import {
  MailCollectionGetListRequest,
  MailCollectionGetListResponse,
} from "./mailCollection";

const router = Router();

/**
 * 获取邮件收藏列表
 * @route POST /mailCollection/getList
 * @returns collections（display_meta_table.mailArchiveData 的收藏 ID 列表）与 extra
 */
router.post("/getList", validateBody(getListSchema), async (req, res) => {
  req.body as MailCollectionGetListRequest;
  const collectionLst = Object.keys(
    excel.DisplayMetaTable.mailArchiveData.mailArchiveInfoDict,
  );
  res.send({ collections: collectionLst, extra: [] } satisfies MailCollectionGetListResponse);
});

export default router;
