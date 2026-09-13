/**
 * 肉鸽V2 数据模型（shared 公共件：玩家肉鸽存档模型 + 领域形状）
 *
 * 原 domain/rlv2/rlv2.ts 的模型区段；rlv2 模块经 re-export 保持内部引用兼容，
 * 其他模块（events 事件契约等）一律从本层取模型。
 */
import type { RoguelikeBuff } from "@excel/excel";
import type { PlayerRoguelikeV2_CurrentData_Module_SkyZoneInfo } from "@excel/types-playerdata";
import type { OrigChar, PlayerCharacter } from "./model";

/** 结算快照叶子值（brief/record 的未建模标量域） */
export type PlayerRoguelikeV2RecordLeaf = string | number | boolean | null;

/** 结算快照值：标量 / 标量数组 / 一层对象（非递归两层，Draft 安全） */
export type PlayerRoguelikeV2RecordValue =
    | PlayerRoguelikeV2RecordLeaf
    | PlayerRoguelikeV2RecordLeaf[]
    | { [key: string]: PlayerRoguelikeV2RecordLeaf | PlayerRoguelikeV2RecordLeaf[] };

/**
 * 进行中/最近一局的结算快照（`current.record`）
 *
 * 形状 = `buildSettlement` 的 `{ brief, record }`（modules/roguelike/settle.ts，仅写入）；
 * 读取侧统一走 `outer[theme].record`，故此处按「两层内联签名 + 未建模叶子」声明，
 * 避免与 settle 模块互相 import。
 */
export interface PlayerRoguelikeV2CurrentRecord {
    brief?: { [key: string]: PlayerRoguelikeV2RecordValue } | null;
    record?: { [key: string]: PlayerRoguelikeV2RecordValue | PlayerRoguelikeV2RecordValue[] } | null;
}

export interface PlayerRoguelikeV2Dungeon {
    zones: { [key: string]: PlayerRoguelikeV2Zone }
}
export interface PlayerRoguelikeV2Zone {
    id: string
    index:number
    nodes: { [key: string]: PlayerRoguelikeNode }
    variation: string[]
    type?: number
}

export interface PlayerRoguelikeNode {
    index:string
    pos: RoguelikeNodePosition
    next: RoguelikeNodeLine[]
    type: number//RoguelikeEventType
    fts?: number
    realContent?: PlayerNodeDetailContent
    attach?: string[]
    shop?: RoguelikeShop
    scenes?: PlayerRoguelikePendingEvent.SceneContent
    stage?: string
    visibility?: number//PlayerNodeForesightType（线格式 0/1/2）
    refresh?: PlayerNodeRollInfo
    zone_end?:boolean
}
export interface RoguelikeShop {
    goods: RoguelikeGoods[]
}
export interface RoguelikeGoods {
    instId: string
    itemId: string
    count: number
    priceId: string
    priceCount: number
}
export interface RoguelikeNodeLine {
    x: number
    y: number
    hidden?: string//HiddenType
    key?: boolean
}
export interface PlayerNodeDetailContent {
    scene: string
    battleShop: PlayerNodeDetailContent.BattleShop
    wish: string[]
    battle: string[]
    hasShopBoss: boolean
}
export namespace PlayerNodeDetailContent {
    export interface BattleShop {
        hasShopBoss: boolean
        goods: string[]
    }
}

export interface PlayerNodeRollInfo {
    usedCount: number
    count: number
    cost: number
}
export interface PlayerRoguelikeV2 {
    current: PlayerRoguelikeV2.CurrentData
    outer: { [key: string]: PlayerRoguelikeV2.OuterData }
    pinned?: string
}
export namespace PlayerRoguelikeV2 {
    export interface CurrentData {
        player: CurrentData.PlayerStatus | null
        record: PlayerRoguelikeV2CurrentRecord | null
        map: PlayerRoguelikeV2Dungeon | null
        inventory: CurrentData.Inventory | null
        game: CurrentData.Game | null
        troop: CurrentData.Troop | null
        buff: CurrentData.Buff | null
        module: CurrentData.Module | null
    }

