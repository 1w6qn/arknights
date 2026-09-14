import { PlayerCharacter } from "../../kernel/model";
import { ItemBundle } from "@excel/excel";
import { PlayerDataManager } from "../../kernel/player-data-manager";
import { TypedEventEmitter } from "../../kernel/events/runtime";
import { Draft } from "mutative";
import { PlayerDataModel } from "../../kernel/playerdata";
import { PlayerBuildingDIYSolution, PlayerBuildingManufacture } from "../../kernel/playerdata";
import type { SpecialSkillContext } from "./special";
import type { MeetingRoom, PresetQueueMetaDict, TradingOrder, TradingRoom } from "./logic/ext-types";
import type {
  ConfirmMessageBoardRewardRequest,
  GainAllIntimacyRequest,
  GainAssistIntimacyRequest,
  GetDailyClueRequest,
  GetThumbnailUrlRequest,
  PutClueToTheBoardAutoRequest,
  SaveDiyPresetSolutionRequest,
  SendClueAutoRequest,
  SendEmojiRequest,
  StartInfoShareRequest,
  UpgradeSpecializationRequest,
  VisitBuildingRequest,
} from "./models";
import { registerBuildingTriggers } from "./trigger";
import { getManufactFormula, getWorkshopFormula, getBuildingConstant, getRoomPhase, getGoldRate, getManufactPhase, getDormPhase, getFurnitureInfo, getRoomMaxLevel, getManufactFormulaType, getRoomElectricity, getMeetingPhase, getHirePhase, getClueExpiredDays, getMessageLeaveBoardConst } from "@excel/building_excel";
import {
  CharBuffSource,
  roomSpeedBonus,
  controlGlobalBonus,
  charMoodCost,
  getActiveCharBuffs,
  parseVupValue,
  phaseRank,
} from "./buff";
import {
  isFormulaUnlocked,
  isDiamondStrategyUnlocked,
  FormulaUnlockCtx,
} from "./unlocks";
import {
  goldOrderDistribution,
  pickGoldCount,
  warmupSkillTier,
  WARMUP_ALPHA_HOURS,
  WARMUP_BETA_HOURS,
  WarmupActive,
} from "./trade-orders";



import { _onCharInit, dailyRefresh, _rolloverWeekSp, _recoverLabor, _infoShareReward, _meetingCreditPerVisit, _settleDormCredit, _accumulateMessageLeaveSp, _accumulateSearchCredit, _refreshInfoShare, _refreshRoomCompletionTimes, _refreshBuildingEventTs, _nextDailyBoundary, _advanceBuilding, _accrueMeeting, _accrueHire, _touchActiveRooms, sync, advance, _accrueTraining, _accrueCharAp, _accrueWarmup, _accrueFavor } from "./logic/accrue";
import { _manufactBaseCapacity, _roomCapacity, buildRoom, _canAfford, _unlockCtx, _touchMaxLevel, _roomUnlockSatisfied, _canAffordCosts, _applyCosts, _powerBalance, upgradeRoom, completeUpgradeRoom, degradeRoom, _applyBuildCost, _applyItemDelta, _applyBundles, _applyGoldDelta, upgradeSpecialization, completeUpgradeSpecialization, upgradeDiyLevel } from "./logic/construction";
import { setPrivateDormOwner, setBuildingAssist, _findRoomSlotIdByChar, _clearCharFromRooms, _charSource, _roomCharSources, _controlGlobalFor, _specialCtx, _dormBaseRecoveryPerHour, _workBaseScale, _recomputeCharScales, _controlSlot, assignChar, _pickHighestApPreset, batchChangeWorkChar, batchRestChar, _fillDormEmptySlots, cleanRoomSlot, _addFavor, gainIntimacy, gainAllIntimacy, gainAssistIntimacy, confirmPrivateDormIntimacy } from "./logic/chars";
import { _genTradingOrder, _tradeWarmupActive, _accrueTrading, _touchOrderFillGuard, _refreshTradingOrders, _settleOrderInternal, accelerateOrder, accelerateSolution, deliveryOrder, deliveryBatchOrder, deleteOrder, settleSale, changeSaleSolution, changeStrategy, buyLabor } from "./logic/trading";
import { _accrueManufacture, settleManufacture, _settleManufactureInternal, changeManufactureSolution, changeDiySolution, workshopSynthesis, _workshopChar, _workshopBonusIds, _wsBonusThreshold, _wsBonusMatches, workshopDecomposition } from "./logic/manufacture";
import { _meetingRoom, _clueFactionWeighted, getDailyClue, sendClue, sendClueAuto, receiveClueToStock, putClueToTheBoard, putClueToTheBoardAuto, takeClueFromBoard, deleteOwnClue, deleteReceiveClue, _clearBoardEntry, _refreshClueFlag, _purgeExpiredClues, _purgeAllExpiredClues, getClueBox, getClueFriendList, getInfoShareReward, getMeetingroomReward } from "./logic/meeting";
import { changeBGM, _presetQueues, _roomPresetQueue, addPresetQueue, deletePresetQueue, editPresetQueue, usePresetQueue, useOnePresetQueue, changePresetName, saveDiyPresetSolution, editLockQueue, confirmMessageBoardReward, getMessageBoardContent, getAssistReport, getInfoShareVisitorsNum, getRecentVisitors, getOthersMessageBoardContent, getThumbnailUrl, sendEmoji, startInfoShare, visitBuilding } from "./logic/misc";

