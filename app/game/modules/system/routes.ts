/**
 * 审计（audit）路由
 *
 * 客户端 /audit/official/Android/version_<subpath> 与 /audit/official/Windows/<subpath>
 * 为资源版本审计端点（客户端检查资源版本用），私服返回空 stub 即可。
 */
import { Router } from "express";
import { z } from "zod";
import { validateBody } from "@core/http/validate-body";

/** 审计端点均为 stub（handler 不读 body），请求体校验为空对象 */
const auditStubSchema = z.object({});

const router = Router();

/** 资源文件审计（/audit/official/Android/assets/<hash>/<file>） */
router.post(
  "/official/Android/assets/:assetsHash/:fileName",
  validateBody(auditStubSchema),
  async (_req, res) => {
    res.send({});
  },
);

/** 其余审计路径（version_<subpath>、Windows/<subpath> 等）统一 stub */
router.use(validateBody(auditStubSchema), (_req, res) => {
  res.send({});
});

export default router;
