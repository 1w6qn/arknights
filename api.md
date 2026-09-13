# DoctorateTs API 接口文档

## 概述

本文档记录了 DoctorateTs 服务器提供的所有 API 接口。所有接口均为 POST 请求，返回 JSON 格式数据。

## 基础路径

- 认证接口：`/auth`
- 游戏接口：`/`

## 通用响应格式

```json
{
  "result": 0,
  "playerDataDelta": { ... },
  "data": { ... }
}
```

- `result`: 错误码，0 表示成功
- `playerDataDelta`: 玩家数据变更（增量更新）
- `data`: 接口返回的具体数据

---

## 认证模块

### GET /auth/general/v1/server_time
获取服务器时间

**响应**:
```json
{
  "status": 0,
  "type": "A",
  "msg": "OK",
  "data": {
    "serverTime": 1700000000,
    "isHoliday": false
  }
}
```

### GET /auth/app/v1/config
获取应用配置

**响应**: 返回应用配置 JSON

### POST /auth/user/auth/v1/token_by_phone_password
通过手机号和密码获取 Token

**请求参数**:
```json
{
  "phone": "string",
  "password": "string"
}
```

**响应**:
```json
{
  "status": 0,
  "msg": "OK",
  "data": {
    "token": "string"
  }
}
```

### GET /auth/user/info/v1/basic
获取用户基本信息

**请求参数**:
- `token`: 用户 Token（URL 参数）

**响应**:
```json
{
  "status": 0,
  "msg": "OK",
  "data": {
    "hgId": "string",
    "phone": "string",
    "email": "string"
  }
}
```

### POST /auth/user/oauth2/v2/grant
OAuth2 授权

**请求参数**:
```json
{
  "token": "string"
}
```

**响应**:
```json
{
  "status": 0,
  "msg": "OK",
  "data": {
    "code": "string",
    "uid": "string"
  }
}
```

---

## 账号模块

### POST /account/login
用户登录（token 换游戏凭证 secret）

**请求参数**（参考 DoctoratePy accountLogin）:
```json
{
  "token": "string",
  "clientVersion": "string",
  "networkVersion": 0
}
```
- `token`：as 域登录/授权得到的账号 token（real 模式为 secret 或 uid，single 模式任意串）
- `clientVersion`/`networkVersion`：版本信息（私服宽松不校验）

**响应**:
```json
{
  "result": 0,
  "uid": "string",
  "secret": "string",
  "serviceLicenseVersion": 0,
  "majorVersion": "446"
}
```
- `secret`：后续所有游戏请求的请求头凭证（客户端带 `secret` 头访问 syncData 等接口）
- 错误：`{ "result": 3 }`（token 无效——记忆已经模糊，请重新输入登录信息）

### POST /account/syncData
同步用户数据

**响应**:
```json
{
  "result": 0,
  "ts": 1700000000,
  "user": { ... },
  "playerDataDelta": { ... }
}
```

### POST /account/syncStatus
同步用户状态

**响应**:
```json
{
  "ts": 1700000000,
  "result": {},
  "playerDataDelta": { ... }
}
```

### POST /account/syncPushMessage
同步推送消息

**响应**:
```json
{
  "playerDataDelta": { ... }
}
```

---

## 用户模块

### POST /user/changeSecretary
更换助理干员

**请求参数**:
```json
{
  "charInstId": 123
}
```

### POST /user/changeAvatar
更换头像

**请求参数**:
```json
{
  "avatarId": "string"
}
```

### POST /user/changeResume
修改个人简介

**请求参数**:
```json
{
  "resume": "string"
}
```

### POST /user/bindNickName
绑定昵称

**请求参数**:
```json
{
  "nickName": "string"
}
```

**响应**:
- `result: 0` - 成功
- `result: 1` - 昵称过长（超过16字符）
- `result: 2` - 包含特殊字符
- `result: 3` - 包含敏感词

### POST /user/useRenameCard
使用改名卡

**请求参数**:
```json
{
  "nickName": "string",
  "itemId": "string",
  "instId": 123
}
```

### POST /user/receiveTeamCollectionReward
领取编队收集奖励

**请求参数**:
```json
{
  "groupId": "string"
}
```

### POST /user/buyAp
购买理智

### POST /user/exchangeDiamondShard
兑换源石碎片

**请求参数**:
```json
{
  "count": 10
}
```

### POST /user/useItem
使用物品

**请求参数**:
```json
{
  "itemId": "string",
  "count": 1,
  "instId": 123
}
```

### POST /user/useItems
批量使用物品

**请求参数**:
```json
{
  "items": [
    { "itemId": "string", "cnt": 1, "instId": 123 }
  ]
}
```

### POST /user/checkIn
签到

**响应**:
```json
{
  "rewards": [...],
  "playerDataDelta": { ... }
}
```

---

## 抽卡模块

### POST /gacha/syncNormalGacha
同步公开招募状态

### POST /gacha/finishNormalGacha
完成公开招募

**请求参数**:
```json
{
  "slotId": "string"
}
```

**响应**:
```json
{
  "charGet": { ... },
  "playerDataDelta": { ... }
}
```