/** 制造配方（`getManufactFormula` 返回类型；building_excel 未导出该类型别名，故取 ReturnType） */
type ManufactFormula = NonNullable<ReturnType<typeof getManufactFormula>>;

export class BuildingManager {
  _TRADE_FILL_INTERVAL = 3600;

  _player: PlayerDataManager;

  _trigger: TypedEventEmitter;


/**
 * 基建管理器类
 *
 * 负责游戏基建系统的所有业务逻辑，包括房间管理、干员分配、订单生产、
 * 线索系统、预设队列以及其他基建相关功能。
 * 通过 Immer 进行状态管理，所有变更通过 PlayerDataManager.update 进行。
 */
  constructor(player: PlayerDataManager, _trigger: TypedEventEmitter) {
    this._player = player;
    this._trigger = _trigger;
    // 事件订阅抽至 trigger.ts（注册顺序 refresh:daily → char:init 不变）
    registerBuildingTriggers(_trigger, this);
  }

  get boardInfo(): string[] {
    return Object.keys(
      Object.values(this._player._playerdata.building.rooms.MEETING)[0].board,
    );
  }

  get infoShare(): number {
    return Object.values(this._player._playerdata.building.rooms.MEETING)[0]
      .infoShare.ts;
  }

  get furnCnt(): number {
    return Object.keys(this._player._playerdata.building.furniture).length;
  }

  get _intimacyGain(): number {
    const perDay = getBuildingConstant("basicFavorPerDay") ?? 720;
    return Math.max(Math.round(perDay / 60), 1);
  }

  /**
   * 待派发的「产出获得」事件队列
   *
   * 修复（2026-09-09，§5.8-B12 / §6.3-24）：制造站/加工站/贸易站的产出经
   * @@_applyItemDelta@@ 直写 @@draft.inventory@@，**绕过** @@items:get@@ 事件通道 ——
   * 产出不推进勋章（@@TotalSimpleTokenCount@@ 等）与任务。此队列在各入口的 update
   * 完成后统一补发同样口径的追踪事件（只补事件、不重复入账，避免双重发放）。
   */
  _pendingGainEvents: { id: string; count: number }[] = [];

  /**
   * 派发并清空待补发的产出追踪事件（在 @@player.update@@ 之外调用）
   *
   * 与 @@InventoryManager@@ 的 @@items:get@@ 分支同口径补发三个追踪事件
   * （@@TotalSimpleTokenCount@@ / @@GotItemBeforeTime@@ / @@ActivityCoinGain@@）——
   * 物品本身已由 @@_applyItemDelta@@ 直接入账，此处**不得**再走 @@gainItem@@。
   */
  async _flushGainEvents(): Promise<void> {
    if (!this._pendingGainEvents.length) return;
    const pending = this._pendingGainEvents;
    this._pendingGainEvents = [];
    for (const it of pending) {
      if (!it.id || it.count <= 0) continue;
      await this._trigger.emit("TotalSimpleTokenCount", [
        { itemId: it.id, count: it.count },
      ]);
      await this._trigger.emit("GotItemBeforeTime", [{ itemId: it.id }]);
      await this._trigger.emit("ActivityCoinGain", [
        { itemId: it.id, count: it.count },
      ]);
    }
  }

  static _CLUE_FACTIONS = [
    "RHINE",
    "PENGUIN",
    "BLACKSTEEL",
    "URSUS",
    "GLASGOW",
    "KJERAG",
    "RHODES",
  ];

  // ↓ 内部逻辑的公有方法 ↓（分区函数模块薄委派，见 design-spec §3.4.4）
  /** 委派至 {@link _onCharInit}（logic/accrue.ts） */
  async _onCharInit(char: PlayerCharacter) : Promise<void> {
    return _onCharInit(this, char);
  }

  /** 委派至 {@link dailyRefresh}（logic/accrue.ts） */
  async dailyRefresh() {
    return dailyRefresh(this);
  }

  /** 委派至 {@link _rolloverWeekSp}（logic/accrue.ts） */
  _rolloverWeekSp(room: MeetingRoom, ts: number) : void {
    return _rolloverWeekSp(this, room, ts);
  }

  /** 委派至 {@link _recoverLabor}（logic/accrue.ts） */
  _recoverLabor(draft: Draft<PlayerDataModel>, ts: number) : void {
    return _recoverLabor(this, draft, ts);
  }

  /** 委派至 {@link _infoShareReward}（logic/accrue.ts） */
  _infoShareReward(sr: { daily?: number; search?: number } | undefined,) : number {
    return _infoShareReward(this, sr);
  }

  /** 委派至 {@link _meetingCreditPerVisit}（logic/accrue.ts） */
  _meetingCreditPerVisit(draft: Draft<PlayerDataModel>) : number {
    return _meetingCreditPerVisit(this, draft);
  }

