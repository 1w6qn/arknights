/**
 * arkhub 网关捕捉/对局/生物/交换处理（handlers——逻辑层）
 *
 * 草丛扫描（GetCaptureInfo/StartCapture/EncounterCreatureNotify/EndCapture）、
 * 拟合对局（JoinDuel/CancelDuel/StartDuel/RoundPrepare/…/DuelRoundResultReport）、
 * 生物管理（Delete/SetLike/SetFollowing/SetSquad）、交换（预设/发起/应答/列表）。
 * 帧形状对齐官服逆向（docs/arkhub-gateway-protocol.md §9.2/§9.3/§11）。
 * 路由注册入口：registerPlayHandlers(router)。
 */
import { logger } from "@utils/logger";
import {
  encodeFieldBytes as fb,
  encodeFieldVarint as fv,
  ProtoReader,
} from "../codec";
import type { ArkhubSessionFrameRouter } from "../dispatch";
import type { ArkhubSessionHandlerContext, ArkhubSessionFrame } from "../contract";
import { CAPTURE_MAP_IDS, ARKHUB_STATE_MASK, pushPlayerStateMask } from "./hub";
import {
  GW_ANSWER_EXCHANGE_REQ,
  GW_CANCEL_DUEL_REQ,
  GW_CAPTURE_INFO_REQ,
  GW_CAPTURE_INFO_RESP,
  GW_CODE_OK,
  GW_CREATE_EXCHANGE_REQ,
  GW_CREATURE_ALTER_NOTIFY,
  GW_DELETE_CREATURE_REQ,
  GW_DUEL_ROUND_RESULT_REPORT_REQ,
  GW_ENCOUNTER_CREATURE_NOTIFY,
  GW_END_CAPTURE_REQ,
  GW_END_CAPTURE_RESP,
  GW_EXCHANGE_STATE_NOTIFY,
  GW_GET_ALL_EXCHANGE_INFO_REQ,
  GW_GET_ALL_EXCHANGE_INFO_RESP,
  GW_JOIN_DUEL_REQ,
  GW_JOIN_DUEL_RESP,
  GW_LEAVE_DUEL_REQ,
  GW_LOADING_FINISH_REQ,
  GW_ON_JOIN_DUEL_NOTIFY,
  GW_PRESET_EXCHANGE_REQ,
  GW_ROUND_PREPARE_REQ,
  GW_SET_CREATURE_LIKE_REQ,
  GW_SET_CREATURE_SQUAD_REQ,
  GW_SET_FOLLOWING_CREATURE_REQ,
  GW_START_CAPTURE_REQ,
  GW_START_CAPTURE_RESP,
  GW_START_DUEL_REQ,
  GW_START_DUEL_RESP,
  GW_UPLOAD_BATTLE_DATA_REQ,
  GW_DUEL_STAGE_CHANGE_NOTIFY,
} from "../messages";


/** 拟合对局关卡（stage_table：act1arkhub_08 = "奇象拟合对战场"） */
const DUEL_STAGE_ID = "act1arkhub_08";
/**
 * 捕抓区 → 捕捉关卡（官服 EncounterCreatureNotify.stage_id 实锤 _13/_14/_15 三种，
 * 与区域的具体对应关系抓包未携带 map_id 无从确证——私服按序确定性映射）。
 */
const CAPTURE_STAGE_IDS = ["act1arkhub_13", "act1arkhub_14", "act1arkhub_15"];
/**
 * 扫描成功奖励（官服 EndCaptureResp settle_info.f4 抓包实锤：`2205088927 100f` =
 * {1:5001, 2:15}——网关数字奖励 id 5001 即巡展纪念章，与 arkdex_1_gold/券同源）。
 */
const SCAN_REWARD = { id: 5001, count: 15 };
/**
 * 私服本地捕捉遭遇生物兜底（StartCaptureReq 时 onScanStart 无返回则回填，
 * 用于 EncounterCreatureNotify 推送与 onScanSettle 结算入参——私服降级，真实遭遇走遭遇引擎）。
 */
const CAPTURE_ENCOUNTER_CREATURES: number[] = [19005, 19016, 19060];

/** 当前场景对应的捕捉关卡（非捕抓区回退 _15） */
function captureStageId(mapId: number): string {
  const idx = CAPTURE_MAP_IDS.indexOf(mapId);
  return idx >= 0 ? CAPTURE_STAGE_IDS[idx] : CAPTURE_STAGE_IDS[2];
}

/* ---------- 应答构建（生物/捕捉/对局/交换，字段号对齐官服逆向） ---------- */

