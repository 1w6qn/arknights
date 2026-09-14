/**
 * 认证模块路由
 * 
 * 提供用户登录、Token 管理、OAuth2 授权等认证相关的 API 接口。
 * 所有接口路径前缀为 `/auth`。
 */

import { Router, Request, Response, NextFunction } from "express";
import { now } from "@utils/time";
import { readJson } from "@utils/file";
import { logger } from "@utils/logger";
import { verifyPassword } from "@utils/crypt";
import { getAccountAuthPort } from "./account-port";
import { rateLimit } from "./rate-limit";
import { logService } from "@logs/log-service";
import config from "../config/index";

const router = Router();

/**
 * 认证端点限流（按「端点 + IP」固定窗口计数，阈值见 config.authRateLimit）
 *
 * 均为凭据敏感端点：登录/注册/短信/改密/换绑与 U8 渠道换 token，
 * 无约束时可被脚本无限次尝试口令或批量建号。
 */
const limitLogin = rateLimit({ name: "auth:login" });
const limitRegister = rateLimit({ name: "auth:register" });
const limitSms = rateLimit({ name: "auth:sms" });
const limitCredentialChange = rateLimit({ name: "auth:credential-change" });
const limitChannelToken = rateLimit({ name: "auth:channel-token" });

/** 动态服务器地址（去硬编码——协议/客服链接跟随 config.Host:PORT，与 remote-config resolveServer 一致） */
function serverUrl(): string {
  return `${config.Host}:${config.PORT}`;
}

/** U8 渠道 extension 载荷（客户端下发 JSON 字符串，字段随渠道而异） */
interface U8ExtensionPayload {
  /** 渠道授权码（getToken） */
  code?: string;
  /** 渠道访问令牌（verifyAccount） */
  access_token?: string;
}

/**
 * 解析 U8 渠道 extension 字段（JSON 字符串）
 *
 * 修复（2026-09-11）：U8 登录/校验两个端点的原实现直接 `JSON.parse(req.body.extension)`，
 * 缺字段时抛 SyntaxError → 统一错误处理归一为 500。空 body 属客户端错误，改判空返回 null
 * 由调用方回 400（core 层不引入 game 的错误类，避免 core → game 反向依赖）。
 * @param body - 请求体
 * @returns 解析后的 extension 对象；缺失或非合法 JSON 时为 null
 */
function parseExtension(body: { extension?: string } | undefined): U8ExtensionPayload | null {
  const raw = body?.extension;
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as U8ExtensionPayload;
  } catch {
    return null;
  }
}

/** extension 解析失败的统一 400 响应体（U8 渠道两端点共用） */
function extensionErrorBody(): { status: number; msg: string; code: string } {
  return { status: 1, msg: "extension 缺失或不是合法 JSON", code: "EXTENSION_INVALID" };
}

