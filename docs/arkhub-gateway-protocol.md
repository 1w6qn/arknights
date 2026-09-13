# 奇象巡展（arkhub）网关协议完全解析

> 文档对象：官服 arkhub 网关 `arkhub-gateway.hypergryph.com:30000` 的 TCP 私有协议。
> 解析器：`app/game/modules/activities/arkhub/capture/protocol.ts`；工具：`scripts/parse-arkhub-gateway.ts`（重解析抓包）、
> `scripts/dump-gateway-dict.ts`（协议字典）。
> 数据来源：capture 模式经 30000 转发器抓取的 12+ 个会话（up.bin/down.bin + parsed.json）。

## 1. 帧格式（长度前缀帧）

```
[4B 大端总长度][4B 大端消息 ID][8B 头字段][payload]
```

- **总长度**：含 4B 长度自身 + 4B 消息 ID + 8B 头 + payload（实测 up 流 3176 帧零断帧）
- **消息 ID**：见 §3 字典
- **头字段 8B**：
  - bytes 8-11（`seq`）：序列号——msgId 8 帧中变化（102326、177078 等），msgId 1 恒 0，疑请求序号
  - bytes 12-15（`flag`）：msgId 1/4 恒 0 或 4001/4002（登录请求/响应计数），msgId 8 帧中为**会话级常量**（如 0x38b31d8f，同会话恒定、跨会话变化 → 疑会话/连接 ID）
- **payload**：protobuf（msgId 4/8）或定长二进制（msgId 1/2）

## 2. 消息族（按 payload 形态）

| msgId | 方向 | 形态 | 解析 |
|---|---|---|---|
| 1 | up | 定长二进制 `[uint32 type][uint32 param]` | `{type, param}` 移动输入命令（type 0-3） |
| 2 | down | 定长二进制 `[uint32 type][uint32 param][8B]` | `{type, param, extra1, extra2}` 位置广播——**type/param 与 up msgId1 一致 = 服务器对其他玩家回显移动广播** |
| 4 | up/down | protobuf | UserLoginReq / UserLoginResp（见 §3） |
| 8 | up/down | protobuf | 位置/探针通道（见 §4） |

## 3. Login（msgId 4，字段号已实测验证）

**up = UserLoginReq**：
| 字段 | 名称 | 类型 | 样例 |
|---|---|---|---|
| 1 | uid | string | `"100566259"` |
| 2 | secret | string | `"NHa9zMxyry+..."`（token） |
| 3 | loginChannel | varint | `1` |
| 4 | deviceId | string | `"6a381486..."`（hex） |
| 5 | gameContext | string | 可选 |

**down = UserLoginResp**：
| 字段 | 名称 | 类型 | 样例 |
|---|---|---|---|
| 1 | code | varint | `100`（uid） |
| 2 | heartbeatInterval | varint | `2000`（ms） |
| 3 | reconnectToken | string | base64 JWT `eyJ1dWlkIjoi...`（内含 uuid/device_id/expire_time） |
| 4 | ip / 5 | port | varint |

重连登录变体：up 字段 2 = base64 JWT（`eyJ1dWlk...`），down 字段 1 = 101/112 等。

## 4. 位置/探针通道（msgId 8）

- **up**：`field1`(varint)=1、`field2`(varint)=256/257（探针 ID）、`field3`(len 15)=**Vector3 位置**、`field4`(varint)≈200
- **down**：`field1`(nested，~34B)=位置/探针响应、余字段为广播数据
- **15B 位置块 = protobuf Vector3（2026-08-11 破解）**：`[0x0d][f32 X][0x15][f32 Y][0x1d][f32 Z]`——
  0x0d/0x15/0x1d 即 field1/2/3 wire5(fixed32) 标签，三个 float32 为大厅坐标
  （实测 X∈[-3,12] 均值 4.1、Y∈[-0.3,1.5] 均值 0.6、Z∈[-7,9] 均值 2.3；连续帧位置平滑移动
  = 移动中的玩家）。`decodeVector3` 自动识别解码。
- 形态极多（up 151 / down 410 种）——位置与探针数据多变

## 4.1 场景 hello 响应 = EnterSceneNotify（2026-08-13 修正，解决「前往广场网络状态异常」）

**场景 hello（up subID `0x00018fb64de29cdb`）实为 EnterSceneReq**，服务端响应（down subID
`0x0002c89b38b37d3d`）是 **EnterSceneNotify**（客户端 `_HandleEnterSceneNotify` → `selfUnitInfo.Fill`），
顶层 3 个 length-delimited 字段：

| 字段 | 类型 | 内容 |
|---|---|---|
| 1 | HallInfo | `{1:unique_id, 2:map_id, 3:scene_type, 5:attributes, 6:sync_interval}`——广场 map_id=**-1520665757**（activity.ARK_HUB.sceneTypeMap → TOWN）、scene_type=200、sync_interval=200 |
| 2 | PlayerSyncData | `{1: PlayerBrief{1:uid,2:nickname,3:nicknumber}, 4: attrDoc{1:attributes[]}}`——**必须是自己的玩家条目**，缺失 → `selfUnitInfo.Fill` NPE → 30s 超时 → 客户端弹「网络状态异常」（ARKHUB_REQ_FAILED_CONTENT） |
| 3 | PlayerHallBrief | `{1: unique_id(ulong), 2: pos(Vector3)}` |

> 2026-08-13 修复（`app/game/modules/activities/arkhub/session/server.ts`）：原应答器场景帧 field2 为空、field3 形状错
> （`{1:ts,2:""}`）、登录 uid 未追踪（恒传 `""`）→ 客户端无法识别自己 → 广场进不去。现改为
> 按登录帧 field1 追踪 uid，构建合法 EnterSceneNotify；`index.ts` 传 `resolveNickname` 用玩家真实昵称。

## 5. down 登录后记录流（2026-08-11 完全破解）

登录后 down 流**并非换帧格式**——是标准帧链中**间插了少量无长度前缀的 raw wrapper**：
```
[标准帧×65][raw wrapper 2176B（PixelArtData 同步）][标准帧×6000+][raw wrapper 104B]...
```
- **完整解析**：`splitGatewayFramesFull` 跨 wrapper 续链——断点处扫描下一个合法标准帧头
  （len 16-5000 + 已知 msgId + 可续链），断点与续链点之间作为 wrapper 原样保留
- **实测**：12 个会话 down 流全部 `downRemainder: 0`（此前 10-01 会话 413255B 余量 → 现在
  6073 帧 + 3 wrapper 全部切分）；msgId 分布 8×5189 / 2×883 / 4×1
- **wrapper 内容 = PixelArtData 同步**：`{field2: md5, field4/5: ts, field7: 1,
  field1: [PixelArtInfo×N]}`——`decodePixelArtInfo` 识别 field1 元素
  （{id, 32hex Md5, createTime, updateTime, revision}，14/14 样本匹配客户端 PixelArtInfo）
- 另含 `field7`(len 78) 内嵌 `{uid, nickname}` 的玩家信息记录
- **陷阱**：`00 00 00 XX` 在 wrapper 中出现 ~1.9 万次是 protobuf 内部零字节假象，非记录边界

## 5.1 msgId 1/2 移动协议（2026-08-11 补全）

- **msgId 1 (up)**：`[uint32 type][uint32 param]`——输入命令，type 0-4（≥5 种）；
  **param 单调递增 ≈20M/事件**（疑时间戳/序号；与 msgId8 位置弱相关，具体语义待确认）
- **msgId 2 (down)**：`[uint32 type][uint32 param][uint32 extra1][uint32 extra2]`——
  位置广播，**type/param 与 up 一致 = 服务器对其他玩家回显移动广播**；
  extra1 恒定 415（疑标志），extra2 单调递增 ~2000/帧（疑序号/时间）

## 6. 已提取的网关消息类（字段名，来自 .cs）

37 类字段名已提取（UserLoginReq/Resp、EnterSceneReq/Notify、MoveReq、SyncSceneNotify、
InteractionActionReq、RolePlayingReq、SubmitAVGParam、SubmitActorOpParam、PixelArtData、
PlayerSyncData、PlayerBrief、HallInfo、TaskData 等）。**游戏玩法 SubID 精确值与
`ProtoMember(Name=...)` 参数名已从反编译源码完整还原**（见 §9/§10；此前"注册表被剥离、
字段号仅登录类实测验证"的判断不成立——`ActArkhubGamePlayProtocol.SubID` 的 `const ulong`
与各 `Data` 类的 `ProtoMember` 均被 Cpp2IL+ILSpy 保留）。

## 7. 剩余未知项（2026-08-20 收敛至 1 项）

1. msgId 1 的 type 0-4 具体命令语义（疑 MoveReq Status/Shrink/Position/Time 对应，具体待确认）

~~msgId 注册表 / 游戏玩法 SubID 精确值~~ —— **已破解：见 §9（反编译 `ActArkhubGamePlayProtocol.SubID` const ulong 完整还原）**
~~msgId 8 的 15B 位置块布局~~ —— **已破解：protobuf Vector3（field1/2/3 wire5 × f32）**
~~down 登录后记录流完整帧边界~~ —— **已破解：标准帧链 + 少量 raw wrapper（PixelArtData 同步），
splitGatewayFramesFull 跨 wrapper 续链，全部会话 downRemainder=0**

## 8. 工具用法

```bash
pnpm exec tsx scripts/parse-arkhub-gateway.ts                 # 重解析全部抓包 → parsed.json + messages.json
pnpm exec tsx scripts/parse-arkhub-gateway.ts <连接目录ID>     # 单会话
pnpm exec tsx scripts/dump-gateway-dict.ts                    # 输出协议字典（msgId×方向×形态）
```

**真实可读 request/response（messages.json）**：`gatewayTranscript` 把 up/down 帧还原为
可读消息（Login/MoveReq/Ping/Pong 命名解码），并按语义配对（Login Req→Resp、Ping→Pong）：
```json
{"name":"Login","request":{"dir":"up","msgId":4,"name":"Login","body":{"uid":"100566259","secret":"NHa9...","loginChannel":"1","deviceId":"6a38..."}},"response":{"dir":"down","msgId":4,"body":{"code":"100","heartbeatInterval":"2000","reconnectToken":"eyJ1dWlk..."}}}
```
注：帧头 8-11 为**会话 ID**（非请求序号，up/down 同值），配对仅限语义明确的 1:1 请求-响应对。

## 9. 游戏玩法 SubID 权威字典（反编译还原，2026-08-20）