/**
 * CreatureBrief 消息体：{1:unique_id(ulong), 2:template_id(uint), 3:persona(uint)}
 * 权威字段：CreatureBrief.cs ProtoMember(1/2/3)。
 *
 * @param uniqueId - 生物个体唯一 id（会话内稳定即可）
 * @param templateId - 生物模板 id（arkdex creature_numId）
 * @param persona - 个性/变体（缺省 0）
 */
function buildCreatureBrief(uniqueId: bigint, templateId: number, persona = 0): Buffer {
  return Buffer.concat([fv(1, uniqueId), fv(2, templateId), fv(3, persona)]);
}

/** 生物个体唯一 id 基址（unique_id = 基址 + 序号；高位段隔离，单机遭遇/结算引用同一批） */
const CREATURE_INST_ID_BASE = BigInt(0x100000000);

/**
 * 由生物模板 id 列表生成 CreatureBrief 数组（每人个体 id 取 0x100000000 递增基底，
 * 保证 neg-id 空间独立且稳定——单机遭遇/结算均引用同一批）。
 */
function buildCreatureBriefs(creatureTemplates: number[]): Buffer[] {
  return (creatureTemplates ?? []).map((t, i) =>
    buildCreatureBrief(CREATURE_INST_ID_BASE + BigInt(i + 1), t, 0),
  );
}

/**
 * CreatureBattleInfo 消息体：{1:creatures[](CreatureBrief), 2:stage_id, 3:capture_type}
 * 权威字段：CreatureBattleInfo.cs ProtoMember(1/2/3)。
 */
function buildCreatureBattleInfo(creatureBriefs: Buffer[], stageId: string, captureType = 1): Buffer {
  return Buffer.concat([
    ...creatureBriefs.map((b) => fb(1, b)),
    fb(2, Buffer.from(stageId, "utf8")),
    fv(3, captureType),
  ]);
}

/**
 * 捕捉开始响应（StartCaptureResp）：{1:code(uint), 2:battle_id}。
 * battle_id 官服形状（抓包实锤）："uid:时间戳"。
 */
function buildStartCaptureResp(uid: string): Buffer {
  const battleId = `${uid || "0"}:${Date.now()}`;
  return Buffer.concat([fv(1, GW_CODE_OK), fb(2, Buffer.from(battleId, "utf8"))]);
}

/**
 * 遭遇生物通知（EncounterCreatureNotify，服务端在 StartCapture 后主动推）：
 * {1:battle_info=CreatureBattleInfo{...}}——客户端据此展示本次捕捉遭遇生物。
 * 权威字段：EncounterCreatureNotify.cs ProtoMember(1)、CreatureBattleInfo.cs。
 */
function buildEncounterCreatureNotify(creatureBriefs: Buffer[], stageId: string): Buffer {
  return fb(1, buildCreatureBattleInfo(creatureBriefs, stageId));
}

/**
 * 捕捉结算响应（EndCaptureResp）：[4B seq回显] {1:settle_info=ArkDexSettleInfo{1:is_success,
 * 2:end_time, 3:creatures[], 4:rewards[{1:id, 2:count}]}}——权威字段：
 * EndCaptureResp.cs/ArkDexSettleInfo.cs；成功奖励 f4 官服抓包实锤（扫描成功 15 券）；
 * [seq] 回显对齐官服样本 `0000002f…`。放弃/失败回最小形状 {1:{2:end_time}}（官服实锤）。
 */
function buildEndCaptureResp(seq: number, isSuccess: boolean, creatureBriefs: Buffer[]): Buffer {
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeUInt32BE(seq, 0);
  if (!isSuccess) {
    return Buffer.concat([seqBuf, fb(1, fv(2, BigInt(Date.now())))]);
  }
  const settle = Buffer.concat([
    fv(1, 1),
    fv(2, BigInt(Date.now())),
    ...creatureBriefs.map((b) => fb(3, b)),
    fb(4, Buffer.concat([fv(1, SCAN_REWARD.id), fv(2, SCAN_REWARD.count)])),
  ]);
  return Buffer.concat([seqBuf, fb(1, settle)]);
}

/**
 * 捕捉信息查询响应（GetCaptureInfoResp）：{1:code, 2:battle_info}
 * 权威字段：GetCaptureInfoResp.cs ProtoMember(1/2)。单机回当前遭遇（可为空）。
 */
function buildGetCaptureInfoResp(creatureBattleInfo: Buffer): Buffer {
  return Buffer.concat([fv(1, GW_CODE_OK), fb(2, creatureBattleInfo)]);
}