  /** 委派至 {@link _settleDormCredit}（logic/accrue.ts） */
  _settleDormCredit(draft: Draft<PlayerDataModel>) : number {
    return _settleDormCredit(this, draft);
  }

  /** 委派至 {@link _accumulateMessageLeaveSp}（logic/accrue.ts） */
  _accumulateMessageLeaveSp(room: MeetingRoom,
    visitCount: number,) : void {
    return _accumulateMessageLeaveSp(this, room, visitCount);
  }

  /** 委派至 {@link _accumulateSearchCredit}（logic/accrue.ts） */
  _accumulateSearchCredit(draft: Draft<PlayerDataModel>,
    room: MeetingRoom,
    visitorCount: number,) : void {
    return _accumulateSearchCredit(this, draft, room, visitorCount);
  }

  /** 委派至 {@link _refreshInfoShare}（logic/accrue.ts） */
  _refreshInfoShare(draft: Draft<PlayerDataModel>) : void {
    return _refreshInfoShare(this, draft);
  }

  /** 委派至 {@link _refreshRoomCompletionTimes}（logic/accrue.ts） */
  _refreshRoomCompletionTimes(draft: Draft<PlayerDataModel>,
    ts: number,) : void {
    return _refreshRoomCompletionTimes(this, draft, ts);
  }

  /** 委派至 {@link _refreshBuildingEventTs}（logic/accrue.ts） */
  _refreshBuildingEventTs(draft: Draft<PlayerDataModel>,
    ts: number,) : void {
    return _refreshBuildingEventTs(this, draft, ts);
  }

  /** 委派至 {@link _nextDailyBoundary}（logic/accrue.ts） */
  _nextDailyBoundary(ts: number) : number {
    return _nextDailyBoundary(this, ts);
  }

  /** 委派至 {@link _advanceBuilding}（logic/accrue.ts） */
  _advanceBuilding(draft: Draft<PlayerDataModel>,
    ts: number,
    tsFloat: number = ts,) : void {
    return _advanceBuilding(this, draft, ts, tsFloat);
  }

  /** 委派至 {@link _accrueMeeting}（logic/accrue.ts） */
  _accrueMeeting(draft: Draft<PlayerDataModel>, ts: number) : void {
    return _accrueMeeting(this, draft, ts);
  }

  /** 委派至 {@link _accrueHire}（logic/accrue.ts） */
  _accrueHire(draft: Draft<PlayerDataModel>, ts: number) : void {
    return _accrueHire(this, draft, ts);
  }

  /** 委派至 {@link _touchActiveRooms}（logic/accrue.ts） */
  _touchActiveRooms(draft: Draft<PlayerDataModel>, ts: number) : void {
    return _touchActiveRooms(this, draft, ts);
  }

  /** 委派至 {@link sync}（logic/accrue.ts） */
  async sync() {
    return sync(this);
  }

  /** 委派至 {@link advance}（logic/accrue.ts） */
  async advance(seconds: number) : Promise<number> {
    return advance(this, seconds);
  }

  /** 委派至 {@link _accrueTraining}（logic/accrue.ts） */
  _accrueTraining(draft: Draft<PlayerDataModel>, ts: number) : void {
    return _accrueTraining(this, draft, ts);
  }

  /** 委派至 {@link _accrueCharAp}（logic/accrue.ts） */
  _accrueCharAp(draft: Draft<PlayerDataModel>, nowSec?: number) : void {
    return _accrueCharAp(this, draft, nowSec);
  }

  /** 委派至 {@link _accrueWarmup}（logic/accrue.ts） */
  _accrueWarmup(draft: Draft<PlayerDataModel>, ts: number) : void {
    return _accrueWarmup(this, draft, ts);
  }

  /** 委派至 {@link _accrueFavor}（logic/accrue.ts） */
  _accrueFavor(draft: Draft<PlayerDataModel>, nowSec?: number) : void {
    return _accrueFavor(this, draft, nowSec);
  }

  /** 委派至 {@link _manufactBaseCapacity}（logic/construction.ts） */
  _manufactBaseCapacity(draft: Draft<PlayerDataModel>,
    roomSlotId: string,
    room: PlayerBuildingManufacture | undefined,) : number {
    return _manufactBaseCapacity(this, draft, roomSlotId, room);
  }

  /** 委派至 {@link _roomCapacity}（logic/construction.ts） */
  _roomCapacity(draft: Draft<PlayerDataModel>,
    roomSlotId: string,
    formula: ManufactFormula | undefined,) : number {
    return _roomCapacity(this, draft, roomSlotId, formula);
  }

  /** 委派至 {@link buildRoom}（logic/construction.ts） */
  async buildRoom(args: { roomSlotId: string; roomId: string }) {
    return buildRoom(this, args);
  }

  /** 委派至 {@link _canAfford}（logic/construction.ts） */
  _canAfford(draft: Draft<PlayerDataModel>,
    buildCost?: {
      items?: { id: string; count: number; type: string }[];
      time?: number;
      labor?: number;
    },) : boolean {
    return _canAfford(this, draft, buildCost);
  }