> **数据来源**：`reference/arknights-2.7.61-csharp/.../Torappu.UI.ActArkhub.Server/ActArkhubGamePlayProtocol.cs`
> 中 `Base<TData>.SubID` 静态类的 `const ulong`（Cpp2IL+ILSpy 完整还原，非猜测）。
> **生成机制**：`subid = [高 32 位段前缀][低 32 位段内消息号]`，帧 `mainID` 恒为 `8`
> （段基 `MAIN_ID=8`，`Torappu.LongServiceKit.Protocol.LongServiceProtobufBase<TData>` 装配成 `NetMsgID`）。
> **路径含义**：`ActArkhubGamePlayProtocol.<MsgName> : Base<Data.MsgName>`，各消息实际业务对象
> 见 `Base<...>` 泛型实参（§10）。
>
> 客户端本地网关用**低 32 位**匹配（`subID & 0xffffffffn`），命令层只关心该段内号。

### 9.1 场景 / 输入段（前缀 `0x2c89b3`）

| 消息 | subID 完整 | 低32 | 业务对象 |
|---|---|---|---|
| MoveReq | `0x2c89b38b32a34` | `38b32a34` | Data.MoveReq |
| SyncStateNotify | `0x2c89b38b31d8f` | `38b31d8f` | StepSyncNotify |
| SyncSceneNotify | `0x2c89b38b3360a` | `38b3360a` | Data.SyncSceneNotify |
| SyncAlterDataNotify | `0x2c89b38b36462` | `38b36462` | PlayerAlterDataNotify |
| InteractWithUnitReq | `0x2c89b38b36055` | `38b36055` | InteractionActionReq |
| InteractWithUnitResp | `0x2c89b38b3d134` | `38b3d134` | InteractionActionResp |
| ForceSetPositionNotify | `0x2c89b38b3e70f` | `38b3e70f` | Data.ForceSetPositionNotify |
| SyncEnterSceneResultNotify | `0x2c89b38b37d3d` | `38b37d3d` | EnterSceneNotify |
| LeaveSceneNotify | `0x2c89b38b3a5a8` | `38b3a5a8` | Data.LeaveSceneNotify |
| OnReconnectNotify | `0x2c89b38b3f32d` | `38b3f32d` | ReconnectNotify |
| OnRelayNotify | `0x2c89b38b39689` | `38b39689` | RelayLoginNotify |
| DoRolePlayingReq | `0x2c89b38b3170a` | `38b3170a` | RolePlayingReq |
| SubmitActorOpReq | `0x2c89b38b3116d` | `38b3116d` | SubmitActorOpParam |
| SubmitActorOpResp | `0x2c89b38b38cd6` | `38b38cd6` | DefaultResult |
| GetBusinessCardReq | `0x2c89b38b322c3` | `38b322c3` | BusinessCardReq |
| GetBusinessCardResp | `0x2c89b38b3613c` | `38b3613c` | BusinessCardResp |
| UpdatePlayerSettingsReq | `0x2c89b38b36054` | `38b36054` | UpdateSettingsReq |
| UpdatePlayerSettingsResp | `0x2c89b38b3db61` | `38b3db61` | UpdateSettingsResp |
| ChangeOutlookReq | `0x2c89b38b3d83c` | `38b3d83c` | Data.ChangeOutlookReq |
| ChangeOutlookResp | `0x2c89b38b3f7a7` | `38b3f7a7` | Data.ChangeOutlookResp |
| ModifyPlayerActionReq | `0x2c89b38b39680` | `38b39680` | PlayerActionMaskReq |
| ReportPlayerActiveReq | `0x2c89b38b3ab0c` | `38b3ab0c` | PlayerActiveCountReq |
| ChangeSceneReq | `0x2c89b38b3b60b` | `38b3b60b` | Data.ChangeSceneReq |
| LogoutSceneReq | `0x2c89b38b3c3c9` | `38b3c3c9` | Data.LogoutSceneReq |

### 9.2 捕捉 / 生物 / 对决段（前缀 `0x29854b`）

| 消息 | subID 完整 | 低32 | 业务对象 |
|---|---|---|---|
| GetCaptureInfoReq | `0x29854b7c2ad8b` | `b7c2ad8b` | Data.GetCaptureInfoReq |
| GetCaptureInfoResp | `0x29854b7c2b4de` | `b7c2b4de` | Data.GetCaptureInfoResp |
| StartCaptureReq | `0x29854b7c267d7` | `b7c267d7` | Data.StartCaptureReq |
| StartCaptureResp | `0x29854b7c2b07e` | `b7c2b07e` | Data.StartCaptureResp |
| EncounterCreatureNotify | `0x29854b7c20f13` | `b7c20f13` | EncounterCreatureNotify |
| EndCaptureReq | `0x29854b7c204e8` | `b7c204e8` | Data.EndCaptureReq |
| EndCaptureResp | `0x29854b7c26451` | `b7c26451` | Data.EndCaptureResp |
| DeleteCreatureReq | `0x29854b7c264e3` | `b7c264e3` | Data.DeleteCreatureReq |
| SetCreatureLikeReq | `0x29854b7c28d19` | `b7c28d19` | Data.SetCreatureLikeReq |
| SetFollowingCreatureReq | `0x29854b7c20b13` | `b7c20b13` | Data.SetFollowingCreatureReq |
| SetCreatureSquadReq | `0x29854b7c2cbf4` | `b7c2cbf4` | Data.SetCreatureSquadReq |
| CreatureAlterNotify | `0x29854b7c2d119` | `b7c2d119` | CreatureDataAlterNotify |
| JoinDuelReq | `0x29854b7c277bf` | `b7c277bf` | Data.JoinDuelReq |
| JoinDuelResp | `0x29854b7c2a2e2` | `b7c2a2e2` | Data.JoinDuelResp |
| OnJoinDuelNotify | `0x29854b7c2ef4f` | `b7c2ef4f` | JoinDuelNotify |
| CancelDuelReq | `0x29854b7c21661` | `b7c21661` | Data.CancelDuelReq |
| CreatureExchangeStateNotify | `0x29854b7c283a3` | `b7c283a3` | Data.CreatureExchangeStateNotify |
| PresetCreatureExchangeReq | `0x29854b7c2369e` | `b7c2369e` | Data.PresetCreatureExchangeReq |
| CreateCreatureExchangeReq | `0x29854b7c2394d` | `b7c2394d` | Data.CreateCreatureExchangeReq |
| AnswerCreatureExchangeReq | `0x29854b7c2be4f` | `b7c2be4f` | Data.AnswerCreatureExchangeReq |
| GetAllCreatureExchangeInfoReq | `0x29854b7c21f3a` | `b7c21f3a` | Data.GetAllCreatureExchangeInfoReq |
| GetAllCreatureExchangeInfoResp | `0x29854b7c25f13` | `b7c25f13` | GetAllCreatureExchangeInfoRsp |

> ⚠️ 本节 `b7c2*` 是**捕捉（capture）+ 生物 + 对局（duel）**三类逻辑共用的号码段，不能都当"ARKDUEL 战斗"。

### 9.3 对局战斗参数段（前缀 `0x3e546f`）

| 消息 | subID 完整 | 低32 | 业务对象 |
|---|---|---|---|
| StartDuelReq | `0x3e546f8faa515` | `f8faa515` | BattleParam |
| StartDuelResp | `0x3e546f8fa2dce` | `f8fa2dce` | Data.StartDuelResp |
| LoadingFinishReq | `0x3e546f8faf090` | `f8faf090` | BattleParam |
| RoundPrepareReq | `0x3e546f8fa9c6e` | `f8fa9c6e` | Data.RoundPrepareReq |
| DuelRoundResultReportReq | `0x3e546f8fa293a` | `f8fa293a` | Data.DuelRoundResultReportReq |
| DuelStageChangeNotify | `0x3e546f8faf4f3` | `f8faf4f3` | Data.DuelStageChangeNotify |
| LeaveDuelReq | `0x3e546f8fad282` | `f8fad282` | Data.LeaveDuelReq |
| OnOtherPrepareChangeNotify | `0x3e546f8faf809` | `f8faf809` | RoundPrepareChangeNotify |
| UploadBattleDataReq | `0x3e546f8faab16` | `f8faab16` | Data.UploadBattleDataReq |

### 9.4 商店 / 道具段（前缀 `0x208c32`）

| 消息 | subID 完整 | 低32 | 业务对象 |
|---|---|---|---|
| GetShopInfoReq | `0x208c328f5ba6f` | `28f5ba6f` | Data.GetShopInfoReq |
| GetShopInfoResp | `0x208c328f5229c` | `28f5229c` | Data.GetShopInfoResp |
| BuyItemReq | `0x208c328f56f2c` | `28f56f2c` | BuyShopItemReq |
| BuyItemResp | `0x208c328f5568f` | `28f5568f` | BuyShopItemResp |
| UseItemReq | `0x208c328f5b1ab` | `28f5b1ab` | Data.UseItemReq |
| UseItemResp | `0x208c328f5de74` | `28f5de74` | Data.UseItemResp |

### 9.5 像素画段（前缀 `0x29ce23`）

| 消息 | subID 完整 | 低32 | 业务对象 |
|---|---|---|---|
| RequestPixelArtUploadTokenReq | `0x29ce231d603b3` | `31d603b3` | Data.RequestPixelArtUploadTokenReq |
| RequestPixelArtUploadTokenResp | `0x29ce231d60cf6` | `31d60cf6` | Data.RequestPixelArtUploadTokenResp |
| SavePixelArtReq | `0x29ce231d674d5` | `31d674d5` | Data.SavePixelArtReq |
| PublishPixelArtReq | `0x29ce231d6d615` | `31d6d615` | Data.PublishPixelArtReq |
| PublishPixelArtResp | `0x29ce231d68b8e` | `31d68b8e` | Data.PublishPixelArtResp |
| DeletePixelArtReq | `0x29ce231d6d13b` | `31d6d13b` | Data.DeletePixelArtReq |
| DeletePixelArtResp | `0x29ce231d67d3e` | `31d67d3e` | Data.DeletePixelArtResp |
| DeletePixelArtCollectionReq | `0x29ce231d65453` | `31d65453` | Data.DeletePixelArtCollectionReq |
| DeletePixelArtCollectionResp | `0x29ce231d6ea56` | `31d6ea56` | Data.DeletePixelArtCollectionResp |
| CollectPixelArtReq | `0x29ce231d61490` | `31d61490` | Data.CollectPixelArtReq |
| SetPixelArtAlbumDisplayReq | `0x29ce231d63285` | `31d63285` | Data.SetPixelArtAlbumDisplayReq |
| SetPixelArtDisplayReq | `0x29ce231d6e074` | `31d6e074` | Data.SetPixelArtDisplayReq |
| SetPixelArtNicknameVisibleReq | `0x29ce231d6ce0c` | `31d6ce0c` | Data.SetPixelArtNicknameVisibleReq |
| SetPixelArtShowDisplayReq | `0x29ce231d6f1fb` | `31d6f1fb` | Data.SetPixelArtShowDisplayReq |
| PixelArtAlterNotify | `0x29ce231d62bbd` | `31d62bbd` | PixelArtDataAlterNotify |