/**
 * 对局入座响应（JoinDuelResp）：{1:code(int), 2:mode_type(int)}
 * 权威字段：JoinDuelResp.cs ProtoMember(1/2)。
 */
function buildJoinDuelResp(): Buffer {
  return Buffer.concat([fv(1, GW_CODE_OK), fv(2, 0)]);
}

/**
 * 对局入座广播（OnJoinDuelNotify，服务端入座后主动推）：
 * {1:duel_id, 2:stage_id, 3:battle_id, 4:mode_type}——权威字段：JoinDuelNotify.cs。
 * 单机最小化：仅 duel_id + stage_id + mode_type=0。
 */
function buildOnJoinDuelNotify(): Buffer {
  return Buffer.concat([
    fb(1, Buffer.from(`duel_${BigInt.asUintN(32, BigInt(Date.now())).toString(16)}`, "utf8")),
    fb(2, Buffer.from(DUEL_STAGE_ID, "utf8")),
    fv(4, 0),
  ]);
}

/**
 * 对局开始响应（StartDuelResp）：{1:code(int)=100}
 * 权威字段：StartDuelResp.cs ProtoMember(1)。
 */
function buildStartDuelResp(): Buffer {
  return Buffer.from([0x08, GW_CODE_OK]);
}

/**
 * 交换信息响应（GetAllCreatureExchangeInfoResp）：{1:requests[], 2:exchange_type}。
 * 权威字段：GetAllCreatureExchangeInfoRsp.cs ProtoMember(1/2/3)；官服样本 `1001` =
 * f2 回显请求的 exchange_type。单机无真实对手：requests 回填玩家自己的挂单（回显）。
 *
 * @param exchangeType - 请求的交换类型（回显）
 * @param trade - 玩家挂单（resolveTrade；无则 requests 空）
 * @param uid - 当前玩家 uid（from_player_uid）
 */
function buildExchangeInfoResp(
  exchangeType: number,
  trade: { wantSpecies: number; offeringUniqueId: number; ts: number } | undefined,
  uid: string,
): Buffer {
  const parts: Buffer[] = [];
  if (trade) {
    // CreatureExchangeRequest（反编译字段）：{1:from_player_uid, 3:request_time,
    // 4:from_creature_brief(给出个体), 5:to_creature_brief(想要种类), 6:expire_time}；
    // 时间戳单位无官服样本佐证，按秒推断（dexConstData.tradeRequestTime=300 秒）
    const tsSec = Math.floor(trade.ts / 1000);
    const entry = Buffer.concat([
      fb(1, Buffer.from(uid || "0", "utf8")),
      fv(3, BigInt(tsSec)),
      fb(4, fv(1, BigInt(trade.offeringUniqueId))), // 给出的个体（unique_id；template_id 单机不推断）
      fb(5, fv(2, trade.wantSpecies)), // 想要的种类（template_id）
      fv(6, BigInt(tsSec + 300)),
    ]);
    parts.push(fb(1, entry));
  }
  parts.push(fv(2, exchangeType));
  return Buffer.concat(parts);
}

/* ---------- 帧处理 ---------- */

/** 捕捉信息查询（GetCaptureInfoReq：{1:creature_inst_id}）→ GetCaptureInfoResp {1:code, 2:battle_info} */
function handleGetCaptureInfo(ctx: ArkhubSessionHandlerContext, frame: ArkhubSessionFrame): void {
  logger.info("arkhub-gateway", `捕捉信息查询 → 捕捉信息 (uid=${ctx.state.uid || "?"})`);
  ctx.send(
    8,
    (frame.subID & ~0xffffffffn) | GW_CAPTURE_INFO_RESP,
    buildGetCaptureInfoResp(
      buildCreatureBattleInfo(
        buildCreatureBriefs(ctx.state.encounter?.creatures ?? []),
        captureStageId(ctx.state.currentMapId),
      ),
    ),
  );
}

/**
 * 捕捉开始（StartCaptureReq：{1:param=ArkDexStartParam{...}}）→ StartCaptureResp{1:code,
 * 2:battle_id}；随后服务端主动推 EncounterCreatureNotify——客户端据此展示。
 * 遭遇闭环：onScanStart 同步返回本轮遭遇（读上一轮已落盘的 activeEncounter，错开一帧
 * 避免 async 竞态）；无返回时回填兜底集（私服降级）。
 */