### POST /gacha/normalGacha
开始公开招募

**请求参数**:
```json
{
  "slotId": "string",
  "tags": [1, 2, 3]
}
```

**响应**:
```json
{
  "charGet": { ... },
  "playerDataDelta": { ... }
}
```

### POST /gacha/boostNormalGacha
加速公开招募

**请求参数**:
```json
{
  "slotId": "string"
}
```

### POST /gacha/cancelNormalGacha
取消公开招募

**请求参数**:
```json
{
  "slotId": "string"
}
```

### POST /gacha/buyRecruitSlot
购买招募栏位

**请求参数**:
```json
{
  "num": 1
}
```

### POST /gacha/refreshTags
刷新招募标签

**请求参数**:
```json
{
  "slotId": "string"
}
```

### POST /gacha/getPoolDetail
获取卡池详情

**请求参数**:
```json
{
  "poolId": "string"
}
```

**响应**:
```json
{
  "detailInfo": { ... },
  "gachaObjGroupType": 0,
  "playerDataDelta": { ... }
}
```

### POST /gacha/advancedGacha
高级抽卡（单抽）

**请求参数**:
```json
{
  "poolId": "string",
  "useTkt": 1,
  "itemId": "string"
}
```

**响应**:
```json
{
  "result": 0,
  "charGet": { ... },
  "playerDataDelta": { ... }
}
```

### POST /gacha/tenAdvancedGacha
高级抽卡（十连）

**请求参数**:
```json
{
  "poolId": "string",
  "useTkt": 1,
  "itemList": [...]
}
```

**响应**:
```json
{
  "result": 0,
  "gachaResultList": [...],
  "playerDataDelta": { ... }
}
```

---

## 角色养成模块

### POST /charBuild/setDefaultSkill
设置默认技能

**请求参数**:
```json
{
  "charInstId": 123,
  "skillIndex": 1
}
```

### POST /charBuild/upgradeChar
升级角色

**请求参数**:
```json
{
  "charInstId": 123,
  "targetLevel": 50
}
```

### POST /charBuild/evolveChar
精英化角色

**请求参数**:
```json
{
  "charInstId": 123
}
```

### POST /charBuild/lockChar
锁定角色

**请求参数**:
```json
{
  "charInstId": 123,
  "isLock": true
}
```

### POST /charBuild/sellChar
出售角色

**请求参数**:
```json
{
  "charInstIds": [123]
}
```

### POST /charBuild/boostPotential
提升潜能

**请求参数**:
```json
{
  "charInstId": 123
}
```

### POST /charBuild/upgradeSkill
升级技能

**请求参数**:
```json
{
  "charInstId": 123,
  "skillId": "string",
  "level": 7
}
```

### POST /charBuild/upgradeSpecialization
专精技能

**请求参数**:
```json
{
  "charInstId": 123,
  "skillId": "string"
}
```

### POST /charBuild/completeUpgradeSpecialization
完成技能专精

**请求参数**:
```json
{
  "charInstId": 123,
  "skillId": "string"
}
```

### POST /charBuild/changeCharSkin
更换角色皮肤

**请求参数**:
```json
{
  "charInstId": 123,
  "skinId": "string"
}
```

### POST /charBuild/changeCharTemplate
切换角色模板

**请求参数**:
```json
{
  "charInstId": 123,
  "templateId": "string"
}
```

### POST /charBuild/unlockEquipment
解锁模组

**请求参数**:
```json
{
  "charInstId": 123,
  "templateId": "string",
  "equipId": "string"
}
```

**说明**:
- 校验解锁条件：精二阶段（`unlockEvolvePhase`）、等级（`unlockLevel`）、信赖（`unlockFavors` 对应档位）。
- 消耗 `itemCost[1]` 材料；特殊模组（`hasUnlockMission`）自动播种 `playerdata.equipment.missions`
  完成态（私服无任务结算端点，任务直接完成）。
- `templateId` 空/缺省作用于基础形态，否则作用于对应模板变体（缺失自动按基础形态初始化）。
- 重复解锁 / 条件不满足返回 500（错误消息见响应体）。

### POST /charBuild/upgradeEquipment
升级模组

**请求参数**:
```json
{
  "charInstId": 123,
  "templateId": "string",
  "equipId": "string",
  "targetLevel": 2
}
```

**说明**:
- 校验模组已解锁、目标等级合法（不高于当前等级拒绝；最高等级取 `itemCost` 键最大档位，通常 3）。
- 消耗 `itemCost[当前等级+1 .. targetLevel]` 的累计材料（跳级升级正确累计多档费用）。
- 信赖门槛：升级到目标档位时校验 `unlockFavors[targetLevel]`（数值时）。

### POST /charBuild/setEquipment
装备模组

**请求参数**:
```json
{
  "charInstId": 123,
  "templateId": "string",
  "equipId": "string"
}
```

**说明**: 仅可装备已解锁（`locked == 0`）且属于该干员的模组；未解锁拒绝。

### POST /charBuild/setCharVoiceLan
设置角色语音语言

**请求参数**:
```json
{
  "charInstId": 123,
  "voiceLan": "string"
}
```