### 9.6 其它（通知 / 版本 / GM）

| 消息 | subID 完整 | 低32 | 业务对象 |
|---|---|---|---|
| NotifyErrorMessageNotify | `0x1ffd30009df1` | `30009df1` | ErrorCodeNotify |
| NotifyToastMessageNotify | `0x1ffd3000ee32` | `3000ee32` | ToastMessage |
| CheckVersionReq | `0x159f8a2fc3d89` | `a2fc3d89` | Data.CheckVersionReq |
| CheckVersionResp | `0x159f8a2fc79f4` | `a2fc79f4` | Data.CheckVersionResp |
| ExecGMCommandReq | `0x2b299e6ded76d` | `e6ded76d` | GMCommandReq |
| EnterSceneReq | `0x18fb64de29cdb` | `4de29cdb` | Data.EnterSceneReq |
| SyncClientLogoutNotify | `0x18fb64de28c3f` | `4de28c3f` | LogoutNotify |

> 注：帧头 8-11 为会话 ID（up/down 同值），单段内 Req/Resp 的 **SubID 各自独立值**（同报文字段，仅语义对应），
> 不存在"resp = req+1"的固定规律。登录（main=4，`UserLoginReq/Resp`、`UserReconnectReq/Resp`）不走
> GamePlay 段，见 §3/NotGameplay 注册表。

## 10. 关键消息参数名（ProtoMember，反编译还原 2026-08-20）

> 数据来源：`reference/arknights-2.7.61-csharp/.../Torappu.UI.ActArkhub.Server.Data/*.cs` 的
> `ProtoMember(N, Name = "...")`。字段号 = ProtoMember 序号，`Name` = 实际 proto 字段名。

### 场景 / 移动

**MoveReq（main8 up，`0x2c89b38b32a34`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | status | int |
| 2 | shrink | int |
| 3 | position | Vector3 |
| 4 | time | int |

> 参数实际含义：f1=玩家移动状态标志（0=静止，位义见客户端移动状态机，具体枚举待核(?)）；f2=朝向+速度等级，客户端用 `PackShrink(direction, speedLevel)` 把方向与移动速度打包成一个 int；f3=移动目标坐标（Z 恒为 0，2D 平面移动）；f4=移动发生的时间戳（客户端恒为 0）。

**EnterSceneNotify（`0x2c89b38b37d3d` 的 SyncEnterSceneResultNotify 内层）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | hall_data | HallInfo |
| 2 | player_data | PlayerSyncData |
| 3 | hall_brief | PlayerHallBrief |

> 参数实际含义：f1=进入场景后服务端下发的大厅元信息（地图/场景类型/同步间隔等）；f2=玩家自身全量进度（基本信息/任务/生物/道具/像素画/Buff 等文档）；f3=玩家在本场景的初始坐标与朝向。

**HallInfo**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | unique_id | uint |
| 2 | map_id | int |
| 3 | scene_type | uint |
| 4 | linenum | uint |
| 5 | attributes | uint |
| 6 | sync_interval | uint |
| 7 | options | HallOptions |

> 参数实际含义：f1=大厅/场景实例唯一 ID；f2=当前地图 ID（决定地图资源与布局）；f3=场景类型（对应 `EnterSceneParam` 的创建/加入形态，如私厅/随机/大厅等(?)）；f4=线路号 linenum（玩家所处线路编号，?）；f5=大厅属性位（flags，具体位义待核(?)）；f6=玩家位置同步帧发的间隔时长；f7=大厅可配置选项集合（如公开/邀请等）。

**PlayerSyncData**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | data | PlayerBrief |
| 2 | avatar_info | Avatar |
| 3 | taskDoc | TaskData |
| 4 | attrDoc | AttributeData |
| 5 | creatureDoc | CreatureData |
| 6 | itemData | ArkhubItemData |
| 7 | pixelArtDoc | PixelArtData |
| 8 | buffDoc | BuffDoc |
| 9 | featureDoc | FeatureFlagsDoc |

> 参数实际含义：f1=玩家身份/形象简要信息；f2=头像与代表形象（大头像/形象干员皮肤）；f3=任务文档（引导/每日任务进度）；f4=玩家各项属性值（对应 `UserAttribute`，如等级/体力/装扮项）；f5=生物文档（持有生物、图鉴、编队）；f6=道具文档（消耗品/捕获道具库存）；f7=像素画文档（创作/收藏列表）；f8=生效中的 Buff 列表；f9=功能开关面（`FeatureFlagsDoc`，flag→值）。

**PlayerSyncData 嵌套 doc（f5-f9）结构**

**CreatureData**（f5 creatureDoc——生物图鉴/持有/编队）
| 字段 | Name | 类型 | 含义 |
|---|---|---|---|
| 1 | creatures | Creature[] | 玩家持有/捕捉的生物实体 |
| 2 | collections | CreatureCollection[] | **图鉴/数据库收录**（关键：数据库空则入口未解锁） |
| 3 | squads | CreatureSquad[] | 生物编队 |
| 4 | following_creature_unique_id | ulong | 跟随宠物实例 id |
| 5 | creature_wanting | uint | 交换：想要生物模板 id |
| 6 | creature_giving | ulong | 交换：给出生物实例 id |

**ArkhubItemData**（f6 itemData——道具/券）
| 字段 | Name | 类型 | 含义 |
|---|---|---|---|
| 1 | coin | int | 奇象兑换券数（arkdex_1_gold） |
| 2 | items | ArkhubItem[] | 持有道具（{item_id, count}） |

**PixelArtData**（f7 pixelArtDoc——像素画创作/收藏）
| 字段 | Name | 类型 | 含义 |
|---|---|---|---|
| 1 | creations | PixelArtInfo[] | 自创像素画 |
| 2 | collections | PixelArtCollectionItem[] | 收藏像素画 |
| 3 | display_pixel_art_id | ulong | 当前展示画作 id |
| 4 | show_nickname | bool | 是否显示创作者昵称 |
| 5 | album_display_id | ulong | 画册展示位 id |
| 6 | obtained_npc_pixel_arts | string[] | 已获得的 NPC 像素画 |
| 7 | remaining_publish_count | int | 剩余可发布次数 |
| 8 | last_refresh_time | long | 上次刷新时间戳 |
| 9 | claimed_global_publish_count_grants | long[]（packed） | 已领取的全局发布次数奖励 |
| 10 | hide_display | bool | 是否隐藏我的画作展示 |

**BuffDoc**（f8 buffDoc——生效 Buff）
| 字段 | Name | 类型 | 含义 |
|---|---|---|---|
| 1 | buff_list | UnitBuff[] | 生效中的 Buff 列表 |

**FeatureFlagsDoc**（f9 featureDoc——功能开关/解锁位）
| 字段 | Name | 类型 | 含义 |
|---|---|---|---|
| 1 | flags | Dictionary<int,int> | 功能/引导特征位 → 值（客户端 `UpdateFuncStatus` 应用，功能解锁依据） |

### 功能菜单解锁（menuData / feature id / funcDict）

> 官方菜单定义在 `activity.arkHub.act1arkhub.menuData`；解锁状态由服务端下发的
> `featureDoc(f9).flags` 决定，客户端经 `UpdateFuncStatus → ActArkhubServerFuncStatusInfo.funcDict`
> 应用为菜单 `LOCKED/UNLOCKED/BANNED`。
> **feature id = `ActArkHubMenuType` 枚举值（= menuData.sortId）**，value = `FuncMenuStatus` 数值。
> 本地 `buildFeatureDoc` 按此下发放解锁位：`{4:1,5:1,6:1,7:1,8:1}`（UNLOCKED=1）。

**menuData 功能菜单表**
| menuType(枚举) | sortId | 名称 | 永久 | 解锁提示 |
|---|---|---|---|---|
| INVITE_FRIEND | 1 | 邀约 | ✓ | - |
| MESSAGE | 2 | 消息 | ✓ | - |
| SETTING | 3 | 设置 | ✓ | - |
| ARKDEX_CREATURE | 4 | 扫描仪 | ✗ | - |
| ARKDEX_ITEM | 5 | 道具箱 | ✗ | - |
| **ARKDEX_ALBUM** | 6 | **数据库** | ✗ | - |
| **ARKPIXEL** | 7 | 画像册 | ✗ | 向奇象收集师学习数据扫描后解锁 |
| ARKDEX_TRADE | 8 | 交换站 | ✗ | - |

**ActArkHubFuncMenuStatus**：`LOCKED=0 / UNLOCKED=1 / BANNED=2`（featureDoc.flags 的 value）。

**重复链路**：`featureDoc{f1 flags: map<menuTypeId, FuncMenuStatus>}` →
`funcDict: Dictionary<string, ActArkhubServerFuncItem.status>`（服务端只经 featureDoc 提供 int，
string→菜单名映射在客户端热更）→ 菜单项激活/置灰。

**PlayerBrief**（⚠️ 无 avatarId，f5 为 channel）
| 字段 | Name | 类型 |
|---|---|---|
| 1 | uid | string |
| 2 | nickname | string |
| 3 | nicknumber | string |
| 4 | level | uint |
| 5 | channel | uint |
| 6 | charater | string |
| 7 | skin | string |
| 8 | skinSp | bool |

> 参数实际含义：f1=玩家账号 UID（交换/业务卡等以它互指）；f2=玩家昵称；f3=昵称后缀编号（同名后自动追加，用于区分）；f4=玩家等级；f5=登录渠道号；f6=当前大厅外观所使用的角色干员 ID（`ChangeOutlookReq.charater` 即写此字段）；f7=外观皮肤 ID；f8=是否使用 SP 系列皮肤。

**Avatar（avatar_info）**（f3/f4 为代表形象干员+皮肤）
| 字段 | Name | 类型 |
|---|---|---|
| 1 | type | string |
| 2 | avatar_id | string |
| 3 | secretary | string |
| 4 | secretary_skin_id | string |
| 5 | secretary_skin_sp | bool |

> 参数实际含义：f1=头像类型标识（如 `char`/`skin` 等资源分类(?)）；f2=头像 ID（type 对应下的具体资源 ID，用于头像展示）；f3=代表形象（秘书/前台）干员 ID；f4=该形象使用的皮肤 ID；f5=该皮肤是否 SP 皮肤。代表形象即玩家在别人视角/交换列表里看到的干员造型。

### 商店 / 道具

**GetShopInfoResp（`0x208c328f5229c`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | code | int |
| 2 | shop_id | string |
| 3 | shop_info | ArkhubShop |

