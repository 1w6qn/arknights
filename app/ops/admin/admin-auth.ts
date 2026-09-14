/**
 * 管理接口认证中间件
 *
 * 校验请求头 Authorization: Bearer <token> / X-Admin-Token，或查询参数 ?token=
 * （后者供 EventSource（SSE 实时流）使用——浏览器 EventSource 无法自定义请求头）。
 * 仅当 data/config.json 中 admin.enable=true 时接口可用（安全默认关闭）。
 */
import { Request, Response, NextFunction } from "express";
import { getAdminConfig } from "./admin-config";
import { timingSafeEqualString } from "@utils/crypt";

export function adminAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const cfg = getAdminConfig();
  if (!cfg.enable) {
    res.status(403).json({
      error: "管理接口未启用：请在 data/config.json 中设置 admin.enable=true",
    });
    return;
  }
  const header = (req.headers.authorization as string) || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const queryToken = typeof req.query?.token === "string" ? req.query.token : "";
  const token = bearer || (req.headers["x-admin-token"] as string) || queryToken || "";
  // 常量时间比较（避免按字节短路泄露令牌前缀）
  if (!token || !timingSafeEqualString(token, cfg.token)) {
    res.status(401).json({ error: "管理令牌无效" });
    return;
  }
  next();
}