function handleStartCapture(ctx: ArkhubSessionHandlerContext, frame: ArkhubSessionFrame): void {
  const { state, opts } = ctx;
  if (CAPTURE_MAP_IDS.includes(state.currentMapId)) {
    let enc: { creatures: number[]; lureNumId?: number } | undefined;
    try {
      enc = opts.onScanStart?.(state.uid, state.currentMapId);
    } catch (e) {
      logger.warn("arkhub-gateway", `捕捉遭遇读取失败: ${(e as Error).message}`);
    }
    state.encounter =
      enc && enc.creatures.length > 0
        ? enc
        : { creatures: [...CAPTURE_ENCOUNTER_CREATURES] };
  }
  const creatures = state.encounter?.creatures ?? [];
  const encounterBriefs = buildCreatureBriefs(creatures);
  const stageId = captureStageId(state.currentMapId);
  logger.info(
    "arkhub-gateway",
    `捕捉开始 (map=${state.currentMapId}) → StartCaptureResp + 遭遇 ${creatures.join(",") || "无"} (${stageId})`,
  );
  ctx.send(8, (frame.subID & ~0xffffffffn) | GW_START_CAPTURE_RESP, buildStartCaptureResp(state.uid));
  ctx.send(
    8,
    (frame.subID & ~0xffffffffn) | GW_ENCOUNTER_CREATURE_NOTIFY,
    buildEncounterCreatureNotify(encounterBriefs, stageId),
  );
  // 捕捉战状态（官服实锤：StartCapture 后推 PlayerAlterDataNotify f1=0x400）——
  // 客户端据此进入捕捉战状态机（名片图标/交互锁）
  if (CAPTURE_MAP_IDS.includes(state.currentMapId)) {
    state.stateMask |= ARKHUB_STATE_MASK.CAPTURE_BATTLE;
    pushPlayerStateMask(ctx);
  }
}

/**
 * 解析 EndCaptureReq 的 ArkDexEndParam（{1:complete_state, 2:captured[packed] 槽位索引}）。
 * 官服抓包实锤：成功帧 {1:3, 2:[槽位…]}；放弃帧仅 {1:1}（无 captured）。
 */
function parseEndParam(buf: Buffer): { completeState: number; slots: number[] } {
  let completeState = 0;
  const slots: number[] = [];
  const r = new ProtoReader(buf);
  for (;;) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.field === 1 && tag.wire === 0) completeState = Number(r.readVarint());
    else if (tag.field === 2 && tag.wire === 2) {
      // packed repeated varint（IsPacked=true）：内容为裸 varint 序列，非带标签字段
      const bytes = r.readLengthDelimited();
      const pr = new ProtoReader(bytes);
      while (!pr.eof) slots.push(Number(pr.readVarint()));
    } else if (tag.wire === 0) r.readVarint();
    else if (tag.wire === 2) r.readLengthDelimited();
    else break;
  }
  return { completeState, slots };
}

/**
 * 捕捉结束（EndCaptureReq：[4B seq] {1:battle_id, 2:param=ArkDexEndParam{1:complete_state,
 * 2:captured(packed 槽位索引)}}）→ EndCaptureResp{1:settle_info}。
 * 成功（complete_state=3）：按槽位索引从遭遇会话取捕获子集 → onScanSettle；
 * 放弃/失败：无奖励最小响应；无 param（引导战/旧形状）：回退旧行为（遭遇非空即成功）。
 */