> 参数实际含义：f1=结果码（100=成功）；f2=回显商店 ID；f3=商店完整信息（商品/价格表，`ArkhubShop`）。

**StartCaptureResp（`0x29854b7c2b07e`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | code | uint |
| 2 | battle_id | string |

**EndCaptureReq（`0x29854b7c204e8`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | battle_id | string |
| 2 | param | ArkDexEndParam |

**EncounterCreatureNotify（`0x29854b7c20f13`，服务端推送）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | battle_info | CreatureBattleInfo |

> 参数实际含义：f1=遭遇生物战信息（客户端 `captureSession.FillBattleInfo` 初始化捕捉会话，含待捕捉生物列表/关卡/类型）。

### 捕捉流程（Scan / 草丛扫描）

**CreatureBattleInfo**（battle_info，嵌套）
| 字段 | Name | 类型 |
|---|---|---|
| 1 | creatures | CreatureBrief[] |
| 2 | stage_id | string |
| 3 | capture_type | int |

> 参数实际含义：f1=本次遭遇/可捕捉的生物列表；f2=所属捕捉关卡/地图 ID；f3=捕捉类型（区分不同捕捉玩法(?)）。

**CreatureBrief**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | unique_id | ulong |
| 2 | template_id | uint |
| 3 | persona | uint |

> 参数实际含义：f1=该生物实例唯一 ID（业务卡/对局/交换均以它标识一只具体生物）；f2=生物物种/模板 ID（决定种族与基础形象）；f3=个体变体 persona（个体差异/性格染色，同类不同外观(?)）。

**StartCaptureReq（`0x29854b7c267d7`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | param | ArkDexStartParam{ creature_inst_id:ulong, troop_index:int, troop_info:string } |

> 参数实际含义：param（嵌套 ArkDexStartParam）：creature_inst_id=要捕捉的目标生物 unique_id；troop_index=使用的出战队伍索引；troop_info=队伍信息（带哪些生物进入捕捉，多为 JSON 编码(?))。对应客户端 `StartCapture(creatureInstId, troopIndex, troopInfo)`。

**StartCaptureResp（`0x29854b7c2b07e`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | code | uint |
| 2 | battle_id | string |

> 参数实际含义：f1=结果码（100=成功）；f2=捕捉战斗的唯一 ID（后续 EndCapture 上报 ODS 标识）。

**GetCaptureInfoReq（`0x29854b7c2ad8b`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | creature_inst_id | ulong |

> 参数实际含义：f1=要查询捕捉信息的生物 unique_id。

**GetCaptureInfoResp（`0x29854b7c2b4de`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | code | uint |
| 2 | battle_info | CreatureBattleInfo |

> 参数实际含义：f1=结果码（100=成功，客户端 `captureReqCode` 据此判定）；f2=该生物的遭遇/捕捉战信息（可捕捉列表/关卡/类型）。

**EndCaptureReq（`0x29854b7c204e8`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | battle_id | string |
| 2 | param | ArkDexEndParam{ battle_id:string, complete_state:int } |

> 参数实际含义：f1=本次捕捉战斗唯一 ID；f2=结束参数（嵌套 ArkDexEndParam）：battle_id=战斗 ID（与 f1 一致）；complete_state=完成状态（如成功/失败/中途退出）。

**EndCaptureResp（`0x29854b7c26451`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | settle_info | ArkDexSettleInfo{ is_success:bool, end_time:ulong, creatures:CreatureBrief[], rewards:ArkRewardItem[] } |

> 参数实际含义：f1=捕捉结算信息（嵌套 ArkDexSettleInfo）：is_success=是否捕捉成功；end_time=结算时刻时间戳；creatures=本次获得/捕捉到的生物；rewards=结算奖励道具列表。

### 对局（Duel / 拟合对决）

**BattleParam**（StartDuelReq / LoadingFinishReq 共用 body）
| 字段 | Name | 类型 |
|---|---|---|
| 1 | duel_id | string |
| 2 | battle_id | ulong |

> 参数实际含义：f1=对局（拟战）ID，标识一场比赛；f2=战斗实例 ID（一次对局的当前战斗回合实例，客户端 `arkdexDuelData.duelId/battleId` 回填）。

**StartDuelReq（`0x3e546f8faa515`）/ LoadingFinishReq（`0x3e546f8faf090`）** = BattleParam

**StartDuelResp（`0x3e546f8fa2dce`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | code | int |

> 参数实际含义：f1=结果码（100=成功，其它为失败原因）。

**JoinDuelReq（`0x29854b7c277bf`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | param | ArkDexDuelParam |

> 参数实际含义：f1=加入对局参数（嵌套 ArkDexDuelParam，含对局/匹配信息，?）。

**JoinDuelResp（`0x29854b7c2a2e2`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | code | int |
| 2 | mode_type | int |

> 参数实际含义：f1=结果码（100=成功）；f2=对局模式类型（`modeType`，区分拟合玩法，如双人/匹配(?)）。

**OnJoinDuelNotify / JoinDuelNotify（`0x29854b7c2ef4f`，服务端推送）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | duel_id | string |
| 2 | stage_id | string |
| 3 | battle_id | ulong |
| 4 | mode_type | int |
| 5 | duel_info | ArkDexDuelInfo |

> 参数实际含义：f1=对局 ID；f2=对局地图/关卡 ID；f3=战斗实例 ID；f4=对局模式类型；f5=对局整体信息（双方出战/回合等，客户端 `FillBattleInfo` 填充）。

**RoundPrepareReq（`0x3e546f8fa9c6e`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | battle_id | ulong |
| 2 | is_prepare | bool |
| 3 | dispatch_creature | CreatureBuildItem[] |

> 参数实际含义：f1=战斗实例 ID；f2=是否为"准备完毕"（true=确认准备，false=取消准备）；f3=派上场的生物及其部署位（格子）。

**DuelRoundResultReportReq（`0x3e546f8fa293a`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | battle_id | ulong |
| 2 | round | int |
| 3 | winner | string |
| 4 | battle_info | map<string, DuelRoundBattleInfo> |
| 5 | enemy_runtime_snapshot | EnemyRuntimeSnapshot[] |

> 参数实际含义：f1=战斗实例 ID；f2=当前回合序号；f3=本回合胜者 UID（用于判定整体胜负/积分(?)）；f4=双方各玩家的本回合战斗信息（<玩家 uid, 上场/使用生物>，客户端 `RequestRoundResultReport` 的 battleInfoes）；f5=敌方/怪物运行时快照（对局内实体状态，判定用(?)）。

**LeaveDuelReq（`0x3e546f8fad282`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | duel_id | string |
| 2 | battle_id | ulong |

> 参数实际含义：f1=对局 ID；f2=战斗实例 ID（客户端 `RequestLeaveDuel` 用当前 razorDuelData 回填）。

**UploadBattleDataReq（`0x3e546f8faab16`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | battle_id | ulong |
| 2 | battle_data | string |

> 参数实际含义：f1=战斗实例 ID；f2=战报数据（战斗全程记录，多为 JSON/压缩串，供服务端校验/回放）。

**CancelDuelReq（`0x29854b7c21661`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | mode_type | int |

> 参数实际含义：f1=要取消的对局模式类型（客户端只传下列表类型，匹配超时/主动取消）。

**CreatureBuildItem**（dispatch_creature / battle_creature_info，嵌套）
| 字段 | Name | 类型 |
|---|---|---|
| 1 | intance_id | ulong |
| 2 | row | int |
| 3 | col | int |

> 参数实际含义：f1=被部署/上场的生物实例 unique_id（注：名拼写 intance=instance 原始笔误，沿用）；f2=部署所在的行号；f3=部署所在的列号。

**DuelRoundBattleInfo**（battle_info value，嵌套）
| 字段 | Name | 类型 |
|---|---|---|
| 1 | battle_creature_info | CreatureBuildItem[] |
| 2 | used_creature_info | ulong[] |

> 参数实际含义：f1=该玩家本回合部署的全部生物（instance+行列）；f2=本回合已使用/消耗掉的生物 unique_id 列表。

### 生物管理（Creature）

**DeleteCreatureReq（`0x29854b7c264e3`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | unique_ids | ulong[]（packed） |

> 参数实际含义：f1=要删除/放生的生物实例 unique_id 列表。

**SetCreatureLikeReq（`0x29854b7c28d19`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | unique_id | ulong |
| 2 | liked | bool |

> 参数实际含义：f1=目标生物实例 unique_id；f2=是否点赞/收藏（true=点赞，false=取消）。

**SetFollowingCreatureReq（`0x29854b7c20b13`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | unique_id | ulong |

> 参数实际含义：f1=要设为跟随/随身宠物的生物实例 unique_id（`RequestSetFollowingCreature`，同列表替换跟随生物）。

**SetCreatureSquadReq（`0x29854b7c2cbf4`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | squads | CreatureSquad[] |

> 参数实际含义：f1=完整编队列表（客户端把各队伍槽位上生物整体提交，`RequestSetCreatureSquad` 一次写多队）。

**CreatureSquad**（squads 元素，嵌套）
| 字段 | Name | 类型 |
|---|---|---|
| 1 | squad_idx | int |
| 2 | slot | CreatureSquadSlot[] |

> 参数实际含义：f1=队伍编号；f2=该队伍内各槽位摆放的生物。

**CreatureSquadSlot**（slot 元素，嵌套）
| 字段 | Name | 类型 |
|---|---|---|
| 1 | slot_idx | int |
| 2 | creature_unique_id | ulong |

> 参数实际含义：f1=槽位序号（0 起）；f2=放入该槽位的生物实例 unique_id。

**CreatureAlterNotify（`0x29854b7c2d119`，服务端推送）**：altered_creatures / deleted_creature_ids / following_creature_unique_id / squads / creature_wanting / creature_giving 等（见 CreatureDataAlterNotify.cs）
> 业务含义：altered_creatures=新增/变化的生物；deleted_creature_ids=删除的生物 id；following_creature_unique_id=当前跟随生物；squads=最新编队；creature_wanting=想要求(求)的生物模板 id；creature_giving=愿意给出的生物实例 id。对应 `CreatureDataAlterNotify` 增量同步。

### 交换（Exchange）

**GetAllCreatureExchangeInfoReq（`0x29854b7c21f3a`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | exchange_type | uint |

> 参数实际含义：f1=交换类型（`ExchangeType`，区分求生物/给生物等列表视角）。

**GetAllCreatureExchangeInfoResp（`0x29854b7c25f13`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | request | CreatureExchangeRequest[] |
| 2 | exchange_type | uint |
| 3 | player_avatars | map<string, Avatar> |

> 参数实际含义：f1=符合条件的交换请求列表；f2=回显交换类型（与请求一致）；f3=各玩家 UID→代表形象（`Avatar`），供列表展示对方的形象。

