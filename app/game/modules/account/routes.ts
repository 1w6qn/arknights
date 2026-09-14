import { Router } from "express";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { PlayerDataManager } from "../../kernel/PlayerDataManager";
import { accountManager } from "./AccountManager";
import { userTimestamp } from "@utils/time";
import config from "@core/config/index";
import {
  LoginRequest,
  LoginResponse,
  SyncDataRequest,
  SyncDataResponse,
  SyncPushMessageRequest,
  SyncPushMessageResponse,
  SyncStatusRequest,
  SyncStatusResponse,
} from "./account";
import { validateBody } from "@core/http/validate-body";
import { rateLimit } from "@core/auth/rate-limit";
import {
  loginSchema,
  syncDataSchema,
  syncPushMessageSchema,
  syncStatusSchema,
} from "./account.schema";

const router = Router();

/**
 * 本项目版本号（来源 package.json；登录提示推送展示用）
 */
const PROJECT_VERSION = "1.0.0";

/**
 * 用户登录（参考 DoctoratePy accountLogin）
 * 客户端流程：token_by_phone_password / oauth2 grant 拿到 token → /account/login 换游戏凭证 secret
 * token 语义：real 模式为账号 secret（或 uid 兼容），single 模式任意 token 收敛到 singleUid
 * 版本校验 YAGNI：clientVersion/networkVersion 读取但不拦截（私服客户端版本可能滞后，避免卡登录）
 */
router.post("/login", rateLimit({ name: "account:login" }), validateBody(loginSchema), async (req, res) => {
  const body = req.body as LoginRequest;
  const token = String(body?.token ?? "");
  const uid = await accountManager.getUidByToken(token);
  if (!uid) {
    // 参考 DoctoratePy：result 3 = 记忆已经模糊，请重新输入登录信息
    return res.send({ result: 3 } satisfies LoginResponse);
  }
  const conf = await accountManager.getUserConfig(uid);
  res.send({
    result: 0,
    uid,
    secret: conf?.secret || uid,
    serviceLicenseVersion: 0,
    majorVersion: config.majorVersion || "446",
  } satisfies LoginResponse);
});

router.post("/syncData", validateBody(syncDataSchema), async (req, res) => {
  const player = getPlayerOptional();
  if (!player) {
    return res.status(401).send({ status: 401, msg: "未登录（缺少 secret）" });
  }
  req.body as SyncDataRequest;

  // activity 切换（developer.timestamp 冻结）：响应 ts 与 pushFlags.status 同取一次
  const ts = userTimestamp();
  await player.update(async (draft) => {
    // activity 切换（developer.timestamp 冻结）：pushFlags.status 作为战斗加密 key 与
    // 响应 ts 必须一致——同取一次 userTimestamp（保证客户端加密/服务端解密一致）
    draft.pushFlags.status = ts;
  });
  // 修复：勋章 JoinGameDays 事件从未 emit → 加入游戏天数勋章永不推进（登录时刷新）
  await player._trigger.emit("JoinGameDays", [
    { registerTs: player._playerdata.status?.registerTs ?? 0 },
  ]);
  // B4：预序列化响应（user 全量 1.3MB 级 JSON.stringify 缓存，update 后失效）
  const userJson = player.toJSONString();
  // 登录会话内仅首次数同步推送一次本项目信息提示（项目名+版本号）
  player.pushLoginNotice(
    "DoctorateTs 私服",
    `DoctorateTs v${PROJECT_VERSION} · 本项目为明日方舟私服，仅用于学习交流`,
  );
  const deltaJson = JSON.stringify(player.delta);
  const body = `{"result":0,"ts":${ts},"user":${userJson}${deltaJson !== "{}" ? "," + deltaJson.slice(1, -1) : ""}}`;
  res.type("json").send(body);
});

router.post("/syncStatus", validateBody(syncStatusSchema), async (req, res) => {
  const player = getPlayerOptional();
  if (!player) {
    return res.status(401).send({ status: 401, msg: "未登录（缺少 secret）" });
  }
  req.body as SyncStatusRequest;
  await player._trigger.emit("status:refresh:time", []);
  res.send({
    ts: userTimestamp(),
    result: {},
    ...player.delta,
  } satisfies SyncStatusResponse);
});

router.post("/syncPushMessage", validateBody(syncPushMessageSchema), async (req, res) => {
  const player = getPlayerOptional();
  if (!player) {
    return res.status(401).send({ status: 401, msg: "未登录（缺少 secret）" });
  }
  req.body as SyncPushMessageRequest;
  const ts = userTimestamp();
  res.send({
    now: ts,
    next: ts + 60,
    ...player.delta,
  } satisfies SyncPushMessageResponse);
});

export default router;