function handleEndCapture(ctx: ArkhubSessionHandlerContext, frame: ArkhubSessionFrame): void {
  const { state, opts } = ctx;
  const encounter = state.encounter?.creatures ?? [];
  const body = frame.body;
  const seq = body.length >= 4 ? body.readUInt32BE(0) : 0;
  let isSuccess: boolean;
  let captured: number[];
  let hasParam = false;
  if (body.length > 4) {
    let completeState = 0;
    const slots: number[] = [];
    const r = new ProtoReader(body.subarray(4));
    for (;;) {
      const tag = r.readTag();
      if (!tag) break;
      if (tag.field === 2 && tag.wire === 2) {
        hasParam = true;
        const p = parseEndParam(r.readLengthDelimited());
        completeState = p.completeState;
        slots.push(...p.slots);
      } else if (tag.wire === 0) r.readVarint();
      else if (tag.wire === 2) r.readLengthDelimited();
      else break;
    }
    if (hasParam) {
      isSuccess = completeState === 3 && slots.length > 0;
      captured = slots
        .map((i) => encounter[i])
        .filter((n): n is number => Number.isFinite(n));
      // 槽位越界/遭遇缺失时回退全量（宁可多发不漏发——私服宽松）
      if (isSuccess && captured.length === 0) captured = [...encounter];
    } else {
      isSuccess = encounter.length > 0;
      captured = [...encounter];
    }
  } else {
    isSuccess = encounter.length > 0;
    captured = [...encounter];
  }
  if (isSuccess) {
    try {
      opts.onScanSettle?.(state.uid, captured);
    } catch (e) {
      logger.warn("arkhub-gateway", `捕捉结算奖励处理失败: ${(e as Error).message}`);
    }
  }
  state.encounter = undefined;
  logger.info(
    "arkhub-gateway",
    `捕捉结束 ${isSuccess ? `(捕获 ${captured.join(",")})` : "(未捕获)"} → settle_info`,
  );
  ctx.send(
    8,
    (frame.subID & ~0xffffffffn) | GW_END_CAPTURE_RESP,
    buildEndCaptureResp(seq, isSuccess, buildCreatureBriefs(captured)),
  );
  // 捕捉结束 → 清除捕捉战状态位并下发（与开始的 0x400 推送对称，状态机回闲）；
  // 成功时同帧带上变更后券数（扫描 +15，发奖异步落盘，此处直接加增量），
  // 否则客户端券数/道具状态要等切地图重发场景帧才刷新。
  state.stateMask &= ~ARKHUB_STATE_MASK.CAPTURE_BATTLE;
  pushPlayerStateMask(
    ctx,
    undefined,
    isSuccess ? (opts.resolveCoin?.(state.uid) ?? 0) + 15 : undefined,
  );
}

/** 对局入座（JoinDuelReq）→ JoinDuelResp；随后服务端主动推 OnJoinDuelNotify */
function handleJoinDuel(ctx: ArkhubSessionHandlerContext, frame: ArkhubSessionFrame): void {
  logger.info("arkhub-gateway", `对局入座 → JoinDuelResp + OnJoinDuelNotify (uid=${ctx.state.uid || "?"})`);
  ctx.send(8, (frame.subID & ~0xffffffffn) | GW_JOIN_DUEL_RESP, buildJoinDuelResp());
  ctx.send(8, (frame.subID & ~0xffffffffn) | GW_ON_JOIN_DUEL_NOTIFY, buildOnJoinDuelNotify());
}

/** 对局开始（StartDuelReq：BattleParam{1:duel_id, 2:battle_id}）→ StartDuelResp{1:code=100} + 对局战状态 */
function handleStartDuel(ctx: ArkhubSessionHandlerContext, frame: ArkhubSessionFrame): void {
  logger.info("arkhub-gateway", `对局开始 → StartDuelResp (uid=${ctx.state.uid || "?"})`);
  ctx.send(8, (frame.subID & ~0xffffffffn) | GW_START_DUEL_RESP, buildStartDuelResp());
  // 对局战状态（官服实锤：JoinDuel/StartDuel 后推 PlayerAlterDataNotify f1=0x800）——
  // 客户端 _TryHandleBattleStartState 据此打开战斗开始对话框（selfStateMask > 2048 判定）
  ctx.state.stateMask |= ARKHUB_STATE_MASK.DUEL_BATTLE;
  pushPlayerStateMask(ctx);
}

/**
 * 对局回合结算上报（DuelRoundResultReportReq：{1:battle_id(ulong), 2:round(可选),
 * 3:winner(胜局回合报=胜者uid), 4:battle_info(map，终局报), 5:enemy_runtime_snapshot[]}）。
 * 胜负判定（官服抓包 + 反编译双证）：带 f3 的报告 = 回合胜（winner===本人 uid → WIN）；
 * 无 f3 且带 f4 的终局报 = 负局。同一 battle_id 仅结算一次（BO3 每回合都上报）。
 * 空/不可解析上报保守按胜（不扣玩家）。响应 ACK {1:100}。
 */