/** 请求来源地址（审计用——不信任转发头，取直连地址） */
function clientIp(req: Request): string {
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

/** 审计用账号脱敏（保留前 3 位与后 2 位，避免审计日志留全量手机号） */
function maskAccount(value: unknown): string {
  const s = String(value ?? "");
  if (!s) return "";
  if (s.length <= 5) return "***";
  return `${s.slice(0, 3)}***${s.slice(-2)}`;
}

/**
 * 获取服务器时间
 * 
 * 返回当前服务器时间戳和是否为节假日。
 * 
 * @route GET /auth/general/v1/server_time
 * @returns 服务器时间信息
 */
router.get("/general/v1/server_time", async (req, res) => {
  res.send({
    status: 0,
    type: "A",
    msg: "OK",
    data: {
      serverTime: now(),
      isHoliday: false,
    },
  });
});

/**
 * 获取应用配置
 * 
 * 返回游戏客户端所需的配置信息。
 * 
 * @route GET /auth/app/v1/config
 * @returns 应用配置 JSON
 */
router.get("/app/v1/config", async (req, res) => {
  // data/appConfig.json 为外部渠道配置（字段随渠道版本而异）——只声明本处改写点
  const cfg = await readJson<{ data?: { userCenterUrl?: string } }>("./data/appConfig.json");
  // 用户中心指向本地 /pcSdk/userInfo（官服 userCenterUrl 跳官方页面——私服化去硬编码）
  if (cfg?.data) {
    cfg.data.userCenterUrl = `${serverUrl()}/pcSdk/userInfo`;
  }
  res.send(cfg);
});

/**
 * 通过手机号和密码获取 Token
 * 
 * 用户登录接口，验证手机号和密码后返回登录 Token。
 * 
 * @route POST /auth/user/auth/v1/token_by_phone_password
 * @param phone - 用户手机号
 * @param password - 用户密码
 * @returns 包含 Token 的登录结果
 */
router.post("/user/auth/v1/token_by_phone_password", limitLogin, async (req, res) => {
  const phone = req.body?.phone;
  const password = req.body?.password;
  // 修复（2026-09-11）：缺字段时原实现把 undefined 透传给 AccountManager，real 模式会落到
  // 「账号不存在→自动注册」分支并以未捕获异常收场（HTTP 500）；空凭据属客户端错误 → 400
  if (typeof phone !== "string" || phone.length === 0 ||
      typeof password !== "string" || password.length === 0) {
    void logService.audit("authLoginRejected", "", `缺少凭据 ip=${clientIp(req)}`);
    return res.status(400).send({
      status: 1,
      msg: "手机号与密码不能为空",
      code: "CREDENTIAL_REQUIRED",
    });
  }
  const code = await getAccountAuthPort().tokenByPhonePassword(
    phone,
    password,
  );
  // 凭据不匹配（real 模式不再静默建号）时返回 401——原实现会回 200 + 空 token，
  // 客户端拿到空凭据继续走后续流程
  if (!code) {
    void logService.audit(
      "authLoginFailed",
      "",
      `凭据不匹配 账号=${maskAccount(phone)} ip=${clientIp(req)}`,
    );
    return res.status(401).send({
      status: 1,
      msg: "手机号或密码错误",
      code: "CREDENTIAL_INVALID",
    });
  }
  const uid = await getAccountAuthPort().getUidByToken(code);
  void logService.audit(
    "authLogin",
    uid,
    `账号=${maskAccount(phone)} ip=${clientIp(req)}`,
  );
  res.send({
    status: 0,
    msg: "OK",
    data: {
      token: code,
    },
  });
});

/**
 * 获取用户基本信息
 * 
 * 根据 Token 获取用户的认证信息，包括手机号、邮箱等。
 * 
 * @route GET /auth/user/info/v1/basic
 * @param token - 用户登录 Token（URL 参数）
 * @returns 用户认证信息
 */
router.get("/user/info/v1/basic", async (req, res) => {
  const uid = await getAccountAuthPort().getUidByToken(req.query!.token as string);
  const data = await getAccountAuthPort().getUserConfig(uid);
  if (config.authMode === "real" && !uid) {
    // 真实模式：无效 token 严格报错（单例模式宽松）
    return res.status(404).send({ status: 1, msg: "用户不存在", code: "USER_NOT_FOUND" });
  }
  // 对齐官服抓包结构：identityNum/identityName/isMinor/isLatestUserAgreement（2026-08-08 user/info/v1/basic）
  res.send({
    status: 0,
    msg: "OK",
    // token 无效时宽松返回空 auth（参考 DoctoratePy：按 token 查用户，私服单机不卡流程）
    data: {
      ...(data?.auth || {}),
      identityNum: uid,
      identityName: uid,
      isMinor: false,
      isLatestUserAgreement: true,
    },
  });
});

/** 是否需要云授权（参考 DoctoratePy userV1NeedCloudAuth） */
router.post("/user/info/v1/need_cloud_auth", async (req, res) => {
  res.send({ status: 0, msg: "OK" });
});

/** 云授权（SDK，参考 DoctoratePy——私服直接通过） */
router.post("/user/info/v1/cloud_auth", async (req, res) => {
  res.send({ status: 0, msg: "OK" });
});

/** 云授权结果验证（SDK——私服直接通过） */
router.post("/user/info/v1/verify_cloud_auth_result", async (req, res) => {
  res.send({ status: 0, msg: "OK" });
});

/** Token 换取用户状态（SDK /user/auth，参考 DoctoratePy userAuth） */
router.post("/user/auth", async (req, res) => {
  const token = String(req.body?.token ?? "");
  const uid = await getAccountAuthPort().getUidByToken(token);
  if (!uid) {
    return res.status(404).send({ status: 1, msg: "用户不存在" });
  }
  res.send({
    uid,
    isMinor: false,
    isAuthenticate: true,
    isGuest: false,
    needAuthenticate: false,
    isLatestUserAgreement: true,
  });
});

/** 验证码注册（SDK，参考 DoctoratePy——私服直接通过） */
router.post("/captcha/v1/register", async (req, res) => {
  res.send({ status: 0, msg: "OK" });
});

/** 用户协议版本（客户端检查——私服固定最新版本；POST 为 U8 SDK 备选调用方式，响应同 GET；协议 URL 动态跟随服务器地址） */
function agreementVersionBody(): Record<string, unknown> {
  const server = serverUrl();
  return {
    data: {
      agreementUrl: {
        childrenPrivacy: `${server}/protocol/plain/ak/children_privacy`,
        privacy: `${server}/protocol/plain/ak/privacy`,
        service: `${server}/protocol/plain/ak/service`,
        updateOverview: `${server}/protocol/plain/ak/overview_of_changes`,
      },
      authorized: true,
      isLatestUserAgreement: true,
    },
    msg: "OK",
    status: 0,
    type: "",
  };
}
router.get("/u8/user/auth/v1/agreement_version", async (req, res) => {
  res.send(agreementVersionBody());
});
router.post("/u8/user/auth/v1/agreement_version", async (req, res) => {
  res.send(agreementVersionBody());
});

/** PC SDK 用户中心（客户端 userCenterUrl 跳转；官服抓包响应为 null） */
router.get("/pcSdk/userInfo", async (_req, res) => {
  res.send(null);
});

/** OAuth2 授权共享 handler（v1 兼容旧客户端，v2 为现行版本——逻辑一致） */
async function oauth2Grant(req: Request, res: Response): Promise<void> {
  // 原实现 `req.body!.token` 在空 body 时抛 TypeError（归一为 500）；空 token 属客户端错误
  const code = String(req.body?.token ?? "");
  if (!code) {
    res.status(400).send({ status: 1, msg: "缺少 token", code: "TOKEN_REQUIRED" });
    return;
  }
  const uid = await getAccountAuthPort().getUidByToken(code);
  res.send({
    status: 0,
    msg: "OK",
    data: { code, uid },
  });
}

/** OAuth2 授权 v1（兼容旧客户端——同 v2 逻辑） */
router.post("/user/oauth2/v1/grant", oauth2Grant);

/**
 * OAuth2 授权
 *
 * 处理 OAuth2 授权流程，根据 Token 返回授权码和用户 ID。
 *
 * @route POST /auth/user/oauth2/v2/grant
 * @param token - 用户登录 Token
 * @returns 授权码和用户 ID
 */
router.post("/user/oauth2/v2/grant", oauth2Grant);

/**
 * U8 渠道获取 Token
 * 
 * 处理 U8 游戏渠道的登录请求，解析渠道参数并返回 Token。
 * 
 * @route POST /auth/u8/user/v1/getToken
 * @param extension - 渠道扩展参数，包含 code
 * @returns U8 渠道登录结果
 */
router.post("/u8/user/v1/getToken", limitChannelToken, async (req, res) => {
  const ext = parseExtension(req.body);
  if (!ext) return res.status(400).send(extensionErrorBody());
  const code: string = ext.code ?? "";
  const uid = await getAccountAuthPort().getUidByToken(code);
  // 修复（2026-09 审阅）：原实现未命中时仍回 result 0 + 空 uid，客户端会带着空凭据继续走流程；
  // 改为 result 1（保持 200 与官服响应形状，SDK 按 result 判失败）
  if (!uid) {
    void logService.audit("authChannelRejected", "", `U8 getToken ip=${clientIp(req)}`);
    return res.send({
      result: 1,
      captcha: {},
      error: "无效的渠道凭据",
      uid: "",
      channelUid: "",
      token: code,
      isGuest: 0,
      extension: JSON.stringify({ isMinor: false, isAuthenticate: false }),
      isNew: false,
    });
  }
  // 对齐官服抓包结构：captcha/error/isNew 字段（2026-08-07 auth/u8/user/v1/getToken）
  res.send({
    result: 0,
    captcha: {},
    error: "",
    uid,
    channelUid: uid,
    token: code,
    isGuest: 0,
    extension: JSON.stringify({
      isMinor: false,
      isAuthenticate: true,
    }),
    isNew: false,
  });
});

/** U8 渠道账号验证（参考 DoctoratePy userVerifyAccount——access_token 换 uid） */
router.post("/u8/user/verifyAccount", limitChannelToken, async (req, res) => {
  const ext = parseExtension(req.body);
  if (!ext) return res.status(400).send(extensionErrorBody());
  const token: string = ext.access_token ?? "";
  const uid = await getAccountAuthPort().getUidByToken(token);
  // 修复（2026-09 审阅）：未命中不再回 result 0 + 空 uid（同 getToken）
  if (!uid) {
    void logService.audit("authChannelRejected", "", `U8 verifyAccount ip=${clientIp(req)}`);
    return res.send({
      result: 1,
      uid: "",
      error: "无效的渠道凭据",
      extension: JSON.stringify({ isGuest: true }),
      channelUid: "",
      token,
      isGuest: 1,
    });
  }
  res.send({
    result: 0,
    uid,
    error: "",
    extension: JSON.stringify({ isGuest: false }),
    channelUid: uid,
    token,
    isGuest: 0,
  });
});

/**
 * 用户登出（参考 DoctoratePy onlineV1LoginOut）
 *
 * @route POST /auth/user/online/v1/loginout
 * @returns 登出成功结果
 */
router.post("/user/online/v1/loginout", async (req, res) => {
  res.send({ result: 0 });
});

/** 在线心跳（参考 DoctoratePy onlineV1Ping——客户端定期请求，返回正常 result 避免断线） */
router.post("/user/online/v1/ping", async (req, res) => {
  res.send({
    alertTime: 600,
    interval: 120,
    message: "OK",
    result: 0,
    timeLeft: -1,
  });
});

/** 在线心跳（客户端根路径别名 /online/v1/ping，无 /user 前缀） */
router.post("/online/v1/ping", async (req, res) => {
  res.send({
    alertTime: 600,
    interval: 120,
    message: "OK",
    result: 0,
    timeLeft: -1,
  });
});

/** 用户登出（客户端根路径别名 /online/v1/loginout，无 /user 前缀） */
router.post("/online/v1/loginout", async (req, res) => {
  res.send({ result: 0 });
});

/** 用户登出（EN 客户端路径 /user/info/v1/logout，stub） */
router.post("/user/info/v1/logout", async (_req, res) => {
  res.send({ result: 0 });
});

/** 协议确认（/user/info/v1/update_agreement 与 /u8/user/auth/v1/update_agreement，stub） */
router.post("/user/info/v1/update_agreement", async (_req, res) => {
  res.send({ result: 0 });
});
router.post("/u8/user/auth/v1/update_agreement", async (_req, res) => {
  res.send({ result: 0 });
});


/**
 * 手机号密码登录（参考 DoctoratePy userLogin）
 * result: 0 成功 / 1 用户名或密码错误 / 4 该用户尚不存在
 */
router.post("/user/auth/v1/login", limitLogin, async (req, res) => {
  const body = req.body ?? {};
  // 官方客户端 SDK 登录形状：{ networkVersion, uid, token }（token 为 SDK 会话）
  if (body.uid != null && body.token != null && body.account == null) {
    // 宽松解析：按 token 找账号（未知 token 兜底默认账号），返回可用的 secret token
    const uid = await getAccountAuthPort().getUidByToken(String(body.token ?? ""));
    const conf = getAccountAuthPort().configs[uid];
    if (!uid || !conf) {
      void logService.audit(
        "authLoginFailed",
        "",
        `SDK token 无匹配账号 ip=${clientIp(req)}`,
      );
      return res.send({ result: 4 });
    }
    void logService.audit("authLogin", uid, `SDK 登录 ip=${clientIp(req)}`);
    return res.send({
      result: 0,
      uid,
      token: conf.secret || uid,
      isAuthenticate: true,
      isMinor: false,
      needAuthenticate: false,
      isLatestUserAgreement: true,
    });
  }
  const { account, password } = body;
  const found = Object.entries(getAccountAuthPort().configs).find(
    ([, c]) => c.auth?.phone == account,
  );
  if (!found) {
    void logService.audit(
      "authLoginFailed",
      "",
      `账号不存在 账号=${maskAccount(account)} ip=${clientIp(req)}`,
    );
    return res.send({ result: 4 });
  }
  const [uid, conf] = found;
  // 密码校验（scrypt/sha256 哈希存储 + 旧明文兼容）
  if (!verifyPassword(conf.password, password)) {
    void logService.audit(
      "authLoginFailed",
      uid,
      `密码错误 ip=${clientIp(req)}`,
    );
    return res.send({ result: 1 });
  }
  void logService.audit("authLogin", uid, `账号密码登录 ip=${clientIp(req)}`);
  res.send({
    result: 0,
    uid,
    token: conf.secret || uid,
    isAuthenticate: true,
    isMinor: false,
    needAuthenticate: false,
    isLatestUserAgreement: true,
  });
});

/**
 * 手机号注册（参考 DoctoratePy userRegister）
 * result: 0 成功 / 5 <errMsg> 密码格式错误或账号已存在
 */
router.post("/user/auth/v1/register", limitRegister, async (req, res) => {
  const { account, password } = req.body ?? {};
  if (
    !/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d!@#$%^&*]{8,16}$/.test(password || "")
  ) {
    void logService.audit(
      "authRegisterRejected",
      "",
      `密码格式不符 账号=${maskAccount(account)} ip=${clientIp(req)}`,
    );
    return res.send({
      result: 5,
      errMsg:
        "<color=red>密码格式错误</color>\n密码应为8-16位大小写字母和数字的组合\n其中可以选择包含一些常用字符",
    });
  }
  const exists = Object.values(getAccountAuthPort().configs).some(
    (c) => c.auth?.phone == account,
  );
  if (exists) {
    void logService.audit(
      "authRegisterRejected",
      "",
      `账号已存在 账号=${maskAccount(account)} ip=${clientIp(req)}`,
    );
    return res.send({ result: 5, errMsg: "该账户已存在，请检查注册信息" });
  }
  const uid = await getAccountAuthPort().registerUser(account, password);
  const token = getAccountAuthPort().configs[uid]?.secret || uid;
  void logService.audit(
    "authRegister",
    uid,
    `账号=${maskAccount(account)} ip=${clientIp(req)}`,
  );
  res.send({
    result: 0,
    uid,
    token,
    isAuthenticate: false,
    isMinor: false,
    needAuthenticate: true,
    isLatestUserAgreement: true,
  });
});

/** 短信验证码登录（参考 DoctoratePy userLoginBySmsCode——私服简化：账号存在即成功） */
router.post("/user/auth/v1/login_by_smscode", limitLogin, async (req, res) => {
  const { account } = req.body ?? {};
  const found = Object.entries(getAccountAuthPort().configs).find(
    ([, c]) => c.auth?.phone == account,
  );
  if (!found) {
    return res.send({ result: 1 });
  }
  const [uid, conf] = found;
  res.send({
    result: 0,
    uid,
    token: conf.secret || uid,
    isAuthenticate: true,
    isMinor: false,
    needAuthenticate: false,
    isLatestUserAgreement: true,
  });
});

/** 发送短信验证码（参考 DoctoratePy userSendSmsCode——私服直接成功） */
router.post("/user/auth/v1/send_sms_code", limitSms, async (req, res) => {
  res.send({ result: 0, msg: "OK" });
});

/** 发送手机验证码（参考 DoctoratePy userInfoV1SendPhoneCode） */
router.post("/user/info/v1/send_phone_code", limitSms, async (req, res) => {
  res.send({ status: 0, msg: "OK" });
});

/** 实名认证（参考 DoctoratePy userAuthenticateUserIdentity——私服直接通过） */
router.post("/user/auth/v1/authenticate_user_identity", async (req, res) => {
  res.send({ result: 0, message: "OK", isMinor: false });
});

/** 同意用户协议（参考 DoctoratePy userUpdateAgreement） */
router.post("/user/auth/v1/update_agreement", async (req, res) => {
  res.send({ result: 0, message: "OK", isMinor: false });
});

/** 身份证校验（参考 DoctoratePy userCheckIdCard——私服直接通过） */
router.post("/user/auth/v1/check_id_card", async (req, res) => {
  res.send({ result: 0, message: "OK", isMinor: false });
});

/** 密码格式：8-16 位，含大小写字母和数字（与注册一致） */
const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d!@#$%^&*]{8,16}$/;

/** 从 body.token 或 secret header 解析 uid（real 模式用户管理闭环） */
async function resolveAuthUid(req: Request): Promise<string> {
  const token = String(req.body?.token ?? req.headers?.secret ?? "");
  return getAccountAuthPort().getUidByToken(token);
}

/**
 * 修改密码（参考 DoctoratePy userChangePassword——校验格式 + 验证码通过则更新）
 *
 * 错误码（`result` 保持官服语义不变，追加 `code` 细分，客户端只读 result 时行为不变）：
 * 3 + NOT_LOGGED_IN / 1 + PASSWORD_FORMAT_INVALID / 1 + OLD_PASSWORD_INVALID / 1 + PASSWORD_UNCHANGED
 */
router.post("/user/auth/v1/change_password", limitCredentialChange, async (req, res) => {
  const uid = await resolveAuthUid(req);
  if (!uid || !getAccountAuthPort().configs[uid]) {
    return res.send({ result: 3, code: "NOT_LOGGED_IN" });
  }
  const { newPassword, oldPassword } = req.body ?? {};
  if (!newPassword || !PASSWORD_PATTERN.test(newPassword)) {
    return res.send({ result: 1, code: "PASSWORD_FORMAT_INVALID" });
  }
  const conf = getAccountAuthPort().configs[uid];
  // 纵深防御（2026-09 审阅）：客户端携带旧密码时强制校验——仅有会话 token 不足以改密
  if (
    oldPassword != null &&
    oldPassword !== "" &&
    !verifyPassword(conf.password, String(oldPassword))
  ) {
    void logService.audit(
      "authChangePasswordRejected",
      uid,
      `旧密码校验失败 ip=${clientIp(req)}`,
    );
    return res.send({ result: 1, code: "OLD_PASSWORD_INVALID" });
  }
  if (conf.password && verifyPassword(conf.password, newPassword)) {
    return res.send({ result: 1, code: "PASSWORD_UNCHANGED" });
  }
  await getAccountAuthPort().updatePassword(uid, newPassword);
  void logService.audit("authChangePassword", uid, `ip=${clientIp(req)}`);
  // 改密同时轮换 secret（AccountManager.updatePassword）：回传新 token，旧会话 token 立即失效
  res.send({ result: 0, token: getAccountAuthPort().configs[uid]?.secret });
});

/** 换绑手机检查（参考 DoctoratePy userChangePhoneCheck——私服跳过 7 天限制） */
router.post("/user/auth/v1/change_phone_check", limitCredentialChange, async (req, res) => {
  const uid = await resolveAuthUid(req);
  if (!uid || !getAccountAuthPort().configs[uid]) {
    return res.send({ result: 3, code: "NOT_LOGGED_IN" });
  }
  res.send({ result: 0 });
});

/**
 * 换绑手机（参考 DoctoratePy userChangePhone——校验新手机可用 + 更新 phone/secret）
 *
 * 纵深防御（2026-09 审阅）：客户端携带密码（`password`/`oldPassword`）时强制校验，
 * 避免仅凭会话 token 即可换绑手机号（换绑会轮换 secret，等于接管账号）。
 */
router.post("/user/auth/v1/change_phone", limitCredentialChange, async (req, res) => {
  const uid = await resolveAuthUid(req);
  if (!uid || !getAccountAuthPort().configs[uid]) {
    return res.send({ result: 3 });
  }
  const { newPhone, password, oldPassword } = req.body ?? {};
  const inputPassword = password ?? oldPassword;
  if (
    inputPassword != null &&
    inputPassword !== "" &&
    !verifyPassword(
      getAccountAuthPort().configs[uid].password,
      String(inputPassword),
    )
  ) {
    void logService.audit(
      "authChangePhoneRejected",
      uid,
      `密码校验失败 ip=${clientIp(req)}`,
    );
    return res.send({ result: 1, code: "PASSWORD_INVALID" });
  }
  // 8 = 手机号已被使用；12 = 验证码错误（私服跳过短信验证，视为通过）
  if (!newPhone || !/^\d{6,}$/.test(String(newPhone))) {
    return res.send({ result: 8, code: "PHONE_FORMAT_INVALID" });
  }
  const taken = Object.values(getAccountAuthPort().configs).some(
    (c) => c.auth?.phone == newPhone,
  );
  if (taken) {
    return res.send({ result: 8, code: "PHONE_TAKEN" });
  }
  await getAccountAuthPort().updatePhone(uid, String(newPhone));
  void logService.audit(
    "authChangePhone",
    uid,
    `新手机号=${maskAccount(newPhone)} ip=${clientIp(req)}`,
  );
  // 换绑同时轮换 secret：回传新 token，旧会话 token 立即失效
  res.send({ result: 0, token: getAccountAuthPort().configs[uid]?.secret });
});

/** 游客登录（参考 DoctoratePy userV1GuestLogin——私服返回未激活） */
router.post("/user/auth/v1/guest_login", async (req, res) => {
  res.send({ result: 3 });
});

/** 注销授权（参考 DoctoratePy userOauth2V1UnbindGrant——私服直接成功） */
router.post("/user/oauth2/v1/unbind_grant", async (req, res) => {
  res.send({ status: 0, msg: "OK" });
});

/** 支付订单状态（参考 DoctoratePy payConfirmOrderState——私服无支付返回未完成） */
router.post("/u8/pay/confirmOrderState", async (req, res) => {
  res.send({ payState: 0 });
});

/**
 * 获取 U8 渠道商品列表
 * 
 * 返回 U8 渠道的付费商品列表（从本地 AllProductList.json 读取）。
 * 
 * @route POST /auth/u8/pay/getAllProductList
 * @returns 商品列表
 */
router.post("/u8/pay/getAllProductList", async (req, res) => {
  res.send(await readJson("./data/shop/AllProductList.json"));
});

/**
 * 统一异常处理（API 兜底）
 * 异步 handler 抛错（Express 5 自动捕获）→ 返回 JSON 错误而非裸 500
 */
router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error("auth", err?.message || String(err));
  res.status(500).send({
    status: 1,
    msg: "服务器内部错误",
    code: "INTERNAL_ERROR",
  });
});

export default router;