  /** 委派至 {@link _unlockCtx}（logic/construction.ts） */
  _unlockCtx(draft: Draft<PlayerDataModel>) : FormulaUnlockCtx {
    return _unlockCtx(this, draft);
  }

  /** 委派至 {@link _touchMaxLevel}（logic/construction.ts） */
  _touchMaxLevel(draft: Draft<PlayerDataModel>,
    roomId: string,
    level: number,) : void {
    return _touchMaxLevel(this, draft, roomId, level);
  }

  /** 委派至 {@link _roomUnlockSatisfied}（logic/construction.ts） */
  _roomUnlockSatisfied(draft: Draft<PlayerDataModel>,
    condId: string | undefined,) : boolean {
    return _roomUnlockSatisfied(this, draft, condId);
  }

  /** 委派至 {@link _canAffordCosts}（logic/construction.ts） */
  _canAffordCosts(draft: Draft<PlayerDataModel>,
    costs: { id: string; count: number; type: string }[],) : boolean {
    return _canAffordCosts(this, draft, costs);
  }

  /** 委派至 {@link _applyCosts}（logic/construction.ts） */
  _applyCosts(draft: Draft<PlayerDataModel>,
    costs: { id: string; count: number; type: string }[],) : void {
    return _applyCosts(this, draft, costs);
  }

  /** 委派至 {@link _powerBalance}（logic/construction.ts） */
  _powerBalance(draft: Draft<PlayerDataModel>) : number {
    return _powerBalance(this, draft);
  }

  /** 委派至 {@link upgradeRoom}（logic/construction.ts） */
  async upgradeRoom(args: { roomSlotId: string; targetLevel: number }) {
    return upgradeRoom(this, args);
  }

  /** 委派至 {@link completeUpgradeRoom}（logic/construction.ts） */
  async completeUpgradeRoom() {
    return completeUpgradeRoom(this);
  }

  /** 委派至 {@link degradeRoom}（logic/construction.ts） */
  async degradeRoom(args: { roomSlotId: string }) {
    return degradeRoom(this, args);
  }

  /** 委派至 {@link _applyBuildCost}（logic/construction.ts） */
  _applyBuildCost(draft: Draft<PlayerDataModel>,
    buildCost?: { items?: { id: string; count: number; type: string }[]; time?: number; labor?: number },) : void {
    return _applyBuildCost(this, draft, buildCost);
  }

  /** 委派至 {@link _applyItemDelta}（logic/construction.ts） */
  _applyItemDelta(draft: Draft<PlayerDataModel>,
    itemId: string,
    delta: number,) : void {
    return _applyItemDelta(this, draft, itemId, delta);
  }

  /** 委派至 {@link _applyBundles}（logic/construction.ts） */
  _applyBundles(draft: Draft<PlayerDataModel>,
    bundles: { id?: string; count?: number }[] | null | undefined,
    sign: 1 | -1,) : void {
    return _applyBundles(this, draft, bundles, sign);
  }

  /** 委派至 {@link _applyGoldDelta}（logic/construction.ts） */
  _applyGoldDelta(draft: Draft<PlayerDataModel>, delta: number) : void {
    return _applyGoldDelta(this, draft, delta);
  }

  /** 委派至 {@link upgradeSpecialization}（logic/construction.ts） */
  async upgradeSpecialization(args: {
    charInstId: number;
    targetSkill: number;
    /** 客户端发送但服务端不读 */
    reduceTimeBd?: UpgradeSpecializationRequest["reduceTimeBd"];
  }) {
    return upgradeSpecialization(this, args);
  }

  /** 委派至 {@link completeUpgradeSpecialization}（logic/construction.ts） */
  async completeUpgradeSpecialization(args: {
    charInstId?: number;
    targetSkill?: number;
  }) {
    return completeUpgradeSpecialization(this, args);
  }

  /** 委派至 {@link upgradeDiyLevel}（logic/construction.ts） */
  async upgradeDiyLevel() {
    return upgradeDiyLevel(this);
  }

  /** 委派至 {@link setPrivateDormOwner}（logic/chars.ts） */
  async setPrivateDormOwner(args: {
    slotId: string;
    charInstId?: number;
    charInsId?: number;
  }) {
    return setPrivateDormOwner(this, args);
  }

  /** 委派至 {@link setBuildingAssist}（logic/chars.ts） */
  async setBuildingAssist(args: { type: number; charInstId: number }) {
    return setBuildingAssist(this, args);
  }

  /** 委派至 {@link _findRoomSlotIdByChar}（logic/chars.ts） */
  _findRoomSlotIdByChar(charInstId: number) : string | undefined {
    return _findRoomSlotIdByChar(this, charInstId);
  }

  /** 委派至 {@link _clearCharFromRooms}（logic/chars.ts） */
  _clearCharFromRooms(charInstIdList: number[]) : void {
    return _clearCharFromRooms(this, charInstIdList);
  }