function handleDuelRoundResultReport(
  ctx: ArkhubSessionHandlerContext,
  frame: ArkhubSessionFrame,
): void {
  const { state, opts } = ctx;
  let battleKey = "";
  let winner = "";
  let hasFinalInfo = false;
  try {
    const reader = new ProtoReader(frame.body);
    for (;;) {
      const tag = reader.readTag();
      if (!tag) break;
      if (tag.field === 1 && tag.wire === 0) battleKey = reader.readVarint().toString();
      else if (tag.field === 3 && tag.wire === 2) winner = reader.readString();
      else if (tag.field === 4 && tag.wire === 2) {
        hasFinalInfo = true;
        reader.readLengthDelimited();
      } else if (tag.wire === 0) reader.readVarint();
      else if (tag.wire === 2) reader.readLengthDelimited();
      else if (tag.wire === 5) reader.skip(4);
      else if (tag.wire === 1) reader.skip(8);
      else break;
    }
  } catch {
    // 解析失败 → 保守按胜（下方 win=true 缺省）
  }
  // 先回 ACK 再做结算/状态推送（先响应后推送，与其余处理器次序一致）
  ctx.send(8, frame.subID + BigInt(1), Buffer.from([0x08, GW_CODE_OK]));
  const key = battleKey || "unknown";
  if (!state.settledDuelBattles.has(key)) {
    const parseable = battleKey !== "" || winner !== "" || hasFinalInfo;
    // 结算时机与胜负（官服样本推导）：
    // - winner===本人 uid 的回合报 → 整局胜（WIN），立即结算；
    // - winner≠本人（对手赢单回合，BO3 可能翻盘）/ 无 winner 无 f4 的回合报 → 不结算，等后续；
    // - 无 winner 的终局报（仅 f4，整局没赢过）→ 负（LOSE）；
    // - 空/不可解析上报 → 保守按胜（不扣玩家）。
    const win = !parseable ? true : winner !== "" ? winner === state.uid : false;
    const shouldSettle =
      !parseable || (winner !== "" && winner === state.uid) || (winner === "" && hasFinalInfo);
    if (shouldSettle) {
      state.settledDuelBattles.add(key);
      try {
        opts.onDuelSettle?.(state.uid, win);
      } catch (e) {
        logger.warn("arkhub-gateway", `对局结算奖励处理失败: ${(e as Error).message}`);
      }
      // 去重键持久化：重连/重启后客户端重报不重复发券（键为 battle_id 字符串）
      try {
        opts.onDuelSettled?.(state.uid, key);
      } catch (e) {
        logger.warn("arkhub-gateway", `对局去重键持久化失败: ${(e as Error).message}`);
      }
      logger.info(
        "arkhub-gateway",
        `对局结算上报 battle=${battleKey || "?"} → ${win ? "WIN(15 券)" : "LOSE(7 券)"} (uid=${state.uid || "?"})`,
      );
      // 整局结束 → 清除对局战状态位并下发（状态机回闲，可再次匹配/入座）；
      // 同帧带变更后券数（WIN +15 / LOSE +7，发奖异步落盘，此处直接加增量）。
      state.stateMask &= ~ARKHUB_STATE_MASK.DUEL_BATTLE;
      pushPlayerStateMask(
        ctx,
        undefined,
        (opts.resolveCoin?.(state.uid) ?? 0) + (win ? 15 : 7),
      );
    }
  } else {
    logger.debug("arkhub-gateway", `对局结算上报 battle=${battleKey} 已结算，跳过`);
  }
}

/** 交换信息（GetAllCreatureExchangeInfoReq：{1:exchange_type}）→ f2 回显 + requests 按 hub.trade 回填 */
function handleGetAllExchangeInfo(
  ctx: ArkhubSessionHandlerContext,
  frame: ArkhubSessionFrame,
): void {
  let exchangeType = 0;
  const reader = new ProtoReader(frame.body);
  for (;;) {
    const tag = reader.readTag();
    if (!tag || tag.wire !== 0) break;
    const v = Number(reader.readVarint());
    if (tag.field === 1) exchangeType = v;
  }
  let trade: { wantSpecies: number; offeringUniqueId: number; ts: number } | undefined;
  try {
    trade = ctx.opts.resolveTrade?.(ctx.state.uid);
  } catch (e) {
    logger.warn("arkhub-gateway", `交换挂单读取失败: ${(e as Error).message}`);
  }
  logger.info(
    "arkhub-gateway",
    `交换信息查询 type=${exchangeType} 挂单=${trade ? `want ${trade.wantSpecies}` : "无"} → 回显 (uid=${ctx.state.uid || "?"})`,
  );
  ctx.send(
    8,
    (frame.subID & ~0xffffffffn) | GW_GET_ALL_EXCHANGE_INFO_RESP,
    buildExchangeInfoResp(exchangeType, trade, ctx.state.uid),
  );
}

/**
 * 预设交换（PresetCreatureExchangeReq：{1:creature_wanting(种类 numId),
 * 2:creature_giving(个体 unique_id)}，抓包实锤 `08f29401 1004`）→ onTradePreset
 * （arkhubSetTrade 落 ARK_HUB.trade）+ ACK（无官服响应样本，保持现状形状）。
 */