**PresetCreatureExchangeReq（`0x29854b7c2369e`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | creature_wanting | uint |
| 2 | creature_giving | ulong |

> 参数实际含义：f1=想要获得的生物模板 ID（`wantingId`）；f2=愿意给出的生物实例 unique_id。即"用我的 XX 换你想要的 YY"的预设挂单。

**CreateCreatureExchangeReq（`0x29854b7c2394d`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | to_player_uid | string |
| 2 | from_creature_unique_id | ulong |
| 3 | to_creature_unique_id | ulong |

> 参数实际含义：f1=目标玩家 UID（发给谁）；f2=我方给出的生物实例 unique_id；f3=希望换取的对方生物实例 unique_id（发起交换）。

**AnswerCreatureExchangeReq（`0x29854b7c2be4f`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | from_player_uid | string |
| 2 | answer_type | uint |
| 3 | from_creature_unique_id | ulong |
| 4 | to_creature_unique_id | ulong |

> 参数实际含义：f1=发起方玩家 UID（回复谁）；f2=应答类型（`AnswerType`，1=同意/0=拒绝，见客户端 `approve?1u:0u`）；f3=发起方给出的生物 unique_id；f4=我方给出的生物 unique_id（同意时用，拒绝常为 0）。

**CreatureExchangeStateNotify（`0x29854b7c283a3`，服务端推送）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | state_code | uint |
| 2 | request | CreatureExchangeRequest |

> 参数实际含义：f1=交换状态推进码（请求通过/拒绝/取消/完成等，?）；f2=对应的交换请求全量信息。

**CreatureExchangeRequest**（request 元素 / state 内嵌，嵌套）
| 字段 | Name | 类型 |
|---|---|---|
| 1 | from_player_uid | string |
| 2 | to_player_uid | string |
| 3 | request_time | ulong |
| 4 | from_creature_brief | CreatureBrief |
| 5 | to_creature_brief | CreatureBrief |
| 6 | expire_time | ulong |

> 参数实际含义：f1=发起方 UID；f2=接收方 UID；f3=发起时间戳；f4=发起方拟给出的生物摘要；f5=接收方拟给出的生物摘要；f6=请求过期时间戳（超时后作废）。

### 场景同步与交互

**SyncSceneNotify（`0x2c89b38b3360a`，场景玩家批量同步）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | update_units | UnitAppearance[] |
| 2 | delete_units | ulong[]（packed） |

> 参数实际含义：f1=新增/更新的场景单位外观列表（进入场景的其它玩家/单位）；f2=离开/删除的单位 unique_id 列表。

**UnitAppearance**（update_units 元素，嵌套）
| 字段 | Name | 类型 |
|---|---|---|
| 1 | unique_id | ulong |
| 2 | unit_type | uint |
| 3 | config_id | int |
| 4 | state_mask | ulong |
| 5 | yaw | float |
| 6 | position | Vector3 |
| 7 | brief | PlayerBrief |
| 8 | attributes | UserAttribute[] |
| 9 | interactions | InteractBrief |

> 参数实际含义：f1=单位在场景中的唯一 ID；f2=单位类型（玩家/NPC 等，?）；f3=单位配置 ID（对应资源/角色配置(?)）；f4=状态掩码（可交互/动作状态位）；f5=朝向角；f6=坐标；f7=该单位玩家的简要信息（uid/昵称/形象）；f8=玩家属性列表（展示他人属性）；f9=交互信息（所在交互槽）。

**StepSyncNotify（`0x2c89b38b31d8f`，SyncStateNotify）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | update_units | StepSyncData[] |

> 参数实际含义：f1=步进同步的单位列表（位置/交互状态细分步进推送，客户端 `UpdateUnits`/`UpdateInteractBrief` 应用）。

**PlayerAlterDataNotify（`0x2c89b38b36462`，SyncAlterDataNotify）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | state_mask | ulong |
| 2 | item_alter_data | ItemChangeNotify |
| 3 | buff_alter_data | BuffAlterList |
| 4 | interactions | InteractBrief |
| 5 | task_alter_data | TaskAlterList |
| 6 | feature_doc | FeatureFlagsDoc |
| 7 | attr_alter_list | AttrAlterList |

> 参数实际含义：f1=高位状态掩码（`UpdateHighStateMask`，用于同步玩家可交互/动作的高位状态）；f2=道具变更增量（金币/增减库存）；f3=Buff 变更增量；f4=交互状态推进（`UpdateInteractBrief`，所在交互槽）；f5=任务变更增量（引导/每日任务）；f6=功能开关面更新（flag 变更）；f7=属性变更增量。
>
> 各嵌套子文档字段业务含义：
> - **ItemChangeNotify**：f1 coin=金币总额（购买/领奖后更新）；f2 modified=发生增减/数量变化的道具（`ArkhubItem{item_id,count}`）；f3 deleted=被移除/消耗完的道具 item_id 列表。
> - **BuffAlterList**：f1 modified_buffs=新增/变化的 Buff（`UnitBuff{buff_id,count}`）；f2 deleted_buffs=失效移除的 buff_id 列表。
> - **TaskAlterList**：f1 modified=状态变化的任务列表（`TaskInfo`）；f2 deleted=被删除的任务 seq_number 列表；f3 daily_task=每日任务增量（`DailyTaskAlterInfo`）。
> - **TaskInfo**：f1 seq_number=任务序号（引导/每日任务的唯一标识）；f2 status=任务当前状态（如进行中/已完成）。
> - **DailyTaskAlterInfo**：f1 daily_task_ts=每日任务重置时间戳；f2 completed=今日任务是否已全部完成。
> - **FeatureFlagsDoc**：f1 flags=功能开关字典 `<特征位, 值>`（客户端 `UpdateFuncStatus` 应用）。
> - **AttrAlterList**：f1 modified=数值属性变更（`UserAttribute{attr_id, int_value}`）。
> - **InteractBrief**：f1 unique_id=交互对象/角色的唯一 ID；f2 slot_index=玩家当前所处交互槽位索引。
>
> 补充——**TaskData**（`PlayerSyncData.taskDoc` 全量任务文档，含引导/每日任务）：tasks=任务列表（`TaskInfo{seq_number,status}`）；daily_task_ts=每日任务刷新时间戳；pixel_art_ban_until=像素画发布封禁截止时间戳（被处罚后在该时间前不可发布(?)）。

**InteractionActionReq（`0x2c89b38b36055`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | target_unique_id | ulong |
| 2 | action | int |
| 3 | squad_index | int |

> 参数实际含义：f1=被交互单位/角色的唯一 ID；f2=交互动作类型（如点击/对话等(?)）；f3=使用的生物编队槽位索引（决定带哪个生物参与交互）。

**InteractionActionResp（`0x2c89b38b3d134`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | result_code | int |

> 参数实际含义：f1=交互结果码（0/100=成功，非 0=失败原因，具体值对应错误码表(?)）。

**ForceSetPositionNotify（`0x2c89b38b3e70f`，强制定位广播）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | position | Vector3 |
| 2 | yaw | float |

> 参数实际含义：f1=服务端强制定位的目标坐标（重置到合法点位/入口）；f2=强制更新后的朝向角。

**SubmitActorOpParam（`0x2c89b38b3116d`，SubmitActorOpReq）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | actor_id | string |
| 2 | option_id | string |

> 参数实际含义：f1=被操作角色（Actor，场景 NPC/角色）的 ID；f2=玩家选择的选项 ID（交互对话选项，决定领取的奖励分支）。

**DefaultResult（`0x2c89b38b38cd6`，SubmitActorOpResp）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | code | int |

> 参数实际含义：f1=通用结果码（100=成功（见本地应答器 `3000ee32` 下发奖励分支），非 100=失败原因）。

**BusinessCardReq（`0x2c89b38b322c3`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | unique_id | ulong |

> 参数实际含义：f1=要查看名片的目标单位/玩家唯一 ID。

**BusinessCardResp（`0x2c89b38b3613c`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | card | BusinessCard |

> 参数实际含义：f1=目标玩家的业务名片（姓名卡/代表生物/用户设置）。

**BusinessCard**（card，嵌套）
| 字段 | Name | 类型 |
|---|---|---|
| 1 | card_info | NameCard |
| 2 | creature | CreatureCard |
| 3 | user_opts | map<int, int> |

> 参数实际含义：f1=名片基本信息（头衔/徽章等装扮）；f2=该玩家展示的代表生物卡片；f3=用户自定义选项映射（<属性,值>，如展示外观等(?)）。

**UpdateSettingsReq（`0x2c89b38b36054`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | settings | map<int, int> |

> 参数实际含义：f1=待更新的玩家设置字典 <属性 ID, 值>（`ActArkhubPlayerAttribute`），一次请求可携带多项；客户端 `ReqUpdateSetting` 逐条发送。

**UpdateSettingsResp（`0x2c89b38b3db61`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | code | uint |
| 2 | settings | map<int, int> |

> 参数实际含义：f1=结果码（100=成功）；f2=服务端确认后的设置快照（回显生效后的值）。

**ChangeOutlookReq（`0x2c89b38b3d83c`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | charater | string |
| 2 | skin | string |
| 3 | skin_sp | bool |

> 参数实际含义：f1=新外观使用的角色干员 ID；f2=新外观皮肤 ID；f3=是否 SP 皮肤。对应客户端 `ChangeOutlook(charId, skinId, skinSp)`，成功后由 `ChangeOutlookResp` 回写并更新代表形象。

**ChangeOutlookResp（`0x2c89b38b3f7a7`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | code | uint |
| 2 | charater | string |
| 3 | skin | string |
| 4 | skin_sp | bool |

> 参数实际含义：f1=结果码（100=成功，客户端据此刷新代表形象）；f2~f4=服务端确认后的外观（干员/皮肤/SP），与请求一致时视为生效。

**PlayerActionMaskReq（`0x2c89b38b39680`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | operation | int |
| 2 | state_mask | ulong |

> 参数实际含义：f1=掩码操作类型（`ActArkhubServerPlayerStatusOperation`，如置位/清除，对应 `RequestModifyPlayerActionMask`）；f2=待修改的动作状态掩码。

**ChangeSceneReq（`0x2c89b38b3b60b`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | change_type | uint |
| 2 | area_id | int |
| 3 | scene_inst_id | uint |

> 参数实际含义：f1=切场景类型（`ChangeSceneType` 枚举：RANDOM_LINE/随机线、DEX/捕捉地图、HALL/大厅、INVITED/被邀请等，客户端 `ChangeScene(changeType, areaId, sceneInstId)`）；f2=目标区域 ID；f3=目标场景实例 ID（进入指定实例时使用）。

**LogoutSceneReq（`0x2c89b38b3c3c9`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | logout_type | uint |