  /** 委派至 {@link _charSource}（logic/chars.ts） */
  _charSource(draft: Draft<PlayerDataModel>,
    instId: number,) : CharBuffSource | null {
    return _charSource(this, draft, instId);
  }

  /** 委派至 {@link _roomCharSources}（logic/chars.ts） */
  _roomCharSources(draft: Draft<PlayerDataModel>,
    slot: { charInstIds?: number[] } | null | undefined,) : CharBuffSource[] {
    return _roomCharSources(this, draft, slot);
  }

  /** 委派至 {@link _controlGlobalFor}（logic/chars.ts） */
  _controlGlobalFor(draft: Draft<PlayerDataModel>,) : Record<string, number> {
    return _controlGlobalFor(this, draft);
  }

  /** 委派至 {@link _specialCtx}（logic/chars.ts） */
  _specialCtx(draft: Draft<PlayerDataModel>) : SpecialSkillContext {
    return _specialCtx(this, draft);
  }

  /** 委派至 {@link _dormBaseRecoveryPerHour}（logic/chars.ts） */
  _dormBaseRecoveryPerHour(draft: Draft<PlayerDataModel>,
    slotId: string,) : number {
    return _dormBaseRecoveryPerHour(this, draft, slotId);
  }

  /** 委派至 {@link _workBaseScale}（logic/chars.ts） */
  _workBaseScale(roomType: string) : number {
    return _workBaseScale(this, roomType);
  }

  /** 委派至 {@link _recomputeCharScales}（logic/chars.ts） */
  _recomputeCharScales(draft: Draft<PlayerDataModel>) : void {
    return _recomputeCharScales(this, draft);
  }

  /** 委派至 {@link _controlSlot}（logic/chars.ts） */
  _controlSlot(draft: Draft<PlayerDataModel>) : { charInstIds?: number[] } | null {
    return _controlSlot(this, draft);
  }

  /** 委派至 {@link assignChar}（logic/chars.ts） */
  async assignChar(args: { roomSlotId: string; charInstIdList: number[] }) {
    return assignChar(this, args);
  }

  /** 委派至 {@link _pickHighestApPreset}（logic/chars.ts） */
  _pickHighestApPreset(draft: Draft<PlayerDataModel>,
    slotId: string,) : number[] | null {
    return _pickHighestApPreset(this, draft, slotId);
  }

  /** 委派至 {@link batchChangeWorkChar}（logic/chars.ts） */
  async batchChangeWorkChar(args: {
    roomSlotId?: string;
    slotId?: string;
    charInstIdList?: number[];
    charInstIds?: number[];
    list?: number[];
  }) {
    return batchChangeWorkChar(this, args);
  }

  /** 委派至 {@link batchRestChar}（logic/chars.ts） */
  async batchRestChar(args: {
    charInstIdList?: number[];
    charInstIds?: number[];
    list?: number[];
  }) {
    return batchRestChar(this, args);
  }

  /** 委派至 {@link _fillDormEmptySlots}（logic/chars.ts） */
  _fillDormEmptySlots(draft: Draft<PlayerDataModel>) : number {
    return _fillDormEmptySlots(this, draft);
  }

  /** 委派至 {@link cleanRoomSlot}（logic/chars.ts） */
  async cleanRoomSlot(args: { roomSlotId: string }) {
    return cleanRoomSlot(this, args);
  }

  /** 委派至 {@link _addFavor}（logic/chars.ts） */
  _addFavor(draft: Draft<PlayerDataModel>,
    charInstId: number,
    gain: number,) : void {
    return _addFavor(this, draft, charInstId, gain);
  }

  /** 委派至 {@link gainIntimacy}（logic/chars.ts） */
  async gainIntimacy(args: { charInstId: number }) {
    return gainIntimacy(this, args);
  }

  /** 委派至 {@link gainAllIntimacy}（logic/chars.ts） */
  async gainAllIntimacy(args: GainAllIntimacyRequest) : Promise<{ normal: number; assist: number }> {
    return gainAllIntimacy(this, args);
  }

  /** 委派至 {@link gainAssistIntimacy}（logic/chars.ts） */
  async gainAssistIntimacy(args: GainAssistIntimacyRequest) {
    return gainAssistIntimacy(this, args);
  }

  /** 委派至 {@link confirmPrivateDormIntimacy}（logic/chars.ts） */
  async confirmPrivateDormIntimacy(args: { charInstId: number }) {
    return confirmPrivateDormIntimacy(this, args);
  }

  /** 委派至 {@link _genTradingOrder}（logic/trading.ts） */
  _genTradingOrder(draft: Draft<PlayerDataModel>, room: TradingRoom, instId: number) : void {
    return _genTradingOrder(this, draft, room, instId);
  }

  /** 委派至 {@link _tradeWarmupActive}（logic/trading.ts） */
  _tradeWarmupActive(draft: Draft<PlayerDataModel>,
    slot: { charInstIds?: number[] } | null | undefined,) : WarmupActive {
    return _tradeWarmupActive(this, draft, slot);
  }