    export namespace CurrentData {
        export interface Buff {
            tmpHP: number
            capsule: Capsule | null
            squadBuff: string[]
        }
        export interface Capsule {
            id: string
            ts: number
            active: boolean
        }
        export interface ExpeditionReturn {
            charList: ExpeditionReturn.Char[]
            rewards: ExpeditionReturn.Reward[]
        }
        export namespace ExpeditionReturn {
            export interface Char {
                instId: string
                isUpgrade: boolean
                isCure: boolean
            }
            export interface Reward {
                id: string
                count: number
                instId: string
            }
        }
        export interface PlayerStatus {
            state: string//PlayerRoguelikePlayerState
            property: PlayerStatus.Properties
            cursor: PlayerStatus.NodePosition
            pending: PlayerRoguelikePendingEvent[]
            trace: PlayerStatus.NodePosition[]
            status: PlayerStatus.Status;
            toEnding: string
            chgEnding: boolean
            innerMission?: PlayerStatus.InnerMission[]
            nodeMission?: PlayerStatus.NodeMission
            zoneReward?: { [key: string]: PlayerStatus.ZoneRewardItem }
            traderReturn?: { [key: string]: PlayerStatus.ZoneRewardItem }
        }
        export namespace PlayerStatus {
            export interface Properties {
                exp: number
                level: number
                maxLevel: number
                hp: Properties.Hp
                shield: number
                gold: number
                capacity: number
                population: Properties.Population
                conPerfectBattle: number
                hpShowState: string
            }
            export namespace Properties {
                export interface Hp {
                    current: number
                    max: number
                }
                export interface Population {
                    cost: number
                    max: number
                }
                //RewardHpShowStatus
            }
            export interface NodePosition {
                zone: number
                position: RoguelikeNodePosition | null
            }
            export interface Status {
                bankPut: number
            }
            export interface InnerMission {
                tmpl: string
                id: string
                progress: number[]
            }
            export interface NodeMission {
                id: string
                state: number//NodeMissionState
                tip: boolean
                progress: number[]
                buff?: number
            }
            export interface ZoneRewardItem {
                id: string
                count: number
                instId: string
            }

        }
        export interface Troop {
            chars: { [key: string]: Char }
            expedition: string[]
            expeditionDetails: { [key: string]: number/*ExpedType*/ }
            expeditionReturn: ExpeditionReturn | null
            hasExpeditionReturn: boolean
        }
        export interface Char extends Omit<PlayerCharacter, "instId"> {
            /** 对局内入队序号（官服字符串 '1','2',...——覆盖 PlayerCharacter.instId 的 number） */
            instId: string
            upgradePhase: number
            upgradeLimited: boolean
            type: string//RoguelikeCharState
            charBuff: string[]

        }
        export interface RecruitChar extends PlayerCharacter {
            type: string//RoguelikeCharState
            upgradePhase: number
            upgradeLimited: boolean
            population: number
            isUpgrade: boolean
            isCure?: boolean
            charBuff?:string[]
            troopInstId: number


        }