### POST /charBuild/batchSetCharVoiceLan
批量设置角色语音语言

**请求参数**:
```json
{
  "charInstIds": [123],
  "voiceLan": "string"
}
```

---

## 社交模块

### POST /social/deleteFriend
删除好友

**请求参数**:
```json
{
  "friendUid": "string"
}
```

### POST /social/sendFriendRequest
发送好友请求

**请求参数**:
```json
{
  "friendUid": "string"
}
```

### POST /social/processFriendRequest
处理好友请求

**请求参数**:
```json
{
  "friendUid": "string",
  "isAccept": true
}
```

### POST /social/searchPlayer
搜索玩家

**请求参数**:
```json
{
  "idList": ["string"]
}
```

**响应**:
```json
{
  "players": [...],
  "resultIdList": [...],
  "friendStatusList": [...],
  "playerDataDelta": { ... }
}
```

### POST /social/getSortListInfo
获取好友排序列表信息

**请求参数**:
```json
{
  "friendUids": ["string"]
}
```

### POST /social/getFriendList
获取好友列表

### POST /social/getFriendRequestList
获取好友请求列表

### POST /social/setAssistCharList
设置助战干员

**请求参数**:
```json
{
  "assistCharList": [...]
}
```

### POST /social/setFriendAlias
设置好友备注

**请求参数**:
```json
{
  "friendUid": "string",
  "alias": "string"
}
```

### POST /social/receiveSocialPoint
领取社交点数

### POST /social/setCardShowMedal
设置名片展示勋章

**请求参数**:
```json
{
  "medalIds": [...]
}
```

---

## 名片模块

### POST /businessCard/changeNameCardSkin
更换名片皮肤

**请求参数**:
```json
{
  "skinId": "string"
}
```

### POST /businessCard/changeNameCardComponent
更换名片组件

**请求参数**:
```json
{
  "componentOrder": ["string"]
}
```

### POST /businessCard/editNameCard
编辑名片

**请求参数**:
```json
{
  "birthday": { "month": 1, "day": 1 },
  "showDetail": true,
  "showBirthday": true
}
```

### POST /businessCard/getOtherPlayerNameCard
获取其他玩家名片

**请求参数**:
```json
{
  "uid": "string"
}
```

**响应**:
```json
{
  "nameCard": { ... },
  "playerDataDelta": { ... }
}
```

---

## 商店模块

### POST /shop/decomposePotentialItem
分解潜能材料

**请求参数**:
```json
{
  "charInstIds": [123]
}
```

**响应**:
```json
{
  "items": [...],
  "playerDataDelta": { ... }
}
```

### POST /shop/decomposeClassicPotentialItem
分解经典潜能材料

**请求参数**:
```json
{
  "charInstIds": [123]
}
```

### POST /shop/getGoodPurchaseState
获取商品购买状态

### POST /shop/getLowGoodList
获取低级商店商品列表

### POST /shop/getHighGoodList
获取高级商店商品列表

### POST /shop/getClassicGoodList
获取经典商店商品列表

### POST /shop/getEPGSGoodList
获取联合行动商品列表

### POST /shop/getLMTGSGoodList
获取限定商品列表

### POST /shop/getExtraGoodList
获取额外商店商品列表

### POST /shop/getREPGoodList
获取声望商店商品列表

### POST /shop/getSkinGoodList
获取皮肤商店商品列表

### POST /shop/getCashGoodList
获取现金商店商品列表

### POST /shop/getGPGoodList
获取信用商店商品列表

### POST /shop/getSocialGoodList
获取社交商店商品列表

### POST /shop/getFurniGoodList
获取家具商店商品列表

### POST /shop/buyLowGood
购买低级商店商品

**请求参数**:
```json
{
  "goodId": "string",
  "count": 1
}
```

### POST /shop/buyHighGood
购买高级商店商品

**请求参数**:
```json
{
  "goodId": "string",
  "count": 1
}
```

### POST /shop/buyExtraGood
购买额外商店商品

### POST /shop/buyCashGood
购买现金商品

### POST /shop/buyEPGSGood
购买联合行动商品

### POST /shop/buyREPGood
购买声望商品

### POST /shop/buyClassicGood
购买经典商店商品

### POST /shop/buyLMTGSGood
购买限定商品

### POST /shop/buyFurniGood
购买家具

### POST /shop/buySkinGood
购买皮肤

---

## 肉鸽模式模块

### POST /rlv2/giveUpGame
放弃肉鸽游戏

### POST /rlv2/createGame
创建肉鸽游戏

**请求参数**:
```json
{
  "theme": "string",
  "mode": "string",
  "modeGrade": 0,
  "predefinedId": "string"
}
```

### POST /rlv2/chooseInitialRelic
选择初始遗物

**请求参数**:
```json
{
  "select": "string"
}
```

### POST /rlv2/chooseInitialRecruitSet
选择初始招募组

**请求参数**:
```json
{
  "select": "string"
}
```

### POST /rlv2/activeRecruitTicket
激活招募券

**请求参数**:
```json
{
  "id": "string"
}
```

### POST /rlv2/recruitChar
招募角色