> 参数实际含义：f1=离开场景类型（客户端 `LeaveScene` 恒设为 1，表示主动离开当前场景）。

**EnterSceneReq（`0x18fb64de29cdb`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | create | bool |
| 2 | unique_id | uint |
| 3 | inv_code | string |

> 参数实际含义：f1=是否新建大厅（true=创建私厅，false=加入已有场景）；f2=目标场景/大厅实例的唯一 ID（create=false 时指定要加入的场）；f3=邀请码（加入被邀请的场景时使用）。

**PlayerHallBrief**（EnterSceneNotify.hall_brief，嵌套）
| 字段 | Name | 类型 |
|---|---|---|
| 1 | unique_id | ulong |
| 2 | pos | Vector3 |
| 3 | yaw | float |

> 参数实际含义：f1=自己在大厅中的单位唯一 ID；f2=出生/当前位置；f3=出生朝向角。

**ReconnectNotify（`0x2c89b38b3f32d`，OnReconnectNotify）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | data | PlayerReconnectData |
| 2 | units | UnitAppearance[] |
| 3 | battle_id | ulong |

> 参数实际含义：f1=断线重连后服务端下发的玩家快照（状态/文档等，供重建本地状态）；f2=当前场景内所有单位的完整外观列表（重连后一次性重建场景）；f3=进行中的战斗 ID（若此前在对局中，重连后据此恢复(?)）。

**RolePlayingReq（`0x2c89b38b3170a`，DoRolePlayingReq）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | emoj_id | string |
| 2 | theme_id | string |
| 3 | action_mask | uint |

> 参数实际含义：f1=表情/Emoji ID；f2=装扮主题 ID（`SendEmojiReq(themeId, emojiId)`，决定表情动画的资源主题）；f3=动作掩码（玩家表达的动作状态位）。

### 像素画（Pixel Art）

**RequestPixelArtUploadTokenReq（`0x29ce231d603b3`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | pixel_art_id | ulong |
| 2 | md5 | string |

> 参数实际含义：f1=待上传像素画的 ID（先经服务端分配）；f2=上传内容的 md5（服务端校验文件一致性/去重）。

**RequestPixelArtUploadTokenResp（`0x29ce231d60cf6`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | code | int |
| 2 | credential | PixelArtUploadCredential |

> 参数实际含义：f1=结果码（100=成功）；f2=上传凭证（含签名 token 与有效期）。
> ⚠️ 帧体带 **4B 请求序号回显前缀**（客户端按 `[seq]+proto` 解析，缺前缀会把 code 当 seq 导致
> 响应错乱、上传中止——私服曾因此"像素画上传失败"）；新画布（请求未带 pixel_art_id）时服务端
> 分配真实 pixel_art_id 下发（非 0）。字节级官服样本见 2026-08-12 抓包。

**PixelArtUploadCredential**（credential，嵌套）
| 字段 | Name | 类型 |
|---|---|---|
| 1 | pixel_art_id | ulong |
| 2 | upload_token | string |
| 3 | expire_time | long |

> 参数实际含义：f1=对应的像素画 ID；f2=上传鉴权 token（客户端拼接存储上传）；f3=token 到期时间戳（超时需重新申请）。

**SavePixelArtReq（`0x29ce231d674d5`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | pixel_art_id | ulong |
| 2 | upload_success | bool |
| 3 | do_publish | bool |

> 参数实际含义：f1=像素画 ID；f2=上传是否成功（失败可告知服务端丢弃）；f3=是否立即发布（`doPublish`，保存后直接公开）。

**CollectPixelArtReq（`0x29ce231d61490`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | target_uid | string |
| 2 | pixel_art_id | ulong |

> 参数实际含义：f1=被收集像素画所属玩家 UID；f2=要收藏的像素画 ID。

**DeletePixelArtReq（`0x29ce231d6d13b`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | pixel_art_id | ulong |

> 参数实际含义：f1=要删除的自创像素画 ID。

**DeletePixelArtCollectionReq（`0x29ce231d65453`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | pixel_art_id | ulong |

> 参数实际含义：f1=要移除收藏的像素画 ID。

**DeletePixelArtCollectionResp（`0x29ce231d6ea56`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | code | int |

> 参数实际含义：f1=删除收藏结果码（100=成功）。

**SetPixelArtAlbumDisplayReq（`0x29ce231d63285`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | pixel_art_id | ulong |

> 参数实际含义：f1=设为图鉴/画册展示位的像素画 ID（`RequestSetPixelArtAlbumDisplay`）。

**SetPixelArtDisplayReq（`0x29ce231d6e074`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | pixel_art_id | ulong |

> 参数实际含义：f1=设为大厅展示画作的像素画 ID（`RequestSetPixelArtDisplay`）。

**SetPixelArtNicknameVisibleReq（`0x29ce231d6ce0c`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | show_nickname | bool |

> 参数实际含义：f1=展示画作时是否显示创作者昵称（`RequestSetPixelArtNicknameVisible`）。

**SetPixelArtShowDisplayReq（`0x29ce231d6f1fb`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | hide_display | bool |

> 参数实际含义：f1=是否隐藏我的画作展示（`RequestSetPixelArtShowDisplay`，true=隐藏）。

**PixelArtDataAlterNotify（`0x29ce231d62bbd`，服务端推送）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | altered_creations | PixelArtInfo[] |
| 2 | deleted_creation_ids | ulong[]（packed） |
| 3 | altered_collections | PixelArtCollectionItem[] |
| 4 | deleted_collection_ids | ulong[]（packed） |
| 5 | display_pixel_art_id | ulong |
| 6 | show_nickname | bool |
| 7 | album_display_id | ulong |
| 8 | obtained_npc_pixel_arts | string[] |
| 9 | remaining_publish_count | int |
| 10 | status_changed_creation_ids | ulong[]（packed） |
| 11 | hide_display | bool |

> 参数实际含义：f1=新增/变更的自创像素画；f2=被删除的自创像素画 ID；f3=新增/变更的收藏项；f4=被删除的收藏 ID；f5=当前展示画作 ID；f6=是否显示昵称；f7=画册展示位 ID；f8=获得的 NPC 像素画 ID 列表（任务/奖励发放(?)）；f9=剩余可发布次数；f10=状态发生变化的画作 ID（如审核通过）；f11=是否隐藏展示（回显）。客户端 `FillWithDeltaData` 应用。

**PixelArtInfo**（altered_creations 元素，嵌套）
| 字段 | Name | 类型 |
|---|---|---|
| 1 | id | ulong |
| 2 | md5 | string |
| 3 | status | uint |
| 4 | create_time | long |
| 5 | update_time | long |
| 6 | publish_time | long |
| 7 | revision | uint |
| 8 | collected_count | uint |

> 参数实际含义：f1=像素画 ID；f2=内容 md5（标识画作内容）；f3=状态（客户端判 status==2/3 触发埋点，2=编辑中/3=已发布(?)）；f4=创建时间戳；f5=最近更新时间戳；f6=发布时间戳；f7=版本号（多次保存递增）；f8=被收藏次数。

**PixelArtCollectionItem**（altered_collections 元素，嵌套）
| 字段 | Name | 类型 |
|---|---|---|
| 1 | pixel_art_id | ulong |
| 2 | creator_uid | string |
| 3 | creator_nickname | string |
| 4 | creator_nicknumber | string |
| 5 | is_anonymous | bool |
| 6 | collect_time | long |

> 参数实际含义：f1=被收藏的像素画 ID；f2=创作者 UID；f3=创作者昵称；f4=创作者昵称后缀编号；f5=是否匿名收藏/展示；f6=收藏时间戳。

### 商店请求（Shop）

**GetShopInfoReq（`0x208c328f5ba6f`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | shop_id | string |

> 参数实际含义：f1=要查询的商店 ID（不同商店/价格表）。

**UseItemReq（`0x208c328f5b1ab`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | item_id | int |
| 2 | count | int |

> 参数实际含义：f1=要使用的道具 ID；f2=使用数量。

**UseItemResp（`0x208c328f5de74`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | code | int |

> 参数实际含义：f1=使用道具结果码（100=成功）。

**BuyShopItemReq（`0x208c328f56f2c`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | index | int |
| 2 | count | int |

> 参数实际含义：f1=商店商品列表下标（购买第几项，非 item_id）；f2=购买数量。

**BuyShopItemResp（`0x208c328f5568f`）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | code | int |
| 2 | index | int |
| 3 | item_id | int |
| 4 | count | int |
| 5 | price | int |
| 6 | current_coin | int |

> 参数实际含义：f1=结果码（100=成功，客户端据此 `FillCoinChanged` 更新金币）；f2=回显商品下标；f3=购买的道具 ID；f4=购买数量；f5=单价/实际花费；f6=购买后剩余金币总额。

### 通知（Toast）

**ToastMessage（`0x1ffd3000ee32`，NotifyToastMessageNotify，服务端推送——奖励/掉落通知）**
| 字段 | Name | 类型 |
|---|---|---|
| 1 | toast_type | int |
| 2 | items | ArkRewardItem[] |
| 3 | creature_id_list | ulong[] |
| 4 | perfab_pixel_id | ulong |

> 参数实际含义：f1=通知类型（1=道具奖励，见下方本地应答器分支；其它值对应不同奖励类(?)）；f2=奖励道具列表（`ArkRewardItem{item_id, count}`）；f3=获得的生物 unique_id 列表（生物奖励时填充，?）；f4=获得的预制像素画 ID（像素画类奖励时填充，perfab=prefab 预制物(?)）。各字段仅在对应 toast_type 下有值。
>
> 本地应答器：交互领奖分支（38b3116d）在 ACK 后用 `3000ee32` 下发奖励 `{1:1, 2:[{1:5012,2:1},{1:5022,2:1}]}`（f1≙toast_type=1 道具奖励，f2≙items），行为与官服一致，不做改动。

### 请求 ↔ 响应 字段速查（2026-08-20）

> 汇总每个请求 → 对应响应/服务端推送的**真实字段名**（字段号见上文各消息表）。`⟶` 表示服务端主动下发的 Notify（无请求）。

**捕捉（Scan）**

| 请求 | 请求字段 | 响应 / 推送 | 响应字段 |
|---|---|---|---|
| GetCaptureInfoReq `b7c2ad8b` | creature_inst_id | GetCaptureInfoResp `b7c2b4de` | code, battle_info |
| StartCaptureReq `b7c267d7` | param{creature_inst_id, troop_index, troop_info} | StartCaptureResp `b7c2b07e` | code, battle_id |
|  |  | ⟶ EncounterCreatureNotify `b7c20f13` | battle_info{creatures, stage_id, capture_type} |
| EndCaptureReq `b7c204e8` | battle_id, param{complete_state} | EndCaptureResp `b7c26451` | settle_info{is_success, end_time, creatures, rewards} |

