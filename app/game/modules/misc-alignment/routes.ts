/**
 * 全量对齐杂项路由（参考 ODPY，用户确认「参考项目全量对齐」）
 *
 * 覆盖 ODPY 清单中此前标注「设计跳过」的端点：遥测/埋点、支付变体、
 * ODPY 独有 api 端点、admin 别名、recalRune 根路径、yostar 等。
 * 多为 stub（返回空/固定响应），保证参考项目路径全部可达。
 */
import { Router } from "express";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { PlayerDataManager } from "../../kernel/player-data-manager";
import { validateBody } from "@core/http/validate-body";
import { miscAlignmentStubSchema } from "./misc-alignment.schema";

const router = Router();

/** 遥测/埋点/外部服务端点（客户端不依赖响应，返回空） */
for (const telemetryPath of [
  "/analytics/collect",
  "/beat",
  "/event",
  "/gameBulletin",
  "/loggw/logUpload.do",
  "/mgw.htm",
  "/deviceprofile/v4",
  "/iedsafe/Client/android/19791/config2.xml",
  "/survey/startSurvey",
  "/general/v1/send_phone_code",
]) {
  router.all(telemetryPath, validateBody(miscAlignmentStubSchema), async (_req, res) => {
    res.send({});
  });
}

/** yostar 登录链路（P4 原本跳过，全量对齐补 stub） */
router.post("/account/yostar_auth_request", validateBody(miscAlignmentStubSchema), async (req, res) => {
  res.send({ result: 0, uid: "", token: "" });
});
router.post("/account/yostar_auth_submit", validateBody(miscAlignmentStubSchema), async (req, res) => {
  res.send({ result: 0, uid: "", token: "" });
});
router.post("/user/yostar_createlogin", validateBody(miscAlignmentStubSchema), async (req, res) => {
  res.send({ result: 0, uid: "", token: "" });
});

/** ODPY 独有 app/api 端点（stub）——ODPY 注册为 POST（appGetCode/appGetSettings 转发 passport），
 *  本地既有为 GET，改为 all 覆盖两种方法（全量对齐按「路径可达」口径） */
router.all("/app/getCode", validateBody(miscAlignmentStubSchema), async (req, res) => {
  res.send({ code: "0" });
});
router.all("/app/getSettings", validateBody(miscAlignmentStubSchema), async (req, res) => {
  res.send({});
});
router.get("/api/gacha/cate", validateBody(miscAlignmentStubSchema), async (req, res) => {
  res.send({ cateList: [] });
});
router.get("/api/gacha/history", validateBody(miscAlignmentStubSchema), async (req, res) => {
  res.send({ history: [] });
});
router.get("/api/autoChess/act1autochess/playerSummary", validateBody(miscAlignmentStubSchema), async (req, res) => {
  res.send({});
});
router.get("/api/autoChess/act2autochess/playerSummary", validateBody(miscAlignmentStubSchema), async (req, res) => {
  res.send({});
});
router.get("/api/is/rogue_1/bulletinVersion", validateBody(miscAlignmentStubSchema), async (req, res) => {
  res.send({ version: 0 });
});
router.post("/api/is/rogue_1/bulletinVersion", validateBody(miscAlignmentStubSchema), async (req, res) => {
  res.send({ version: 0 });
});

/** 用户协议（ODPY 独有：GET 返回协议正文占位；POST 为本地既有 stub——两种方法都覆盖） */
router.all("/user/agreement", validateBody(miscAlignmentStubSchema), async (_req, res) => {
  res.send({ result: 0, data: [], version: "1.0.0" });
});
router.post("/user/auth/v2/token_by_phone_code", validateBody(miscAlignmentStubSchema), async (req, res) => {
  res.send({ result: 3, msg: "token_by_phone_code 已由 /user/auth/v1 替代" });
});

/** 支付变体（Appstore/支付宝/微信/订单查询——CN 2.7.61 客户端不调用，全量对齐补 stub） */
for (const payVariantPath of [
  "/pay/confirmOrderAppstore",
  "/pay/confirmOrderAppstoreNew",
  "/pay/createOrderAppstore",
  "/pay/order/v1/check",
  "/pay/order/v1/state",
  "/pay/v1/query_show_app_product",
  "/user/pay/order/v1/create/app_product/alipay",
  "/user/pay/order/v1/create/app_product/wechat",
  "/user/pay/order/v2/create/app_product",
  "/user/pay/v1/query_payment_config",
]) {
  router.post(payVariantPath, validateBody(miscAlignmentStubSchema), async (req, res) => {
    const player = getPlayerOptional();
    res.send({
      result: 0,
      ...(player ? player.delta : { playerDataDelta: { modified: {}, deleted: {} } }),
    });
  });
}

/**
 * 支付查询端点（ODPY 注册为 GET，本地原为 POST——补 GET 变体，其余方法不受影响）
 *
 * - GET /pay/order/v1/state：订单状态查询（ODPY pay.state 返回成功态样例）
 * - GET /user/pay/v1/query_payment_config：可用支付渠道列表（ODPY 返回 alipay/wechat 列表）
 */