**请求参数**:
```json
{
  "ticketIndex": "string",
  "optionId": "string"
}
```

**响应**:
```json
{
  "chars": [...],
  "playerDataDelta": { ... }
}
```

### POST /rlv2/finishEvent
完成事件

### POST /rlv2/moveTo
移动到节点

**请求参数**:
```json
{
  "to": { "x": 0, "y": 0 }
}
```

### POST /rlv2/moveAndBattleStart
移动并开始战斗

**请求参数**:
```json
{
  "to": { "x": 0, "y": 0 },
  "stageId": "string",
  "squad": { ... }
}
```

### POST /rlv2/battleFinish
战斗结束

**请求参数**:
```json
{
  "battleLog": "string",
  "data": "string",
  "battleData": { ... }
}
```

### POST /rlv2/chooseBattleReward
选择战斗奖励

**请求参数**:
```json
{
  "index": 0,
  "sub": 0
}
```

### POST /rlv2/finishBattleReward
完成战斗奖励选择

### POST /rlv2/setTroopCarry
设置编队携带

**请求参数**:
```json
{
  "troopCarry": ["string"]
}
```

### POST /rlv2/loseFragment
失去碎片

**请求参数**:
```json
{
  "fragmentIndex": "string"
}
```

### POST /rlv2/useInspiration
使用灵感

**请求参数**:
```json
{
  "fragmentIndex": "string"
}
```

### POST /rlv2/setPinned
设置置顶

**请求参数**:
```json
{
  "id": "string"
}
```

---

## 肉鸽模式 · 黑流树海（rogue_6）专属接口

黑流树海使用**无相地图（GRID_ZONE）**与**零件箱（SCRAP）**两个专属模块。节点 id = `x * 100 + y`（字符串），层键为 `1000 + zoneId - 1`（误入奇境隐藏层为 `3000+`）。

所有接口响应均为 `rlv2Response` 包装：`{ playerDataDelta, rlv2: { current, outer?, pushMessage? }, ...extra }`。参数缺失时返回 `{ result: 1, ... }`（不抛 500）。

### POST /rlv2/gridZone/moveTo
网格区域移动（黑流树海的**唯一**移动入口，替代 `/rlv2/moveTo`）

**请求参数**:
```json
{
  "route": ["302", "303"]
}
```
- `route`：途经节点 id 序列（末项为终点）。为空或非数组时返回 `result: 1`
- 每格消耗 1 行动力（`stepRemain`），服务端校验可达性

**响应**:
```json
{
  "playerDataDelta": { ... },
  "rlv2": {
    "current": { "player": {}, "inventory": {}, "record": {}, "buff": {}, "map": {}, "module": {} },
    "pushMessage": [
      { "path": "rlv2NodeArrive", "payload": { "nodeType": 16 } },
      { "path": "rlv2NodeChange", "payload": { "nodeList": ["302", "303"] } }
    ]
  }
}
```
- 落地节点按类型生成事件（写入 `current.player.pending`）：战斗类 → `BATTLE`，商店类（诡意行商/秘境行商/应急助力）→ `BATTLE_SHOP`，误入奇境 → 生成隐藏层，安全的角落/得偿所愿/失与得/先行一步/狭路相逢/应急助力/险路尽头/险路小径 → `SCENE`；林间空地/曲折密道/羽瞰点 → 无事件（`state: WAIT_MOVE`）

### POST /rlv2/gridZone/moveAndBattleStart
网格区域移动并开始战斗

**请求参数**:
```json
{
  "route": ["302"],
  "stageId": "ro6_n_1_1",
  "squad": { ... }
}
```
- `route` 为空/非数组或缺 `stageId` 时返回 `result: 1`
- 响应 `rlv2.outer` 仅含 `record` 节（官服抓包校准）

### POST /rlv2/gridZone/emptyStep
网格区域空步（原地消耗 1 行动力）

**请求参数**: 无

### POST /rlv2/gridZone/readStepZero
行动力耗尽提示已读（`stepRemain` 归零时客户端上报）

**请求参数**: 无

### POST /rlv2/scrap
拉取零件箱状态

**请求参数**: 无

### POST /rlv2/scrap/changeVehicle
切换载具（加工品 = `scrapTypeData.MOVE` 型废品，可用于地图移动）

**请求参数**:
```json
{
  "scrapInstId": "s_2",
  "toWalk": 0
}
```
- `toWalk` 为真值或 `scrapInstId` 为空串时切回步行（亦兼容旧字段名 `scrapId`）

### POST /rlv2/scrap/loseScrap
丢弃废品

**请求参数**:
```json
{
  "instId": "s_2"
}
```
- 缺 `instId` 时返回 `result: 1`（原实现静默无效果）
- 丢弃的若是当前载具，服务端自动切回步行
- 在行商节点丢弃非载具废品会计入「多边贸易」（`shop_recycle_reward`）

### POST /rlv2/scrap/identify
废品鉴定（抽取 `count` 件废品入零件箱，`count` 限制 1~3）

**请求参数**:
```json
{
  "count": 3
}
```