**对局（Duel）**

| 请求 | 请求字段 | 响应 / 推送 | 响应字段 |
|---|---|---|---|
| JoinDuelReq `b7c277bf` | param | JoinDuelResp `b7c2a2e2` | code, mode_type |
|  |  | ⟶ OnJoinDuelNotify `b7c2ef4f` | duel_id, stage_id, battle_id, mode_type, duel_info |
| StartDuelReq `f8faa515` | duel_id, battle_id | StartDuelResp `f8fa2dce` | code |
| LoadingFinishReq `f8faf090` | duel_id, battle_id | ack | code |
| RoundPrepareReq `f8fa9c6e` | battle_id, is_prepare, dispatch_creature | ack | code |
| DuelRoundResultReportReq `f8fa293a` | battle_id, round, winner, battle_info, enemy_runtime_snapshot | ack | code |
| LeaveDuelReq `f8fad282` | duel_id, battle_id | ack | code |
| UploadBattleDataReq `f8faab16` | battle_id, battle_data | ack | code |
| CancelDuelReq `b7c21661` | mode_type | ack | code |

**交换（Exchange）**

| 请求 | 请求字段 | 响应 / 推送 | 响应字段 |
|---|---|---|---|
| GetAllCreatureExchangeInfoReq `b7c21f3a` | exchange_type | GetAllCreatureExchangeInfoResp `b7c25f13` | requests, exchange_type, player_avatars |
| PresetCreatureExchangeReq `b7c2369e` | creature_wanting, creature_giving | ack | code |
| CreateCreatureExchangeReq `b7c2394d` | to_player_uid, from_creature_unique_id, to_creature_unique_id | ack | code |
| AnswerCreatureExchangeReq `b7c2be4f` | from_player_uid, answer_type, from_creature_unique_id, to_creature_unique_id | ack | code |
|  |  | ⟶ CreatureExchangeStateNotify `b7c283a3` | state_code, request |

**生物（Creature）**

| 请求 | 请求字段 | 响应 / 推送 | 响应字段 |
|---|---|---|---|
| DeleteCreatureReq `b7c264e3` | unique_ids | ack | code |
| SetCreatureLikeReq `b7c28d19` | unique_id, liked | ack | code |
| SetFollowingCreatureReq `b7c20b13` | unique_id | ack | code |
| SetCreatureSquadReq `b7c2cbf4` | squads | ack | code |
|  |  | ⟶ CreatureAlterNotify `b7c2d119` | altered/deleted creatures, squads 等 |

**道具（Shop）**

| 请求 | 请求字段 | 响应 | 响应字段 |
|---|---|---|---|
| GetShopInfoReq `28f5ba6f` | shop_id | GetShopInfoResp `28f5229c` | code, shop_id, shop_info |
| BuyItemReq `28f56f2c` | index, count | BuyItemResp `28f5568f` | code, index, item_id, count, price, current_coin |
| UseItemReq `28f5b1ab` | item_id, count | UseItemResp `28f5de74` | code |

**像素（Pixel Art）**

| 请求 | 请求字段 | 响应 / 推送 | 响应字段 |
|---|---|---|---|
| RequestPixelArtUploadTokenReq `31d603b3` | pixel_art_id, md5 | Resp `31d60cf6` | code, credential{pixel_art_id, upload_token, expire_time} |
| SavePixelArtReq `31d674d5` | pixel_art_id, upload_success, do_publish | ack | - |
| CollectPixelArtReq `31d61490` | target_uid, pixel_art_id | ack | code |
| DeletePixelArtReq `31d6d13b` | pixel_art_id | DeletePixelArtResp `31d67d3e` | code |
| DeletePixelArtCollectionReq `31d65453` | pixel_art_id | CollectionResp `31d6ea56` | code |
|  |  | ⟶ PixelArtDataAlterNotify `31d62bbd` | altered/deleted creations & collections 等 |

**场景 / 交互**

| 请求 | 请求字段 | 响应 / 推送 | 响应字段 |
|---|---|---|---|
| EnterSceneReq `4de29cdb` | create, unique_id, inv_code | ⟶ SyncEnterSceneResultNotify `38b37d3d`(EnterSceneNotify) | hall_data, player_data, hall_brief |
| MoveReq `38b32a34` | status, shrink, position, time | （服务端位置广播，无独立 Resp） | - |
| ChangeSceneReq `38b3b60b` | change_type, area_id, scene_inst_id | ⟶ LeaveSceneNotify `38b3a5a8` + 场景数据 | - |
| LogoutSceneReq `38b3c3c9` | logout_type | ack | - |
| SubmitActorOpReq `38b3116d` | actor_id, option_id | SubmitActorOpResp `38b38cd6`(DefaultResult) | code |
| GetBusinessCardReq `38b322c3` | unique_id | GetBusinessCardResp `38b3613c` | card(BusinessCard) |
| UpdatePlayerSettingsReq `38b36054` | settings{} | UpdatePlayerSettingsResp `38b3db61` | code, settings |
| ChangeOutlookReq `38b3d83c` | charater, skin, skin_sp | ChangeOutlookResp `38b3f7a7` | code |
| ReportPlayerActiveReq `38b3ab0c` | count | fire-and-forget | - |
| DoRolePlayingReq `38b3170a` | theme_id, emoji_id | ack | - |
| ModifyPlayerActionReq `38b39680` | state_mask, operation | ack | - |
| UserLoginReq `00000fa1` | uid, secret, login_channel, device_id | UserLoginResp `00000fa2` | code, heartbeat_interval, reconnect_token, ip, port |
| UserReconnectReq `00000fa3` | uid, (JWT) | UserReconnectResp `00000fa4` | code |

> 服务端另主动推送：NotifyToastMessageNotify `3000ee32`（toast_type/items/creature_id_list/perfab_pixel_id）、
> SyncAlterDataNotify `38b36462`（state_mask + item/buff/task/feature/attr 变更）、
> SyncSceneNotify `38b3360a`、StepSyncNotify `38b31d8f`、ForceSetPositionNotify `38b3e70f`。

---

## 11. 帧处理总表（本地应答器逐帧标注，2026-08-20）

> `名字 / 方向 / 业务对象 / 本地网关处理`。subID 取低 32，完整值见 §9。
> 对齐状态：🟢=结构与应答已按官方对齐；🟡=仅名称/方向确认，body 待核或为占位 ack；🔴=本地误用（须按本表归位）。
> 本地处理列对应 `app/game/modules/activities/arkhub/session/server.ts` 分支。

### 场景 / 输入 / 通知（前缀 0x2c89b3 / 0x1ffd3）

| Low32 | 名称(方向) | 业务对象 | 本地网关处理 | 状态 |
|---|---|---|---|---|
| 38b32a34 | MoveReq(up) | MoveReq | 位置同步(忽略 body，仅日志) | 🟢 |
| 38b31d8f | SyncStateNotify(down) | StepSyncNotify | 位置广播(发/收) | 🟢 |
| 38b3360a | SyncSceneNotify(down) | SyncSceneNotify | 玩家同步(回 Scene/忽略) | 🟢 |
| 38b36462 | SyncAlterDataNotify(down) | PlayerAlterDataNotify | 引导/状态变更广播 | 🟡 |
| 38b36055/d134 | InteractWithUnit Req/Resp | InteractionActionReq/Resp | 交互 ack | 🟡 |
| 38b3e70f | ForceSetPositionNotify(down) | ForceSetPositionNotify | 强制定位广播 | 🟡 |
| 38b37d3d | SyncEnterSceneResultNotify(down) | EnterSceneNotify | **场景数据帧(核心)** | 🟢 |
| 38b3a5a8 | LeaveSceneNotify(down) | LeaveSceneNotify | 切场景 ACK(f1:9) | 🟡 |
| 38b3f32d / 38b39689 | OnReconnect / OnRelay Notify(down) | ReconnectNotify / RelayLoginNotify | 忽略 | 🟢 |
| 38b3170a | DoRolePlayingReq(up) | RolePlayingReq | 表情/动作(ack) | 🟡 |
| 38b3116d / 38b38cd6 | SubmitActorOp Req/Resp | SubmitActorOpParam / DefaultResult | **交互领奖(核心)** | 🟢 |
| 38b322c3 / 38b3613c | GetBusinessCard Req/Resp | BusinessCardReq/Resp | 状态查看(ack) | 🟡 |
| 38b36054 / 38b3db61 | UpdatePlayerSettings Req/Resp | UpdateSettingsReq/Resp | 设置更新(ack) | 🟡 |
| 38b3d83c / 38b3f7a7 | ChangeOutlook Req/Resp | ChangeOutlookReq/Resp | 更换形象(ack) | 🟢 |
| 38b39680 | ModifyPlayerActionReq(up) | PlayerActionMaskReq | 状态掩码(ack) | 🟡 |
| 38b3ab0c | ReportPlayerActiveReq(up) | PlayerActiveCountReq | 活跃上报(忽略) | 🟢 |
| 38b3b60b | ChangeSceneReq(up) | ChangeSceneReq | **切场景(核心)** | 🟢 |
| 38b3c3c9 | LogoutSceneReq(up) | LogoutSceneReq | 离开场景(ack) | 🟢 |
| 30009df1 | NotifyErrorMessageNotify(down) | ErrorCodeNotify | 错误提示 | 🟡 |
| 3000ee32 | NotifyToastMessageNotify(down) | ToastMessage | **原先误当"奖励通知"** | 🔴 |
| 4de29cdb | EnterSceneReq(up) | EnterSceneReq | **场景 hello(核心)** | 🟢 |
| 4de28c3f | SyncClientLogoutNotify(down) | LogoutNotify | 退出 | 🟡 |

### 捕捉（Scan）前缀 0x29854b → low b7c2

| Low32 | 名称(方向) | 业务对象 | 本地网关处理 | 状态 |
|---|---|---|---|---|
| b7c2ad8b / b7c2b4de | GetCaptureInfo Req/Resp | GetCaptureInfoReq/Resp | 捕捉信息 | 🔴 误当其它 |
| b7c267d7 | StartCaptureReq(up) | StartCaptureReq | **原先误当"战斗开始"** | 🔴 |
| b7c2b07e | StartCaptureResp(down) | StartCaptureResp | 应回此帧 | 🔴 |
| b7c20f13 | EncounterCreatureNotify(down) | EncounterCreatureNotify | **原先误当"战斗开始响应/敌队"** | 🔴 |
| b7c204e8 | EndCaptureReq(up) | EndCaptureReq | **原先误当"战斗结算"** | 🔴 |
| b7c26451 | EndCaptureResp(down) | EndCaptureResp | 应回此帧 | 🔴 |