  /** 委派至 {@link _accrueTrading}（logic/trading.ts） */
  _accrueTrading(draft: Draft<PlayerDataModel>, ts: number) : void {
    return _accrueTrading(this, draft, ts);
  }

  /** 委派至 {@link _touchOrderFillGuard}（logic/trading.ts） */
  _touchOrderFillGuard(room: TradingRoom) : void {
    return _touchOrderFillGuard(this, room);
  }

  /** 委派至 {@link _refreshTradingOrders}（logic/trading.ts） */
  _refreshTradingOrders(draft: Draft<PlayerDataModel>,
    ts: number,) : void {
    return _refreshTradingOrders(this, draft, ts);
  }

  /** 委派至 {@link _settleOrderInternal}（logic/trading.ts） */
  _settleOrderInternal(draft: Draft<PlayerDataModel>,
    stockItem: TradingOrder,) : void {
    return _settleOrderInternal(this, draft, stockItem);
  }

  /** 委派至 {@link accelerateOrder}（logic/trading.ts） */
  async accelerateOrder(args: { slotId: string; orderId: number }) {
    return accelerateOrder(this, args);
  }

  /** 委派至 {@link accelerateSolution}（logic/trading.ts） */
  async accelerateSolution(args: { slotId: string; cost?: number }) {
    return accelerateSolution(this, args);
  }

  /** 委派至 {@link deliveryOrder}（logic/trading.ts） */
  async deliveryOrder(args: { slotId: string; orderId: string | number }) {
    return deliveryOrder(this, args);
  }

  /** 委派至 {@link deliveryBatchOrder}（logic/trading.ts） */
  async deliveryBatchOrder(args: {
    slotList?: string[];
    slotIdList?: string[];
    roomSlotIdList?: string[];
    slotId?: string;
    roomSlotId?: string;
  }) : Promise<{
    [slotId: string]: ItemBundle[];
  }> {
    return deliveryBatchOrder(this, args);
  }

  /** 委派至 {@link deleteOrder}（logic/trading.ts） */
  async deleteOrder(args: { slotId: string; orderId: number }) {
    return deleteOrder(this, args);
  }

  /** 委派至 {@link settleSale}（logic/trading.ts） */
  async settleSale(args: { slotId?: string; roomSlotIdList?: string[] }) {
    return settleSale(this, args);
  }

  /** 委派至 {@link changeSaleSolution}（logic/trading.ts） */
  async changeSaleSolution(args: {
    slotId?: string;
    roomSlotId?: string;
    targetFormulaId?: string;
    solutionCount?: number;
    solution?: { strategy: string; stockLimit: number };
  }) {
    return changeSaleSolution(this, args);
  }

  /** 委派至 {@link changeStrategy}（logic/trading.ts） */
  async changeStrategy(args: { slotId: string; strategy: string }) {
    return changeStrategy(this, args);
  }

  /** 委派至 {@link buyLabor}（logic/trading.ts） */
  async buyLabor(args: { buyCount: number }) {
    return buyLabor(this, args);
  }

  /** 委派至 {@link _accrueManufacture}（logic/manufacture.ts） */
  _accrueManufacture(draft: Draft<PlayerDataModel>,
    roomSlotId: string,
    ts: number,) : void {
    return _accrueManufacture(this, draft, roomSlotId, ts);
  }

  /** 委派至 {@link settleManufacture}（logic/manufacture.ts） */
  async settleManufacture(args: { roomSlotIdList?: string[]; supplement?: number }) {
    return settleManufacture(this, args);
  }

  /** 委派至 {@link _settleManufactureInternal}（logic/manufacture.ts） */
  async _settleManufactureInternal(draft: Draft<PlayerDataModel>,
    roomSlotId: string,) {
    return _settleManufactureInternal(this, draft, roomSlotId);
  }

  /** 委派至 {@link changeManufactureSolution}（logic/manufacture.ts） */
  async changeManufactureSolution(args: {
    roomSlotId: string;
    targetFormulaId: string;
    solutionCount: number;
  }) : Promise<{ change: boolean }> {
    return changeManufactureSolution(this, args);
  }

  /** 委派至 {@link changeDiySolution}（logic/manufacture.ts） */
  async changeDiySolution(args: { roomSlotId: string; solution: PlayerBuildingDIYSolution }) {
    return changeDiySolution(this, args);
  }

  /** 委派至 {@link workshopSynthesis}（logic/manufacture.ts） */
  async workshopSynthesis(args: {
    roomSlotId?: string;
    times: number;
    formulaId?: string;
  }) {
    return workshopSynthesis(this, args);
  }

  /** 委派至 {@link _workshopChar}（logic/manufacture.ts） */
  _workshopChar(draft: Draft<PlayerDataModel>,) : { ap?: number; charId: string } | null {
    return _workshopChar(this, draft);
  }

  /** 委派至 {@link _workshopBonusIds}（logic/manufacture.ts） */
  _workshopBonusIds(draft: Draft<PlayerDataModel>,
    workshopChar: { charId: string } | null,) : string[] {
    return _workshopBonusIds(this, draft, workshopChar);
  }