        export interface Game {
            uid?: string
            theme: string
            mode: string
            modeGrade: number
            equivalentGrade: number
            predefined: string|null
            difficult?: number
            outer: {
                support:boolean
                /** 上局遗留襁褓预告（官服 createGame game.outer.legacy，8-18 抓包含襁褓 id） */
                legacy?: string[]
            }
            /**
             * 本局不期而遇遭遇记录（incident.ts 写入：已出现过的场景 id，
             * 供非重复事件与 requireScene 前置条件判定）
             */
            incidentSeen?: string[]
            start: number
        }
        export interface Inventory {
            relic: { [key: string]: Relic }
            recruit: { [key: string]: Recruit }
            trap: Trap | null
            exploreTool: { [key: string]: ExploreTool }
            consumable: { [key: string]: number }
            /**
             * 暂存（留存）招募券 id 列表与上限（recruit-flow.ts 写入、incident.ts 消费；
             * 生成模型线格式键名为 stashedRecruit/stashedRecruitLimit）
             */
            stashRecruit?: string[]
            stashRecruitLimit?: number
        }
        export interface Trap {
            id: string
            ts: number
        }
        export interface ExploreTool {
            id: string
            ts: number
        }
        export interface Relic {
            index: string
            id: string
            count: number
            layer?: number
            ts: number
            used?: boolean
        }
        export interface Recruit {
            index: string
            id: string
            state: number//State
            list: RecruitChar[]
            result: RecruitChar|null
            ts: number
            from: string
            mustExtra:number
            needAssist: boolean
            assistList?: { [key: string]: FriendAssistData[] }
        }
        export interface Module {
            /**
             * 开放模块字典：各主题只出现自己的模块键（键名由 module.ts 的 _modules
             * 分发表决定），值形状由各模块管理器 toJSON 自持（4~6 层嵌套，存档内
             * 不许递归类型）——本层按「非空值」占位，读取侧需就地收窄。
             */
            [key: string]: Module.ModuleState | undefined
            san?: Module.San
            dice?: Module.Dice
            totem?: Module.Totem
            vision?: Module.Vision
            chaos?: Module.Chaos
            fragment?: Module.Fragment
            disaster?: Module.Disaster
            nodeUpgrade?: Module.NodeUpgrade
            copper?: Module.Copper
            wrath?: Module.Wrath
            sky?: Module.Sky
            gridZone?: Module.GridMapData
            scrap?: Module.GridZoneScrapInfo
            weather?: Module.Weather
        }
        export namespace Module {
            /**
             * 开放模块键的值域（各管理器 toJSON 产物，本层不建模）
             *
             * 取「非空值」占位：具名模块状态为 4~6 层嵌套对象，存档类型禁止递归形态
             * （mutative Draft 会 TS2589），故不作结构声明。
             */
            export type ModuleState = {};

            export interface San {
                sanity: number
            }
            export interface Dice {
                id: string,
                count: number
            }
            export interface InventoryTotem {
                id: string,
                instId: string,
                used: boolean,
                affix: string,
                ts: number
            }
            export interface Totem {
                totemPiece: InventoryTotem[],
                predictTotemId?: string,

            }
            export interface Vision {
                value: number,
                isMax: boolean,
            }
            export interface Chaos {
                value: number,
                level: number,
                curMaxValue: number,
                chaosList: string[]
                predict: string
                deltaChaos: ChaosZoneDelta
                lastBattleGain: number
            }
            export interface ChaosZoneDelta {
                dValue: number,
                preLevel: number
                afterLevel: number
                dChaos: string[]
            }
            export interface Fragment {
                totalWeight: number,
                limitWeight: number,
                overWeight: number,
                fragments: { [key: string]: InventoryFragment }
                troopWeights: { [key: string]: number }
                troopCarry: string[]
                sellCount?: number
                currInspiration: InventoryInspiration | null
            }
            export interface InventoryFragment {
                id: string,
                index: string,
                used: boolean,
                ts: number
                weight: number
                value: number
                price?: number
                ei:number
            }
            export interface InventoryInspiration {
                instId: string,
                id: string,
                ei?:number
            }
            export interface Disaster {
                curDisaster: string|null,
                disperseStep: number
            }
            export interface NodeUpgrade {
                nodeTypeInfoMap: { [key: string]: NodeUpgradeInfo },
            }
            export interface NodeUpgradeInfo {
                tempUpgrade: string,
                upgradeList: string[]
                currUpgradeIndex:number
            }
            export interface Copper {
                bag: { [key: string]: InventoryCopper }
                redrawCost: number
                redrawFreeze: number
                redrawFreezeCnt: number
            }
            export interface InventoryCopper {
                id: string
                isDrawn: number
                layer: number
                countDown: number
                ts: number
            }
            export interface Wrath {
                wraths: string[]
                newWrath: number
            }
            export interface Sky {
                zones: { [key: string]: PlayerRoguelikeV2_CurrentData_Module_SkyZoneInfo }
            }
            export interface GridMapData {
                zones: { [key: string]: GridMapZoneData }
                stepRemain: number
                needConfirmStepZero: boolean
            }
            export interface GridMapZoneData {
                nodes: { [key: string]: GridMapZoneNodeData }
            }
            export interface GridMapZoneNodeData {
                content: GridMapZoneNodeContentData
                state: number
                show: boolean
            }
            export interface GridMapZoneNodeContentData {
                savage?: { stageId: string }
                shop?: { goods: string[] }
            }
            export interface GridZoneScrapInfo {
                activeVehicle: { instId: string; isWalk: number }
                inventory: { [key: string]: ScrapInventoryInfo }
                limit: number
            }
            export interface ScrapInventoryInfo {
                instId: string
                id: string
                value: number
                useCnt: number
                ts: number
            }
            export interface Weather {
                currentMain: string
                currentSub: string
                eye: string
                effectArea: { [key: string]: number }
                weatherStep: number
            }
        }

    }
    export interface OuterData {
        bp: OuterData.BattlePass
        buff: OuterData.Buff
        mission: OuterData.Mission
        collect: OuterData.Collection
        bank: OuterData.Bank
        record: OuterData.Record
        monthTeam: OuterData.MonthTeam
        challenge: OuterData.Challenge
    }
    export namespace OuterData {