### 对局（Duel）前缀 0x3e546f → low f8fa / 入座 0x29854b

| Low32 | 名称(方向) | 业务对象 | 本地网关处理 | 状态 |
|---|---|---|---|---|
| b7c277bf / b7c2a2e2 | JoinDuel Req/Resp | JoinDuelReq/Resp | 入座(+ack) | 🔴 误当"战斗确认" |
| b7c2ef4f | OnJoinDuelNotify(down) | JoinDuelNotify | 入座广播 | 🟡 |
| b7c21661 | CancelDuelReq(up) | CancelDuelReq | 取消对局(ack) | 🟡 |
| f8faa515 / f8fa2dce | StartDuel Req/Resp | BattleParam / StartDuelResp | 对局开始 | 🆕 未实现 |
| f8faf090 | LoadingFinishReq(up) | BattleParam | 加载完成 | 🆕 未实现 |
| f8fa9c6e | RoundPrepareReq(up) | RoundPrepareReq | 回合准备 | 🆕 未实现 |
| f8fa293a | DuelRoundResultReportReq(up) | DuelRoundResultReportReq | 回合结算上报 | 🆕 未实现 |
| f8faf4f3 | DuelStageChangeNotify(down) | DuelStageChangeNotify | 阶段广播 | 🆕 未实现 |
| f8fad282 | LeaveDuelReq(up) | LeaveDuelReq | 离开对局 | 🆕 未实现 |
| f8faab16 | UploadBattleDataReq(up) | UploadBattleDataReq | 战报上传 | 🆕 未实现 |

### 生物管理（Creature）前缀 0x29854b

| Low32 | 名称(方向) | 业务对象 | 本地网关处理 | 状态 |
|---|---|---|---|---|
| b7c264e3 | DeleteCreatureReq(up) | DeleteCreatureReq | 删除生物 | 🔴 误当"战斗就绪" |
| b7c28d19 | SetCreatureLikeReq(up) | SetCreatureLikeReq | 点赞 | 🟡 未实现 |
| b7c20b13 | SetFollowingCreatureReq(up) | SetFollowingCreatureReq | 跟随宠物 | 🟡 未实现 |
| b7c2cbf4 | SetCreatureSquadReq(up) | SetCreatureSquadReq | 编队 | 🔴 误当"战斗数据上传" |
| b7c2d119 | CreatureAlterNotify(down) | CreatureDataAlterNotify | 生物变更广播 | 🟡 |

### 交换（Exchange）前缀 0x29854b

| Low32 | 名称(方向) | 业务对象 | 本地网关处理 | 状态 |
|---|---|---|---|---|
| b7c283a3 | CreatureExchangeStateNotify(down) | CreatureExchangeStateNotify | 交换状态广播 | 🟡 |
| b7c2369e | PresetCreatureExchangeReq(up) | PresetCreatureExchangeReq | 预设交换 | 🔴 误当"遭遇生物上报" |
| b7c2394d | CreateCreatureExchangeReq(up) | CreateCreatureExchangeReq | 发起交换 | 🟡 |
| b7c2be4f | AnswerCreatureExchangeReq(up) | AnswerCreatureExchangeReq | 应答交换 | 🟡 |
| b7c21f3a / b7c25f13 | GetAllCreatureExchangeInfo Req/Resp | GetAllCreatureExchangeInfoReq / Rsp | 交换信息 | 🔴 误当"战斗触发" |

### 商店 / 道具（前缀 0x208c32）与 像素（前缀 0x29ce23）

| Low32 | 名称(方向) | 业务对象 | 本地网关处理 | 状态 |
|---|---|---|---|---|
| 28f5ba6f / 28f5229c | GetShopInfo Req/Resp | GetShopInfoReq/Resp | **ARKDUEL 商店价格表** | 🟢 |
| 28f56f2c / 28f5568f | BuyItem Req/Resp | BuyShopItemReq/Resp | 购买道具 | 🟢 |
| 28f5b1ab | UseItemReq(up) | UseItemReq | **原先误当"第二购买形态"** | 🔴 |
| 31d603b3 / 31d60cf6 | RequestPixelArtUploadToken Req/Resp | Req/Resp | **原先误当"令牌刷新"** | 🔴 |
| 31d61490 | CollectPixelArtReq(up) | CollectPixelArtReq | 收集画像 | 🔴 误当"查看游客" |
| 31d6d13b/31d65453/31d67d3e | DeletePixelArt Req/Collection /Resp | 对应 Data | 像素删除 | 🔴 误当"实体信息查询" |

### 登录（main=4，非 GamePlay 段）

| Low32 | 名称(方向) | 业务对象 | 本地网关处理 | 状态 |
|---|---|---|---|---|
| 0fa1 / 0fa2 | UserLogin Req/Resp | UserLoginReq/Resp | 登录(code=100) | 🟢 |
| 0fa3 / 0fa4 | UserReconnect Req/Resp | UserReconnectReq/Resp | 重连登录 | 🟢 |

> 🔴 项即「拆分战斗与捕捉流程」需归位/实现的帧；🟡 为占位 ack 或待核 body；🆕 为对局段全新实现。

---

## 12. 帧形状差异表（Phase 0 取证，2026-08-27）

> 证据源：官服抓包会话 `2026-08-12T10-01-12-289Z` / `08-16T10-37-19-938Z` /
> `08-18T10-06-26-382Z` / `08-23T08-28-20-330Z`（up.bin/down.bin 原始字节）+
> 反编译数据类（`Torappu.UI.ActArkhub.Server.Data`）。帧体统一为 `[4B BE 请求序号] + proto`（商店/捕捉/对局段）或纯 proto（交换/广播段）。
>
> 复现工具：`tmp/p0-forensics.ts`（`pnpm exec tsx tmp/p0-forensics.ts`）。

| 帧 | 官服真实形状 | 本地原实现差异 | 结论 |
|---|---|---|---|
| BuyItemReq `28f56f2c` | [seq] `{1:count, 2:index}`（BuyShopItemReq f1=index/f2=count，样本 `00000010 08031001`=买 1 件 3 号位） | 解析把 f1→index、f2→count **字段互换** | 🔴 修正：f1=count、f2=index |
| BuyItemResp `28f5568f` | [seq] `{1:100, 2:index, 3:item_numId, 4:数量, 5:价格, 6:剩余券数}`（样本 `0864 1003 188e27 2001 28fa01 30ce01`） | 字段序错位（f2 写数量）且**缺 f6 剩余券数** | 🔴 修正为 6 字段 |
| UseItemReq `28f5b1ab` | [seq] `{1:item_id, 2:count}`（样本 `088e271001`=使用 5006） | 解析正确，**未接业务**（诱引剂/信息素不生效） | 🟡 接线 |
| EndCaptureReq `b7c204e8` | [seq] `{1:battle_id="uid:ts", 2:param{1:complete_state(3=成功), 2:captured[packed]=捕获槽位索引}}`；成功帧不带 battle_id，放弃帧仅 `{1:"uid:ts", 2:{1:1}}` | 不解析 body（按连接状态全捕获结算） | 🔴 修正：按槽位索引取捕获子集 |
| EndCaptureResp `b7c26451` | [seq] `{1:{1:is_success, 2:end_time, 3:creatures[], 4:rewards[{1:id,2:count}]}}`；放弃回最小 `{1:{2:ts}}` | **缺 f4 rewards**（官服扫描成功发 act1arkhub_token_seal×15） | 🔴 补 f4 |
| StartCaptureResp `b7c2b07e` | [seq] `{1:100, 2:battle_id="uid:epoch_ms"}` | battle_id 用 `cap_xxx` 形状 | 🟢 改官服形状 |
| EncounterCreatureNotify `b7c20f13` | `{1:{1:CreatureBrief{1:unique_id,2:template_id,3:persona}[], 2:stage_id, 3:1}}`；stage_id 随捕抓区：_13/_14/_15 | stage_id 固定 `act1arkhub_15` | 🟡 按场景映射 |
| DuelRoundResultReportReq `f8fa293a` | `{1:battle_id(ulong), 2:round(可选), 3:winner(胜局回合报=胜者uid), 4:battle_info(map, 终局报=双方), 5:enemy_runtime_snapshot[]}` | 不解析（恒按胜发券） | 🔴 修正：胜局=带 f3 报告；负局=终局报（仅 f4）；按 battle_id 去重 |
| GetAllCreatureExchangeInfo Req/Resp `b7c21f3a/b7c25f13` | Req `{1:exchange_type}`；Resp `{1:requests[](CreatureExchangeRequest), 2:exchange_type}`（样本 `1001`=f2 回显；Rsp ProtoMember(1/2/3)，Request 反编译字段 1/3/4/5/6） | Resp 回 `fv(2,0)` 字段号对但**值硬编 0**且无挂单 | 🔴 修正：f2 回显请求值 + requests 按 `hub.trade` 回填（单机回显自己挂单） |
| PresetCreatureExchangeReq `b7c2369e` | `{1:creature_wanting(种类 numId), 2:creature_giving(个体 unique_id)}`（样本 `08f29401 1004`）；**无响应样本** | 仅 ACK | 🟡 接 arkhubSetTrade，保持 ACK |
| GetShopInfoResp `28f5229c` | [seq] `{1:100, 3:{1:ts, 2:[{1:序号,2:商品,3:价格,4:库存}×7]}}` | 形状一致；货架内容硬编码 | 🟡 每日货架数据驱动（固定 5004/5005/5006 + 按日种子 2 味道 + 2 信息素，三日样本实锤轮换）；落盘 `hub.shopToday` 保证价格表与购买校验同源 |
| JoinDuelReq `b7c277bf` | [seq] `{1:{2:mode_type}}`（1-7 对应 modeData） | 不解析 | 🟢 无业务依赖（可选记录） |
| 状态掩码（状态机） | `ModifyPlayerActionReq(38b39680)` = `{1:op(SET=1/CLEAR=2), 2:state_mask}`；状态位：Interact=0x100/Matching=0x200/CaptureBattle=0x400/DuelBattle=0x800/PixelCreate=0x1000（`ActArkhubPlayerStateMask`）。官服经 `PlayerAlterDataNotify(38b36462)` f1 下发：捕捉战开始推 0x400（08-16 down#104）、对局开始推 0x800（08-16 down#431/592、08-23 down#91/147/221）；像素画 0x1000 由客户端上报（08-16 up#136/141） | 原仅 ACK 无状态应用 | 🔴 修正：连接维护 stateMask，SET/CLEAR 位操 + 玩法节点服务端驱动，均经 f1 回推（先响应后推送） |
| 败局语义 | 08-16 会话实锤：负局报告**无 f3**，终局带 f4；BO3 胜局首回合报带 f3=本人 uid | — | 胜负判定证据链闭合 |