  /** 委派至 {@link _wsBonusThreshold}（logic/manufacture.ts） */
  _wsBonusThreshold(bonusId: string) : number {
    return _wsBonusThreshold(this, bonusId);
  }

  /** 委派至 {@link _wsBonusMatches}（logic/manufacture.ts） */
  _wsBonusMatches(bonusId: string, formulaType: string) : boolean {
    return _wsBonusMatches(this, bonusId, formulaType);
  }

  /** 委派至 {@link workshopDecomposition}（logic/manufacture.ts） */
  async workshopDecomposition(args: {
    furnitureId?: string;
    furniId?: string;
    count?: number;
    times?: number;
  }) {
    return workshopDecomposition(this, args);
  }

  /** 委派至 {@link _meetingRoom}（logic/meeting.ts） */
  _meetingRoom() {
    return _meetingRoom(this);
  }

  /** 委派至 {@link _clueFactionWeighted}（logic/meeting.ts） */
  _clueFactionWeighted(draft: Draft<PlayerDataModel>,
    room: MeetingRoom,) : string {
    return _clueFactionWeighted(this, draft, room);
  }

  /** 委派至 {@link getDailyClue}（logic/meeting.ts） */
  async getDailyClue(args: GetDailyClueRequest) {
    return getDailyClue(this, args);
  }

  /** 委派至 {@link sendClue}（logic/meeting.ts） */
  async sendClue(args: { id?: string; clueId?: string; friendId: string }) {
    return sendClue(this, args);
  }

  /** 委派至 {@link sendClueAuto}（logic/meeting.ts） */
  async sendClueAuto(args: SendClueAutoRequest) {
    return sendClueAuto(this, args);
  }

  /** 委派至 {@link receiveClueToStock}（logic/meeting.ts） */
  async receiveClueToStock(args: { id?: string; clues?: string[] }) {
    return receiveClueToStock(this, args);
  }

  /** 委派至 {@link putClueToTheBoard}（logic/meeting.ts） */
  async putClueToTheBoard(args: { id?: string; clueId?: string }) {
    return putClueToTheBoard(this, args);
  }

  /** 委派至 {@link putClueToTheBoardAuto}（logic/meeting.ts） */
  async putClueToTheBoardAuto(args: PutClueToTheBoardAutoRequest) {
    return putClueToTheBoardAuto(this, args);
  }

  /** 委派至 {@link takeClueFromBoard}（logic/meeting.ts） */
  async takeClueFromBoard(args: { type?: string }) {
    return takeClueFromBoard(this, args);
  }

  /** 委派至 {@link deleteOwnClue}（logic/meeting.ts） */
  async deleteOwnClue(args: { id?: string; clueId?: string }) {
    return deleteOwnClue(this, args);
  }

  /** 委派至 {@link deleteReceiveClue}（logic/meeting.ts） */
  async deleteReceiveClue(args: { id?: string; clueId?: string }) {
    return deleteReceiveClue(this, args);
  }

  /** 委派至 {@link _clearBoardEntry}（logic/meeting.ts） */
  _clearBoardEntry(draft: Draft<PlayerDataModel>,
    room: MeetingRoom,
    clueId: string,) : void {
    return _clearBoardEntry(this, draft, room, clueId);
  }

  /** 委派至 {@link _refreshClueFlag}（logic/meeting.ts） */
  _refreshClueFlag(draft: Draft<PlayerDataModel>,
    room: MeetingRoom,) : void {
    return _refreshClueFlag(this, draft, room);
  }

  /** 委派至 {@link _purgeExpiredClues}（logic/meeting.ts） */
  _purgeExpiredClues(draft: Draft<PlayerDataModel>,
    room: MeetingRoom,
    ts: number,) : number {
    return _purgeExpiredClues(this, draft, room, ts);
  }

  /** 委派至 {@link _purgeAllExpiredClues}（logic/meeting.ts） */
  _purgeAllExpiredClues(draft: Draft<PlayerDataModel>, ts: number) : number {
    return _purgeAllExpiredClues(this, draft, ts);
  }

  /** 委派至 {@link getClueBox}（logic/meeting.ts） */
  async getClueBox() {
    return getClueBox(this);
  }

  /** 委派至 {@link getClueFriendList}（logic/meeting.ts） */
  async getClueFriendList() {
    return getClueFriendList(this);
  }

  /** 委派至 {@link getInfoShareReward}（logic/meeting.ts） */
  async getInfoShareReward() {
    return getInfoShareReward(this);
  }

  /** 委派至 {@link getMeetingroomReward}（logic/meeting.ts） */
  async getMeetingroomReward() {
    return getMeetingroomReward(this);
  }

  /** 委派至 {@link changeBGM}（logic/misc.ts） */
  async changeBGM(args: { musicId: string }) {
    return changeBGM(this, args);
  }

  /** 委派至 {@link _presetQueues}（logic/misc.ts） */
  _presetQueues(draft: Draft<PlayerDataModel>) : PresetQueueMetaDict {
    return _presetQueues(this, draft);
  }