function handlePresetExchange(ctx: ArkhubSessionHandlerContext, frame: ArkhubSessionFrame): void {
  let wanting = 0;
  let giving = 0;
  const reader = new ProtoReader(frame.body);
  for (;;) {
    const tag = reader.readTag();
    if (!tag || tag.wire !== 0) break;
    const v = Number(reader.readVarint());
    if (tag.field === 1) wanting = v;
    else if (tag.field === 2) giving = v;
  }
  logger.info(
    "arkhub-gateway",
    `预设交换 want=${wanting} giving=${giving} (uid=${ctx.state.uid || "?"})`,
  );
  try {
    ctx.opts.onTradePreset?.(ctx.state.uid, wanting, giving);
  } catch (e) {
    logger.warn("arkhub-gateway", `交换预设处理失败: ${(e as Error).message}`);
  }
  ack(ctx, frame);
}

/**
 * 发起交换（CreateCreatureExchangeReq）→ onTradeCreate（任务 16 计数，arkhubDoTrade）+ ACK。
 * 无官服响应样本 → 响应形状零变更（§30.4 教训：不硬写无样本响应）。
 */
function handleCreateExchange(ctx: ArkhubSessionHandlerContext, frame: ArkhubSessionFrame): void {
  logger.info("arkhub-gateway", `发起交换 → 计数 + ACK (uid=${ctx.state.uid || "?"})`);
  try {
    ctx.opts.onTradeCreate?.(ctx.state.uid);
  } catch (e) {
    logger.warn("arkhub-gateway", `交换计数处理失败: ${(e as Error).message}`);
  }
  ack(ctx, frame);
}

/**
 * ACK 响应对显式表（low32 req → low32 resp）：适用帧在反编译字典（协议文档 §9.2/§9.3）
 * 中均**无官方 Resp 类**——官方语义大概率不响应，表内值为 subID+1 推断（私服保守兼容，
 * 客户端未观测到等待/重试；若后续抓到官服响应样本按样本修正本表）。
 * 未列入本表的未注册帧不走此兜底（由路由器 fallback 处理）。
 */
/** low32 十六进制键（与 ack() 查表键一致；由帧常量派生，不再手写字面量） */
function low32Hex(id: bigint): string {
  return (id & 0xffffffffn).toString(16).padStart(8, "0");
}

const ACK_RESP_OF: Record<string, bigint> = {
  [low32Hex(GW_CANCEL_DUEL_REQ)]: GW_CANCEL_DUEL_REQ + 1n, // CancelDuelReq
  [low32Hex(GW_ROUND_PREPARE_REQ)]: GW_ROUND_PREPARE_REQ + 1n, // RoundPrepareReq
  [low32Hex(GW_UPLOAD_BATTLE_DATA_REQ)]: GW_UPLOAD_BATTLE_DATA_REQ + 1n, // UploadBattleDataReq
  [low32Hex(GW_LOADING_FINISH_REQ)]: GW_LOADING_FINISH_REQ + 1n, // LoadingFinishReq
  [low32Hex(GW_LEAVE_DUEL_REQ)]: GW_LEAVE_DUEL_REQ + 1n, // LeaveDuelReq
  [low32Hex(GW_PRESET_EXCHANGE_REQ)]: GW_PRESET_EXCHANGE_REQ + 1n, // PresetCreatureExchangeReq
  [low32Hex(GW_CREATE_EXCHANGE_REQ)]: GW_CREATE_EXCHANGE_REQ + 1n, // CreateCreatureExchangeReq
  [low32Hex(GW_ANSWER_EXCHANGE_REQ)]: GW_ANSWER_EXCHANGE_REQ + 1n, // AnswerCreatureExchangeReq
  [low32Hex(GW_DELETE_CREATURE_REQ)]: GW_DELETE_CREATURE_REQ + 1n, // DeleteCreatureReq
  [low32Hex(GW_SET_CREATURE_LIKE_REQ)]: GW_SET_CREATURE_LIKE_REQ + 1n, // SetCreatureLikeReq
  [low32Hex(GW_SET_FOLLOWING_CREATURE_REQ)]: GW_SET_FOLLOWING_CREATURE_REQ + 1n, // SetFollowingCreatureReq
  [low32Hex(GW_SET_CREATURE_SQUAD_REQ)]: GW_SET_CREATURE_SQUAD_REQ + 1n, // SetCreatureSquadReq
};

/**
 * 服务端 fire-and-forget 请求的通用 ACK（{1:100}，响应对查 ACK_RESP_OF）。
 */