        export interface Record {
            last: number
            stageCnt: { [key: string]: number }
            bandCnt: { [key: string]: { [key: string]: number } }
            bandGrade: { [key: string]: { [key: string]: number } }
            /**
             * 难度通关记录（record.modeGrade[mode][grade] = 通关次数）：
             * 进阶式扩展难度解锁依据，结算时写入（见 settle.ts）
             */
            modeGrade?: { [mode: string]: { [grade: string]: number } }
            /**
             * 对局历史（官服 outer[theme].record.history，仅保留最近 100 局；
             * 结局图鉴/结局类勋章的计数来源，结算时写入）
             */
            history?: RecordHistory[]
            /** 襁褓类藏品（LEGACY：局内获得 → 下一局增益）跨局携带列表 */
            legacy?: string[]
        }

        /** 对局历史条目（record.history 元素） */
        export interface RecordHistory {
            seed: string
            bandId: string
            mode: string
            modeGrade: number
            ending: string
            failEnding: string
            result: number
            endTs: number
        }

        export interface BattlePass {
            point: number
            reward: { [key: string]: number }
        }
        export interface Mission {
            updateId: string
            refresh: number
            list: Mission.MissionSlot[]
        }
        export namespace Mission {
            export interface MissionSlot {
                type: string//RoguelikeGameMonthTaskClass
                mission: MissionItem
            }
            export interface MissionItem {
                type: string//RoguelikeGameMonthTaskClass
                id: string
                state: number
                target: number
                value: number
            }
        }