**响应**（`scrap` / `legacy` 在响应**顶层**，均为物品 bundle 数组）:
```json
{
  "scrap": [ { "id": "rogue_6_scrap_G_01", "count": 1 } ],
  "legacy": [ { "id": "rogue_6_legacy_1", "count": 1 } ],
  "playerDataDelta": { ... },
  "rlv2": { ... }
}
```
- `legacy` 件数 = `floor(count / 2)`（LEGACY 型物品，下次探索开局加成）
- 入箱废品的 `value` 取官方 `goodsScrapData/moveScrapData/passiveScrapData` 的 `sellPrice`（非固定 1）
- 废品类型：`MOVE` = 加工品、`GOODS` = 自然物、`PASSIVE` = 概念体

---

## 基建模块

### POST /building/sync
同步基建数据

### POST /building/upgradeRoom
升级房间

**请求参数**:
```json
{
  "roomId": "string"
}
```

### POST /building/completeUpgradeRoom
完成房间升级

### POST /building/settleManufacture
结算制造站

**请求参数**:
```json
{
  "roomId": "string"
}
```

### POST /building/buildRoom
建造房间

**请求参数**:
```json
{
  "roomType": "string",
  "roomId": "string"
}
```

### POST /building/cleanRoomSlot
清理房间槽位

**请求参数**:
```json
{
  "roomSlotId": "string"
}
```

### POST /building/visitBuilding
访问基建

### POST /building/changeManufactureSolution
更换制造配方

**请求参数**:
```json
{
  "roomId": "string",
  "formulaId": "string"
}
```

### POST /building/changeSaleSolution
更换贸易配方

**请求参数**:
```json
{
  "roomId": "string",
  "formulaId": "string"
}
```

### POST /building/assignChar
分配干员

**请求参数**:
```json
{
  "roomSlotId": "string",
  "charInstId": 123
}
```

### POST /building/settleSale
结算贸易站

**请求参数**:
```json
{
  "roomId": "string"
}
```

### POST /building/deliveryOrder
交付订单

**请求参数**:
```json
{
  "roomId": "string",
  "orderId": "string"
}
```

### POST /building/changeStrategy
更换策略

**请求参数**:
```json
{
  "roomId": "string",
  "strategy": "string"
}
```

---

## 任务模块

### POST /mission/exchangeMissionRewards
兑换任务奖励

**请求参数**:
```json
{
  "missionGroupId": "string"
}
```

### POST /mission/confirmMission
确认任务完成

**请求参数**:
```json
{
  "missionId": "string"
}
```

### POST /mission/confirmMissionGroup
确认任务组完成

**请求参数**:
```json
{
  "missionGroupId": "string"
}
```

### POST /mission/autoConfirmMissions
自动确认所有已完成任务

---

## 邮件模块

### POST /mail/listMailBox
获取邮件列表

### POST /mail/receiveMail
领取邮件

**请求参数**:
```json
{
  "mailId": "string"
}
```

### POST /mail/receiveAllMail
领取所有邮件

### POST /mail/removeAllReceivedMail
删除所有已领取邮件

---

## 活动模块

### POST /activity/getChainLogInReward
获取连续登录奖励

**请求参数**:
```json
{
  "index": 0
}
```

### POST /activity/getOpenServerCheckInReward
获取开服签到奖励

**请求参数**:
```json
{
  "index": 0
}
```

---

## 角色轮换模块

### POST /charRotation/setCurrent
设置当前轮换

**请求参数**:
```json
{
  "presetId": "string"
}
```

### POST /charRotation/createPreset
创建轮换预设

**请求参数**:
```json
{
  "name": "string",
  "background": "string",
  "homeTheme": "string",
  "profile": "string",
  "slots": [...]
}
```

### POST /charRotation/updatePreset
更新轮换预设

**请求参数**:
```json
{
  "presetId": "string",
  "name": "string",
  "slots": [...]
}
```

### POST /charRotation/deletePreset
删除轮换预设

**请求参数**:
```json
{
  "presetId": "string"
}
```

---

## 故事回顾模块

### POST /storyreview/unlockStoryByCoin
使用金币解锁故事

**请求参数**:
```json
{
  "groupId": "string"
}
```

### POST /storyreview/readStory
标记故事已读

**请求参数**:
```json
{
  "storyId": "string"
}
```

### POST /storyreview/rewardGroup
领取故事奖励

**请求参数**:
```json
{
  "groupId": "string"
}
```

---

## 资源文件模块

### GET /assetbundle/official/Android/assets/:assetsHash/:fileName
获取资源文件

**路径参数**:
- `assetsHash`: 资源哈希
- `fileName`: 文件名

**响应**: 返回资源文件二进制数据

**mod 资源下发**（`config.assets.enableMods: true` 时生效）:
- `mods/*.dat`（zip 包，条目名 = mod 名，如 `activity/[uc]act5fun.ab`）在
  `GET /assetbundle/.../hot_update_list.json` 时被解析并注入 `abInfos`（新增 mod 条目），
  客户端按清单拉取对应 `.dat`（`/`→`_`、`#`→`__`、去扩展名 + `.dat` 的命名约定）。