function ack(ctx: ArkhubSessionHandlerContext, frame: ArkhubSessionFrame): void {
  const lowKey = low32Hex(frame.subID);
  const respLow = ACK_RESP_OF[lowKey] ?? frame.subID + BigInt(1);
  ctx.send(8, (frame.subID & ~0xffffffffn) | respLow, Buffer.from([0x08, GW_CODE_OK]));
}

/** 交换状态广播（服务端下发）——收到仅记录日志，不回帧 */
function logOnly(ctx: ArkhubSessionHandlerContext, _frame: ArkhubSessionFrame): void {
  logger.info("arkhub-gateway", `交换状态广播 (uid=${ctx.state.uid || "?"})`);
}

/** 生物变更广播（服务端下发）——收到仅记录日志，不回帧 */
function logOnlyCreatureAlter(
  ctx: ArkhubSessionHandlerContext,
  _frame: ArkhubSessionFrame,
): void {
  logger.info("arkhub-gateway", `生物变更广播 (uid=${ctx.state.uid || "?"})`);
}

/** 注册捕捉/对局/生物/交换路由 */
export function registerPlayHandlers(router: ArkhubSessionFrameRouter): void {
  // 捕捉
  router.registerLow(8, GW_CAPTURE_INFO_REQ, "捕捉信息Req(GetCaptureInfoReq)", handleGetCaptureInfo);
  router.registerLow(8, GW_START_CAPTURE_REQ, "捕捉开始(StartCaptureReq)", handleStartCapture);
  router.registerLow(8, GW_END_CAPTURE_REQ, "捕捉结束(EndCaptureReq)", handleEndCapture);
  // 对局
  router.registerLow(8, GW_JOIN_DUEL_REQ, "对局入座(JoinDuelReq)", handleJoinDuel);
  router.registerLow(8, GW_START_DUEL_REQ, "对局开始(StartDuelReq)", handleStartDuel);
  router.registerLow(8, GW_CANCEL_DUEL_REQ, "取消对局(CancelDuelReq)", ack);
  router.registerLow(8, GW_ROUND_PREPARE_REQ, "回合准备(RoundPrepareReq)", ack);
  router.registerLow(8, GW_UPLOAD_BATTLE_DATA_REQ, "战报上传(UploadBattleDataReq)", ack);
  router.registerLow(8, GW_LOADING_FINISH_REQ, "加载完成(LoadingFinishReq)", ack);
  router.registerLow(8, GW_LEAVE_DUEL_REQ, "离开对局(LeaveDuelReq)", ack);
  router.registerLow(
    8,
    GW_DUEL_ROUND_RESULT_REPORT_REQ,
    "回合结算上报(DuelRoundResultReportReq)",
    handleDuelRoundResultReport,
  );
  // 对局阶段广播（服务端下发——客户端不会主动发；log-only 覆盖 §11 全表）
  router.registerLow(8, GW_DUEL_STAGE_CHANGE_NOTIFY, "阶段广播(DuelStageChangeNotify)", logOnly);
  // 生物管理
  router.registerLow(8, GW_DELETE_CREATURE_REQ, "删除生物(DeleteCreatureReq)", ack);
  router.registerLow(8, GW_SET_CREATURE_LIKE_REQ, "生物点赞(SetCreatureLikeReq)", ack);
  router.registerLow(8, GW_SET_FOLLOWING_CREATURE_REQ, "跟随宠物(SetFollowingCreatureReq)", ack);
  router.registerLow(8, GW_SET_CREATURE_SQUAD_REQ, "生物编队(SetCreatureSquadReq)", ack);
  router.registerLow(8, GW_CREATURE_ALTER_NOTIFY, "生物变更广播(CreatureAlterNotify)", logOnlyCreatureAlter);
  // 交换
  router.registerLow(8, GW_GET_ALL_EXCHANGE_INFO_REQ, "交换信息Req(GetAllCreatureExchangeInfoReq)", handleGetAllExchangeInfo);
  router.registerLow(8, GW_PRESET_EXCHANGE_REQ, "预设交换(PresetCreatureExchangeReq)", handlePresetExchange);
  router.registerLow(8, GW_CREATE_EXCHANGE_REQ, "发起交换(CreateCreatureExchangeReq)", handleCreateExchange);
  router.registerLow(8, GW_ANSWER_EXCHANGE_REQ, "应答交换(AnswerCreatureExchangeReq)", ack);
  router.registerLow(8, GW_EXCHANGE_STATE_NOTIFY, "交换状态广播(CreatureExchangeStateNotify)", logOnly);
}