router.get("/pay/order/v1/state", validateBody(miscAlignmentStubSchema), async (_req, res) => {
  res.send({
    status: 101,
    msg: "支付成功",
    data: { endTime: Math.floor(Date.now() / 1000) - 10, productList: [] },
  });
});
router.get("/user/pay/v1/query_payment_config", validateBody(miscAlignmentStubSchema), async (_req, res) => {
  res.send({ data: { payment: [] } });
});

/**
 * 寻访记录 / 卫戍协议战绩 webview 页面（客户端以网页形式打开）
 *
 * ODPY 直接返回官方页面 HTML；私服无对应网页资源，返回最小 HTML 占位保证路径可达
 * （不伪造记录内容，避免误导）。
 */
for (const webviewPath of ["/gacha", "/autoChess/act1autochess", "/autoChess/act2autochess"]) {
  router.get(webviewPath, validateBody(miscAlignmentStubSchema), async (_req, res) => {
    res.type("html").send(
      "<!doctype html><html lang=\"zh-cn\"><head><meta charset=\"utf-8\">" +
        "<title>DoctorateTs</title></head><body>" +
        "<p>该页面为官方网页版记录页，本地服务端不提供其内容。</p>" +
        "</body></html>",
    );
  });
}

/** recalRune 根路径别名（服务端既有 /crisis/recalRune/*） */
router.post("/recalRune/battleStart", validateBody(miscAlignmentStubSchema), async (req, res) => {
  const player = getPlayer();
  res.send({
    result: 0,
    battleId: "abcdefgh-1234-5678-a1b2c3d4e5f6",
    apFailReturn: 0,
    isApProtect: 0,
    inApProtectPeriod: false,
    notifyPowerScoreNotEnoughIfFailed: false,
    ...player.delta,
  });
});
router.post("/recalRune/battleFinish", validateBody(miscAlignmentStubSchema), async (req, res) => {
  const player = getPlayer();
  res.send({
    result: 0,
    ...player.delta,
  });
});

/** admin 别名（ODPY 管理端路径；本项目管理端为自有实现，此处仅保证路径可达） */
for (const adminAliasPath of [
  "/admin/cheat",
  "/admin/getVersion",
  "/admin/login/by_phone_password",
  "/admin/saveUserData",
  "/admin/verify",
]) {
  router.all(adminAliasPath, validateBody(miscAlignmentStubSchema), async (_req, res) => {
    res.send({ status: 0, result: 0 });
  });
}


/** 官方资源文件（/official/Android/assets/<hash>/<file>；私服无资源返回空） */
router.get("/official/Android/assets/:assetsHash/:fileName", validateBody(miscAlignmentStubSchema), async (_req, res) => {
  res.send({});
});


/** 根路径（ODPY 管理索引对应；返回空 JSON） */
router.all("/", validateBody(miscAlignmentStubSchema), async (_req, res) => {
  res.send({ result: 0 });
});


/** DoctoratePy 支付变体（支付宝/微信/成功回调——CN 2.7.61 客户端不调用，全量对齐补 stub） */
router.post("/pay/createOrderAlipay", validateBody(miscAlignmentStubSchema), async (req, res) => {
  const player = getPlayerOptional();
  res.send({ result: 0, ...(player ? player.delta : { playerDataDelta: { modified: {}, deleted: {} } }) });
});
router.post("/pay/createOrderWechat", validateBody(miscAlignmentStubSchema), async (req, res) => {
  const player = getPlayerOptional();
  res.send({ result: 0, ...(player ? player.delta : { playerDataDelta: { modified: {}, deleted: {} } }) });
});
router.post("/pay/confirmOrderAlipay", validateBody(miscAlignmentStubSchema), async (_req, res) => {
  res.send({ status: 0 });
});
router.post("/pay/confirmOrderWechat", validateBody(miscAlignmentStubSchema), async (_req, res) => {
  res.send({ status: 0 });
});
router.post("/pay/success", validateBody(miscAlignmentStubSchema), async (_req, res) => {
  res.send({ result: 0 });
});

/** DoctoratePy 管理登录（stub） */
router.post("/login", validateBody(miscAlignmentStubSchema), async (_req, res) => {
  res.send({ result: 0, msg: "OK" });
});


/** 协议确认（EN 客户端路径变体） */
router.post("/user/agreement/confirm", validateBody(miscAlignmentStubSchema), async (_req, res) => {
  res.send({ result: 0 });
});

/** EN/YoStar 客户端端点（CN 2.7.61 不调用，全量对齐补 stub） */
for (const enPath of [
  "/common/client-code",
  "/common/client-info",
  "/common/client-log",
  "/common/config",
  "/common/version",
  "/yostar/get-auth",
  "/user/detail",
  "/user/quick-login",
]) {
  router.all(enPath, validateBody(miscAlignmentStubSchema), async (_req, res) => {
    res.send({});
  });
}

export default router;