- 版本接口（`/config/prod/official/{Android|:version}/version`）在启用 mod 时返回带
  确定性后缀的 `resVersion`（mod 集合指纹，不变则稳定），触发热更清单重新拉取。
- mods 目录缺失/`.dat` 损坏自动跳过，不影响正常资源服务。
- 打包工具：`pnpm run pack:mod -- --dir <ArkUnpacker 解包目录>`。

---

## 配置模块

### GET /config/prod
获取生产环境配置

**响应**: 返回生产环境配置 JSON

---

## 管理 API（/admin/*）

管理后台接口，前缀 `/admin`，与游戏协议分离。

**认证**：请求头 `X-Admin-Token: <token>` 或 `Authorization: Bearer <token>`
**前置**：`data/config.json` 中 `admin.enable=true`，token 为 `admin.token` 值

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/admin/api/status` | 服务器状态（端口/离线模式/版本/用户数/数据文件） |
| GET  | `/admin/api/users?filter=` | 用户列表（`filter` 按 uid/昵称/手机号过滤） |
| GET  | `/admin/api/users/:uid` | 用户详情（资源/道具摘要，含中文名 `inventoryInfo`） |
| POST | `/admin/api/users` | 创建用户 `{phone, password}` |
| POST | `/admin/api/users/:uid/grant` | 发放物品 `{itemId, count}`（支持中文名/别名） |
| POST | `/admin/api/users/:uid/grantchar` | 发放干员 `{charId}`（支持中文名；重复按稀有度折算信物） |
| POST | `/admin/api/users/:uid/grantskin` | 解锁皮肤 `{skinId}` |
| GET  | `/admin/api/users/:uid/chars` | 干员列表（含中文名/星级/最大等级） |
| POST | `/admin/api/users/:uid/chars` | 修改干员属性 `{instId, level?, evolvePhase?, potentialRank?, mainSkillLvl?}`（免费路径，越界钳制） |
| POST | `/admin/api/users/:uid/maxout` | 一键满配（资源/背包/干员/基建/皮肤，不覆盖阵容） |
| POST | `/admin/api/users/:uid/building-max` | 基建满级 |
| POST | `/admin/api/users/:uid/backup` | 备份存档 → `{name, size}` |
| GET  | `/admin/api/users/:uid/backups` | 备份列表（按时间倒序） |
| POST | `/admin/api/users/:uid/restore` | 从备份恢复 `{backup}`（文件名白名单防路径穿越） |
| GET  | `/admin/api/users/:uid/raw` | 完整玩家数据 JSON（只读） |
| GET  | `/admin/api/users/:uid/mails` | 用户邮件列表（附件带中文名） |
| DELETE | `/admin/api/users/:uid/mails/:mailId` | 删除单封邮件 |
| POST | `/admin/api/mail` | 发送邮件 `{uid, subject, content, items:[{id, count}]}` |
| POST | `/admin/api/mail/all` | 群发邮件（全部用户）`{subject, content, items}` |
| POST | `/admin/api/users/:uid/refresh` | 触发每日/每周刷新（理智/任务重置） |
| POST | `/admin/api/users/:uid/save` | 立即保存存档 |
| GET  | `/admin/api/stats` | 统计聚合（等级/注册分布、资源合计） |
| GET  | `/admin/api/logs?limit=N` | 管理操作审计日志（默认 50 条） |
| GET  | `/admin/api/common-items` | 常用物品别名表 |
| GET  | `/admin/api/pools` | 卡池清单（poolId/名称/规则类型/开闭池/保底） |
| GET  | `/admin/api/pools/:poolId` | 卡池详情（UP/可用干员 + 概率） |
| GET  | `/admin/api/users/:uid/pools/:poolId` | 玩家卡池状态（UP 选择 + 保底计数） |
| POST | `/admin/api/users/:uid/pools/:poolId/up` | 设置玩家 UP `{charIds}`（空数组清除；支持中文名） |
| POST | `/admin/api/users/:uid/pity` | 设置玩家保底 `{ruleType, count}`（保底按 gachaRuleType 存账号配置） |
| POST | `/admin/api/official/migrate` | 官服账号迁移 `{accounts, templateUid?}`（联网拉取官服数据→注册私服账号；成功自动热加载，逐账号返回结果） |
| POST | `/admin/api/official/action` | 官服操作 `{phone, pwd, action}`：登录官服执行 status/signin/mails/receive/daily（无状态会话即用即弃） |
| POST | `/admin/api/official/call` | 官服通用 API 调用 `{phone, pwd, cgi, body?}`：登录后调任意官方接口，返回完整响应 |
| POST | `/admin/api/users/:uid/grant-all` | 批量发放全部 ItemTable 物品 `{count?}`（默认 999） |
| POST | `/admin/api/users/:uid/maxchars` | 批量拉满全部已有干员（精二满级/满潜/满技能/专三/满信赖/装备） |
| GET  | `/admin/api/users/:uid/stages` | 玩家推图进度（只读：已解锁/已完成关卡） |
| POST | `/admin/api/users/:uid/stages/unlock` | 解锁指定关卡 `{stageId}`（标记已完成） |
| POST | `/admin/api/users/:uid/stages/unlock-all` | 推图全解锁（遍历 StageTable，跳过已有进度） |
| GET  | `/admin/api/items?q=&limit=` | 物品搜索（按 ID/中文名过滤 ItemTable，供发放选择） |
| GET  | `/admin/api/users/:uid/missions` | 任务进度统计（只读：各组任务数/已完成数） |
| GET  | `/admin/api/users/:uid/medals` | 勋章进度（只读：已解锁/总数） |
| POST | `/admin/api/users/:uid/export` | 导出存档 `{path?}`（默认 `./exports/{uid}-{ts}.json`） |
| POST | `/admin/api/import` | 导入存档 `{filePath, uid?}`（替换指定 uid；uid 缺省取文件内 status.uid） |
| GET  | `/admin/api/check` | 数据完整性校验（已加载用户 status/troop/可序列化） |
| GET  | `/admin/api/openapi.json` | OpenAPI 3.0 规范（管理 API，供外部工具/Swagger 消费） |
| GET  | `/admin/api/spec` | 管理 API 端点规范清单（Dashboard「接口」控制台数据源） |
| POST | `/admin/api/game-proxy` | 游戏协议代理：`{uid, path, method?, body?}` 以玩家 secret 调用游戏端点，返回 `{status, data, uid}`（供 Dashboard 协议调试） |
| GET  | `/admin/api/activity/list` | 活动列表 + 开关状态（当前冻结时间戳/生效时间戳/各活动窗口与 open，activity 切换用） |
| POST | `/admin/api/activity/switch` | 切换活动：冻结客户端可见服务器时间戳 `{timestamp}`（-1 恢复真实时间；数值仅限过去时间，未来拒绝）；持久化 data/config.json 并重跑已加载玩家活动播种 |
| GET  | `/admin/api/config` | 查看配置（只读） |
| GET  | `/admin/dashboard` | Dashboard 管理页面（免认证，登录在页面内完成） |

### 统一抓包管理（/admin/api/capture/*）

所有抓包来源（私服 / `--capture` 官服转发 / 独立代理 proxy-harness / arkhub 网关 / 官服操作 official-ops）统一写入 `tmp/capture/`（SQLite 索引 `index.db` + `records/{rid}/` body 文件），经以下 API 查询与管理（Dashboard「抓包」Tab 使用）。

**认证**：同管理 API（`X-Admin-Token` 头或 `?token=` 查询参数——SSE EventSource 场景）。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/admin/api/capture/sessions` | 抓包会话列表（含记录数；最新在前） |
| POST | `/admin/api/capture/sessions` | 新建会话 `{name, source?, note?}`（source: private/official/harness/gateway/ops） |
| POST | `/admin/api/capture/sessions/:id/stop` | 停止会话 |
| DELETE | `/admin/api/capture/sessions/:id` | 删除会话（级联删除其全部记录与 body 目录） |
| GET  | `/admin/api/capture/records?sessionId=&source=&method=&path=&module=&endpoint=&status=&direction=&from=&to=&q=&limit=&offset=` | 抓包记录列表（过滤 + 分页，倒序；`q` 搜路径/模块/接口） |
| GET  | `/admin/api/capture/records/:id` | 记录详情（请求/响应头 + body：JSON 解析为对象，二进制为 `{base64, size, hexPreview}`；缺失文件列入 `missingFiles`） |
| DELETE | `/admin/api/capture/records/:id` | 删除单条记录 |
| POST | `/admin/api/capture/clear` | 清空全部 `{confirmWord:"CLEAR"}` |
| GET  | `/admin/api/capture/stats` | 统计（总数/来源/状态码/按天） |
| GET  | `/admin/api/capture/sessions/:id/export` | 导出会话 zip（index.json + 各记录 meta 与 body） |
| GET  | `/admin/api/capture/records/:id/export` | 导出单条记录 zip |
| GET  | `/admin/api/capture/stream?token=` | 抓包实时流（SSE：回填最近 50 条后直播新记录；`event: record`，`data: {type, record}`） |