  /** 委派至 {@link _roomPresetQueue}（logic/misc.ts） */
  _roomPresetQueue(draft: Draft<PlayerDataModel>,
    slotId: string,) : number[][] | null {
    return _roomPresetQueue(this, draft, slotId);
  }

  /** 委派至 {@link addPresetQueue}（logic/misc.ts） */
  async addPresetQueue(args: {
    slotId?: string;
    roomSlotId?: string;
    charInstIdList?: number[];
    presetName?: string;
  }) {
    return addPresetQueue(this, args);
  }

  /** 委派至 {@link deletePresetQueue}（logic/misc.ts） */
  async deletePresetQueue(args: {
    slotId?: string;
    roomSlotId?: string;
    index?: number;
  }) {
    return deletePresetQueue(this, args);
  }

  /** 委派至 {@link editPresetQueue}（logic/misc.ts） */
  async editPresetQueue(args: {
    slotId?: string;
    roomSlotId?: string;
    index?: number;
    queue?: number[];
    charInstIdList?: number[];
  }) {
    return editPresetQueue(this, args);
  }

  /** 委派至 {@link usePresetQueue}（logic/misc.ts） */
  async usePresetQueue(args: {
    slotId?: string;
    roomSlotId?: string;
    index?: number;
  }) {
    return usePresetQueue(this, args);
  }

  /** 委派至 {@link useOnePresetQueue}（logic/misc.ts） */
  async useOnePresetQueue(args: {
    slotId?: string;
    roomSlotId?: string;
  }) {
    return useOnePresetQueue(this, args);
  }

  /** 委派至 {@link changePresetName}（logic/misc.ts） */
  async changePresetName(args: {
    slotId?: string;
    roomSlotId?: string;
    presetName?: string;
    name?: string;
  }) {
    return changePresetName(this, args);
  }

  /** 委派至 {@link saveDiyPresetSolution}（logic/misc.ts） */
  async saveDiyPresetSolution(args: { presetName: string; solution: SaveDiyPresetSolutionRequest["solution"] }) {
    return saveDiyPresetSolution(this, args);
  }

  /** 委派至 {@link editLockQueue}（logic/misc.ts） */
  async editLockQueue(args: { slotId?: string; roomSlotId?: string; locked: boolean }) {
    return editLockQueue(this, args);
  }

  /** 委派至 {@link confirmMessageBoardReward}（logic/misc.ts） */
  async confirmMessageBoardReward(args: ConfirmMessageBoardRewardRequest) : Promise<
    { id: string; count: number; type: string }[]
  > {
    return confirmMessageBoardReward(this, args);
  }

  /** 委派至 {@link getMessageBoardContent}（logic/misc.ts） */
  async getMessageBoardContent(args: {
    uid?: string;
    friendId?: string;
  }) : Promise<{
    thisWeekVisitors: { uid: string; nickName: string; nickNumber: string }[];
    lastWeekVisitors: { uid: string; nickName: string; nickNumber: string }[];
    todayVisit: number;
    weeklyVisit: number;
    lastWeekVisit: number;
    lastWeekSpReward: number;
    lastShowTs: number;
  }> {
    return getMessageBoardContent(this, args);
  }

  /** 委派至 {@link getAssistReport}（logic/misc.ts） */
  async getAssistReport() {
    return getAssistReport(this);
  }

  /** 委派至 {@link getInfoShareVisitorsNum}（logic/misc.ts） */
  async getInfoShareVisitorsNum() {
    return getInfoShareVisitorsNum(this);
  }

  /** 委派至 {@link getRecentVisitors}（logic/misc.ts） */
  async getRecentVisitors() : Promise<{
    visitors: {
      uid: string;
      nickName: string;
      nickNumber: string;
      secretary: string;
      secretarySkinId: string;
      level: number;
      ts: number;
    }[];
  }> {
    return getRecentVisitors(this);
  }

  /** 委派至 {@link getOthersMessageBoardContent}（logic/misc.ts） */
  async getOthersMessageBoardContent(args: {
    uid?: string;
    friendId?: string;
  }) : Promise<{
    thisWeekVisitors: { uid: string; nickName: string; nickNumber: string }[];
    lastWeekVisitors: { uid: string; nickName: string; nickNumber: string }[];
    todayVisit: number;
    weeklyVisit: number;
    lastWeekVisit: number;
    lastWeekSpReward: number;
    lastShowTs: number;
  }> {
    return getOthersMessageBoardContent(this, args);
  }

  /** 委派至 {@link getThumbnailUrl}（logic/misc.ts） */
  async getThumbnailUrl(args: GetThumbnailUrlRequest) {
    return getThumbnailUrl(this, args);
  }

  /** 委派至 {@link sendEmoji}（logic/misc.ts） */
  async sendEmoji(args: SendEmojiRequest) {
    return sendEmoji(this, args);
  }

  /** 委派至 {@link startInfoShare}（logic/misc.ts） */
  async startInfoShare(args: StartInfoShareRequest) {
    return startInfoShare(this, args);
  }

  /** 委派至 {@link visitBuilding}（logic/misc.ts） */
  async visitBuilding(args: VisitBuildingRequest) {
    return visitBuilding(this, args);
  }
}