        export interface TotemCollection {
            totem: { [key: string]: Collection.ItemUnlockInfo }
            affix: { [key: string]: Collection.ItemUnlockInfo }
        }
        export interface Collection {
            band: { [key: string]: Collection.ItemUnlockInfo }
            relic: { [key: string]: Collection.ItemUnlockInfo }
            capsule: { [key: string]: Collection.ItemUnlockInfo }
            activeTool: { [key: string]: Collection.ItemUnlockInfo }
            mode: { [key: string]: Collection.ItemUnlockInfo }
            modeGrade: { [key: string]: { [key: string]: Collection.DifficultyUnlockInfo } }
            recruitSet: { [key: string]: Collection.ItemUnlockInfo }
            bgm: { [key: string]: number }
            pic: { [key: string]: number }
            chat: { [key: string]: number }
            /**
             * 聊天图鉴 V2（官方线格式键 chatV2：键 → 已解锁条目 id 列表；
             * 开局由 game-init.ensureOuterTheme 初始化为空表）
             */
            chatV2?: { [key: string]: string[] }
            /**
       * 结局图鉴（官方 CS 字段名 endBook，见 types-playerdata
       * PlayerRoguelikeV2_OuterData_Collection；此处原写作 endbook，与官服 JSON 键不一致）
       */
      endBook: { [key: string]: Collection.ItemUnlockInfo }
            buff: { [key: string]: Collection.ItemUnlockInfo }
            totem: TotemCollection
            chaos: { [key: string]: Collection.ItemUnlockInfo }
            fragment: { [key: string]: Collection.ItemUnlockInfo }
            disaster: { [key: string]: Collection.ItemUnlockInfo }
            nodeUpgrade: { [key: string]: NodeUpgradeInfo }
        }
        export namespace Collection {
            export interface ItemUnlockInfo {
                state: number
                /** 进度（服务端结算写入恒为 null，按运行时形态放宽） */
                progress: number[] | null
            }
            export interface DifficultyUnlockInfo {
                state: number
                /** 难度解锁进度（同 ItemUnlockInfo.progress，结算写入恒为 null） */
                progress?: number[] | null
            }
        }


        export interface NodeUpgradeInfo {
            unlockList: string[]
        }
        export interface Bank {
            show: boolean
            current: number
            record: number
            reward: { [key: string]: number }
            totalPut?: number
        }

        export interface Buff {
            pointOwned: number
            pointCost: number
            unlocked: { [key: string]: number }
            score: number
            /**
             * 跨局源流堆栈余数（黑流树海：每满 200 点源流样本 → 1 点演化算子，
             * 不足 200 的余数保留到后续探索；结算时写入，见 settle.ts）
             */
            sourceStack?: number
        }
        export interface MonthTeam {
            reward: { [key: string]: number }
            mission: { [key: string]: number[] }
        }
        export interface Challenge {
            reward: { [key: string]: number }
            grade: { [key: string]: number }
            collect: ChallengeCollection
        }
        export interface ChallengeCollection {
            exploreTool: { [key: string]: Collection.ItemUnlockInfo }
        }
    }

}













export interface FriendAssistData {
    orig: OrigChar
    recruit: PlayerRoguelikeV2.CurrentData.RecruitChar
}





export interface RoguelikeNodePosition {
    x: number
    y: number
}


export interface PlayerRoguelikePendingEvent {
    index: string
    type: string//PlayerRoguelikePlayerEventType
    content: PlayerRoguelikePendingEvent.Content
}
export namespace PlayerRoguelikePendingEvent {
    export interface Content {
        scene?: SceneContent
        initRecruit?: InitRecruitContent
        battle?: BattleContent
        initRelic?: InitRelicContent
        initGift?: InitGiftContent
        initRecruitSet?: InitRecruitSetContent
        initModeRelic?: InitModeRelic
        initTeam?: InitTeam
        initSupport?: InitSupport
        initExploreTool?: InitExploreTool
        battleReward?: BattleRewardContent
        recruit?: Recruit
        dice?: Dice
        shop?: ShopContent
        result?: EndingResult
        success?: number
        battleShop?: ShopContent
        sacrifice?: SacrificeContent
        detailStr?: string
        popReport?: boolean
        alchemy?: AlchemyContent
        alchemyReward?: AlchemyRewardContent
        done?: boolean
    }
    export interface BattleRewardContent {
        rewards: RoguelikeReward[]
        earn: RoguelikeStageEarn
        show: string
        state: number
        isPerfect: number
    }
    export interface BattleContent {
        state: number
        chestCnt?: number
        goldTrapCnt?: number
        tmpChar?: PlayerRoguelikeV2.CurrentData.Char[]
        unKeepBuff?: RoguelikeBuff[]
        diceRoll?: number[]
        sanity?: number
        boxInfo?: { [key: string]: number }
        isFailProtect?: boolean
        addExcludeList?: string[]
    }
    export interface InitRecruitContent {
        step: number[]
        tickets: string[]
        showChar: InitRecruitContent.ShowChar[]
        team: string|null
    }
    export namespace InitRecruitContent {
        export interface ShowChar {
            charId: string
            uniEquipIdOfChar: string
            type: string//RoguelikeCharState
        }
    }
    export interface InitRecruitSetContent {
        step: number[]
        option: string[]
    }
    export interface InitRelicContent {
        step: number[]
        items: {[key:string]:RoguelikeItemBundle}
    }