### 统一日志管理（/admin/api/logs/*）

服务器日志（`logs/server-YYYYMMDD.log`）/ 审计日志（`data/admin/logs.jsonl`）/ 看门狗日志（`logs/watchdog-*.log`）统一查看与实时尾随（Dashboard「日志」Tab 使用）。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/admin/api/logs/server?date=&level=&tag=&q=&limit=&offset=` | 服务器日志（倒序分页；date 为 YYYYMMDD，缺省当天；level: DEBUG/INFO/WARN/ERROR） |
| GET  | `/admin/api/logs/server/dates` | 服务器日志可用日期列表（倒序） |
| GET  | `/admin/api/logs/watchdog` | 看门狗日志（文件列表 + 行，最新在前） |
| GET  | `/admin/api/logs/audit?action=&uid=&q=&limit=` | 审计日志（兼容旧 `GET /api/logs`） |
| POST | `/admin/api/logs/server/clear` | 清空服务器日志 `{confirmWord:"CLEAR"}` |
| GET  | `/admin/api/logs/stream?kind=server\|audit\|capture&token=` | 日志实时流（SSE：回填最近 50 条后直播；`event: log`/`event: record`） |

---

## OBS 移植端点（2026-08-08）

以下端点从 `reference/OpenBachelorS-master` 移植，参考对应 bp 蓝图实现（响应体以 OBS 为基准，简化为私服可用形式）。

> **现状（2026-09-13 复核）**：参考目录 `reference/OpenBachelorS-master/` 与当时的比对脚本 `scripts/_diff-routes.py`
> **都已不在工作区**（`_diff-routes.py` 的挂载前缀是硬编码的，模块拆分后会产生假阴性）。参考包现保留为
> `reference/obs/OpenBachelorS-master.zip`（需 python `zipfile` 抽，本机无 unzip/7z）。
> 挂载感知的差集工具已重建为 `pnpm run routes:diff`（`scripts/route-diff.ts`：从 `app/game/routes.ts`
> 声明式路由表 + `app/server.ts` 的 `app.use` 现场推导挂载前缀，并处理 `for...of` 数组注册、URL 重写别名、
> 路径参数通配与大小写不敏感）。当前结果：OBS 265 条路径**全部覆盖（0 缺口）**——
> 原先疑似缺口的 `/shop/getRepGoodList` 实为本仓 `/shop/getREPGoodList`（Express 大小写不敏感），
> `/sandboxPerm/sandboxV2/racing/battleStart|battleFinish` 已补别名路由（`sandbox/routes.ts` 的
> `/v2/racing/battleStart|battleFinish`，同为 202 stub）。
> 该工具仅作静态近似，新增 `rewrite` 函数或非常规注册（模板变量拼路径等）需同步其别名表/展开规则。

### 修正（原有契约对齐）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/gacha/cancelNormalGacha` | 取消公开招募（原 `cancleNormalGacha` 拼写错误已修正） |
| POST | `/mail/listMailBox` | 获取邮件列表（路由名大小写对齐；Express 匹配大小写不敏感，行为不变） |

### 新增端点

| 方法 | 路径 | 说明 | 参考 |
|------|------|------|------|
| POST | `/quest/battleContinue` | 继续战斗 stub（`result:1` + 固定 battleId） | bp_quest.py |
| POST | `/quest/finishStoryStage` | 剧情关卡结算（委托 BattleManager.finishStoryStage） | bp_quest.py |
| POST | `/quest/editStageSixStarTag` | 六星标签选择（写 `dungeon.sixStar.stages[].tagSelected`） | bp_quest.py |
| POST | `/gacha/choosePoolUp` | 选择 UP 角色（写 `gacha[gachaType][poolId].upChar`，gachaRuleType 反查） | bp_gacha.py |
| POST | `/gacha/getFreeChar` | 获取免费干员（空操作） | bp_gacha.py |
| POST | `/charBuild/changeSkinSpState` | 特勤皮肤状态（写 `skin.skinSp[skinId]`） | bp_charBuild.py |
| POST | `/social/setStarFriendList` | 星标好友列表（空实现） | bp_social.py |
| POST | `/mailCollection/getList` | 邮件收藏列表（`display_meta_table.mailArchiveData`） | bp_mail.py |
| POST | `/medal/setCustomData` | 勋章自定义数据（写 `medal.custom.customs["1"]`） | misc_bp.py |
| POST | `/gallery/saveDiyMagazineV2` | 保存自定义杂志 V2（与 V1 同 leafMap 逻辑） | misc_bp.py |
| POST | `/retro/typeAct20side/competitionStart` | 悖论模拟竞赛开始 stub | misc_bp.py |
| POST | `/retro/typeAct20side/competitionFinish` | 悖论模拟竞赛结算（固定评价结构） | misc_bp.py |
| POST | `/firework/savePlateSlots` | 烟花盘面保存（写 `firework.plate.slots`） | misc_bp.py |
| POST | `/firework/changeAnimal` | 烟花动物选择（写 `firework.animal.select`） | misc_bp.py |
| POST | `/car/confirmBattleCar` | 确认战车（写 `car.battleCar`） | misc_bp.py |
| POST | `/templateTrap/setTrapSquad` | 陷阱阵容设置（写 `templateTrap.domains[].squad`） | misc_bp.py |
| POST | `/troop/pinSpecialOperator` | 置顶特殊干员（写 `mission.pinnedSpecialOperator`） | misc_bp.py |
| POST | `/u8/user/auth/v1/agreement_version` | 用户协议版本（POST 备选调用，响应同 GET） | bp_u8.py |

> 注：`/retro/*`、`/campaignV2/*`、`/vecbreak/*` 路由沿用 DTS 既有「挂载前缀 + 路由自带前缀」设计（如 `/retro/retro/typeAct20side/competitionStart`），冒烟验证双前缀 200、单前缀 404，属既有约定。

**示例（发放物品）**:
```bash
curl -X POST http://localhost:8443/admin/api/users/1/grant \
  -H "X-Admin-Token: mytoken" -H "Content-Type: application/json" \
  -d '{"itemId":"4001","count":100}'
```

**错误码**：
- `401`：令牌无效或缺失
- `403`：管理接口未启用（admin.enable=false）
- `400`：参数非法（用户不存在、数量非正整数、手机号重复等）