    export interface InitGiftContent {
        step: number[]
        items: RoguelikeItemBundle[]
    }
    

    export interface InitModeRelic {
        step: number[]
        items: string[]
    }
    export interface InitTeam {
        step: number[]
        chars: InitTeam.Char[]
        team: string
    }
    export namespace InitTeam {
        export interface Char {
            charId: string
            uniEquipIdOfChar: string
            type: string//RoguelikeCharState
        }
    }
    export interface InitSupport {
        step: number[]
        scene:SceneContent
    }
    export interface InitExploreTool {
        step: number[]
        items: {[key:string]:RoguelikeItemBundle}
    }
    
    export interface ChoiceAddition {
        rewards: ChoiceAddition.Reward[]
    }
    export namespace ChoiceAddition {
        export interface Reward {
            id: string
            type: string//PlayerRoguelikeChoiceRewardType
        }
    }
    export interface SceneContent {
        id: string
        choices: { [key: string]: number }
        choiceAdditional?: { [key: string]: ChoiceAddition }
        independent?: boolean
    }
    export interface Recruit {
        ticket:string
    }
    export interface Dice {
        result:Dice.Result
        rerollCount:number
    }
    export namespace Dice {
        export interface Result {
            diceEventId: string
            diceRoll: number
            mutation:MutationResult
            virtue:string[]
        }
        export interface MutationResult {
            id:string
            chars:string[]
        }
    }
    export interface ShopContent{
        bank:ShopContent.Bank
        id:string
        goods:ShopContent.Goods[]
        canBattle:boolean
        hasBoss:boolean
        showRefresh:boolean
        refreshCnt:number
        recycleGoods:ShopContent.Goods[]
        recycleCount:number
    }
    export namespace ShopContent{
        export interface Bank{
            cost:number
            open:boolean
            canPut:boolean
            canWithdraw:boolean
            withdraw:number
            withdrawLimit:number
        }
        export interface Goods{
            index:string
            itemId:string
            count:number
            priceId:string
            priceCount:number
            origCost:number
            displayPriceChg:boolean
        }

    }
    export interface SacrificeContent {
        type:number //PlayerRoguelikeSacrificeType
    }
    export interface EndingResult {
        brief:EndingBrief
        record:EndingRecord
    }
    export interface EndingBrief {
        level:number
        success:number
        ending:string
        theme:string
        mode:string
        predefined:string|null
        band:string
        startTs:number
        endTs:number
        endZoneId:string
        modeGrade:number
    }
    export interface EndingRecord {
        cntZone:number
        relicList:string[]
        capsuleList:string[]
        activeToolList:string[]
        charBuff:string[]
        squadBuff:string[]
        totemList:string[]
        exploreToolList:string[]
        fragmentList:string[]
    }
    export interface AlchemyContent {
        canAlchemy:boolean
    }
    export interface AlchemyRewardContent {
        items:RoguelikeItemBundle[]
        isSSR:boolean
        isFail:boolean
    }
}
export { RoguelikeBuff };
export interface RoguelikeItemBundle {
    sub?:number
    type?:string
    id: string
    count: number
}
export interface RoguelikeReward {
    index: number
    items: RoguelikeItemBundle[]
    done: number
    exDrop: number
    exDropSrc?: string
}
export interface RoguelikeStageEarn {
    exp: number
    populationMax: number
    squadCapacity: number
    hp: number
    shield: number
    maxHpUp: number
}
