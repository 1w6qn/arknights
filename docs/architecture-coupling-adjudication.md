# 模块耦合违规裁决清单（第三版）

> 日期：2026-08-28 ｜ 来源：`tests/unit/architecture/module-boundary.test.ts` 的 `EXEMPTIONS` 登记表（机器可读，两者保持一致）
> 背景：`module-boundary.test.ts` 上线时因 `path.relative(APP_ROOT, f)` 丢失 `app/` 前缀导致全量扫描空转；
> 修复后守卫真实生效（RED：127 处违规 → 裁决豁免后 GREEN），并随重构持续收敛（当前登记表 36 条）。

## 1. 裁决结论

| 规则 | 全量违规 | 规则级豁免（设计内） | 登记表豁免（技术债/共享实现） | 待重构 |
| --- | --- | --- | --- | --- |
| R1 core 不得依赖 game/ops | 10 | 0 | 10 | 10（全部） |
| R2 kernel/excel 不得依赖 modules | 53 | 46（组合根） | 5 | 5 |
| R3 模块间仅可 import public.ts | 46 | 24（activities 聚合根） | 21 | 21 |
| 合计 | 109 | 70 | 36 | 36 |

- 规则级豁免（设计内，直接写进守卫逻辑，不占登记表）：
  - R2 组合根：`app/game/kernel/PlayerDataManager.ts`、`app/game/kernel/player-composition.ts`（架构规定的 manager 组装点）。
  - R3 聚合根：`app/game/modules/activities/index.ts`（活动族路由聚合，R4 已豁免）。
  - R3 activities 族 → `activities/shared`（既有规则）。
- 登记表 = 裁决结果：均判定为「豁免但列入重构待办」，任何新增越界引用将直接红。

## 2. 守卫修复

- `tests/unit/architecture/module-boundary.test.ts`
  - 修复 `rel` 计算：改用 `path.relative(path.resolve(APP_ROOT, ".."), f)`，恢复 `app/` 前缀，R1–R4 全量扫描真实生效。
  - 新增 `COMPOSITION_ROOTS`（R2 组合根豁免）与 `AGGREGATION_ROOT`（R3 聚合根豁免）。
  - `R4_EXEMPTIONS` 路径补 `app/` 前缀。
  - `EXEMPTIONS` 登记表随重构收敛（54 → 52 → 36 条），每条带 reason。

## 3. R1 core→game/ops（10 条，全部为技术债）

| 文件 | 说明符 | 裁决 |
| --- | --- | --- |
| `app/core/auth/auth.ts` | `@game/modules/account/AccountManager` | 技术债：core 鉴权直连账号服务（token/uid/密码），应抽象认证端口 |
| `app/core/config/prod.ts` | `../../ops/assets/asset` | 技术债：core 配置联动 ops 资源热更/注册表 |
| `app/core/config/prod.ts` | `@asset/asset-service` | 技术债：core 配置联动 ops 资源热更/注册表 |
| `app/core/db/migrate.ts` | `@game/modules/account/AccountManager` | 技术债：首启迁移导入 UserConfig 账号配置类型 |
| `app/core/db/replay-repo.ts` | `@game/kernel/battle-info-store` | 技术债：回放仓储依赖战斗信息类型 |
| `app/core/db/user-repo.ts` | `@game/modules/account/AccountManager` | 技术债：用户仓储依赖账号类型 |
| `app/core/logs/log-service.ts` | `../../ops/admin/AdminService` | 技术债：日志服务联动 admin 审计接口 |
| `app/core/utils/crypt.ts` | `@game/kernel/battle-model` | 技术债：加密层引用战斗载荷类型 |
| `app/core/utils/traffic-recorder.ts` | `@capture/capture-manager` | 技术债：抓包记录器依赖 ops capture 单例/端口 |
| `app/core/utils/traffic-recorder.ts` | `@capture/capture-recorder` | 技术债：抓包记录器依赖 ops capture 单例/端口 |

## 4. R2 kernel→modules（5 条）

| 文件 | 说明符 | 裁决 |
| --- | --- | --- |
| `app/game/kernel/events/core.ts` | `../../modules/roguelike/rlv2-model` | 事件契约载荷类型引用模块模型（建议上移 kernel/shared 类型层） |
| `app/game/kernel/events/rlv2.ts` | `../../modules/roguelike/rlv2-model` | 事件契约载荷类型引用模块模型（建议上移 kernel/shared 类型层） |
| `app/game/kernel/http/auth-strategy.ts` | `../../modules/account/AccountManager` | 技术债：kernel HTTP 鉴权策略直用账号服务（建议经 core-auth 接口） |
| `app/game/kernel/inventory.ts` | `../modules/activities/shared/unlockActivity` | 技术债：物品增减管道调用活动解锁逻辑（建议事件驱动） |
| `app/game/kernel/save-health.ts` | `../modules/character/char-skills` | 技术债：存档健康检查引用干员技能数据 |

## 5. R3 模块→模块（21 条）

| 文件 | 说明符 | 裁决 |
| --- | --- | --- |
| `app/game/modules/account/AccountManager.ts` | `../battle/BattleStore` | 共享战斗存储/信息接口（回放/结算） |
| `app/game/modules/account/AccountManager.ts` | `../social/SocialService` | 共享社交服务（好友委托） |
| `app/game/modules/account/AccountManager.ts` | `../user/freshPlayer` | 共享新玩家初始化数据构建 |
| `app/game/modules/battle/battle.ts` | `../account/AccountManager` | 共享账号服务（好友/uid/计数）——建议拆 account-data 门面 |
| `app/game/modules/battle/battle.ts` | `../activities/act44side/informant` | battle 引用活动族 informant 状态机 |
| `app/game/modules/building/logic/accrue.ts` | `../../account/AccountManager` | 共享账号服务（好友/uid/计数）——建议拆 account-data 门面 |
| `app/game/modules/building/logic/meeting.ts` | `../../account/AccountManager` | 共享账号服务（好友/uid/计数）——建议拆 account-data 门面 |
| `app/game/modules/building/logic/misc.ts` | `../../account/AccountManager` | 共享账号服务（好友/uid/计数）——建议拆 account-data 门面 |
| `app/game/modules/businessCard/businessCard.ts` | `../social/social-model` | 共享社交模型类型 |
| `app/game/modules/character/char.ts` | `../gacha/gacha` | 共享卡池实现/列表 |
| `app/game/modules/charm/routes.ts` | `../home/home` | charm 读取 home 主界面数据 |
| `app/game/modules/crisis/routes.ts` | `../pay/purchase-record` | 共享购买记录实现 |
| `app/game/modules/gacha/logic.ts` | `../account/AccountManager` | 共享账号服务（好友/uid/计数）——建议拆 account-data 门面 |
| `app/game/modules/home/routes.ts` | `../character/charRotation` | 共享角色轮换数据 |
| `app/game/modules/roguelike/logic.ts` | `../character/troop` | 共享编队实现 |
| `app/game/modules/roguelike/recruit.ts` | `../character/troop` | 共享编队实现 |
| `app/game/modules/shop/logic/low-high.ts` | `../../gacha/gacha-up-list` | 共享卡池实现/列表 |
| `app/game/modules/shop/logic/social.ts` | `../../pay/purchase-record` | 共享购买记录实现 |
| `app/game/modules/social/SocialManager.ts` | `../account/AccountManager` | 共享账号服务（好友/uid/计数）——建议拆 account-data 门面 |
| `app/game/modules/user/routes.ts` | `../account/user` | user 路由引用 account 协议/校验（路由层耦合，需下沉） |
| `app/game/modules/user/routes.ts` | `../account/user.schema` | user 路由引用 account 协议/校验（路由层耦合，需下沉） |

## 6. 耦合热点与剩余风险

- **battle 模块收敛**：共享战斗模型已上移 kernel（`kernel/battle-model.ts`、`kernel/battle-info-store.ts`），battle 模块不再是被 10+ 模块引用的 hub；剩余跨模块边：`battle→account`、`battle→activities/act44side`、`account→battle/BattleStore`。
- **account 仍为共享门面**：`building`/`gacha`/`social`/`battle` 直接调 `accountManager.*`，同时 `account` 反向依赖 `battle/BattleStore`、`social/SocialService`、`user/freshPlayer` → 建议拆 `account-data` 门面。
- **静态环（6 模块）**：`user → social → battle → activities/act44side → activities/shared → account → user`（含 `account↔battle`、`account↔social`、`shared↔act44side` 双向依赖）。
- **路由层耦合（剩余）**：`user/routes.ts` 引用 `account/user` + `user.schema`。
- ~~全仓唯一 public 出口 `activities/arkhub/public.ts` 无跨模块引用走它 → 模块门面模式仍在推广中。~~
  **已收敛（2026-09-13）**：arkhub 重构为 `domain/` + `session/` + `capture/` 分层并重写 `public.ts` 门面，
  `app/server.ts`（原 247 行内联绑定 → `session/bindings.ts`）、`app/ops/admin/*`、`scripts/*`、`tests/*`
  全部只经 public 消费；新增守卫 R5（game 不得依赖 ops）与 R6（模块外仅可 import arkhub public），
  见 `docs/arkhub-重构-2026-09-13.md` 与 `tests/unit/architecture/module-boundary.test.ts`。

## 7. 重构建议（按优先级）

1. **高**：断环 `account↔battle`（收敛到 `BattleStore` 门面或事件）、`account↔social`（抽 `account-data` 门面）。
2. **中**：`AccountManager` 拆 `account-data` 门面（一次消化 building/gacha/social/battle 的 6+ 条）；核心侧 R1 技术债（认证端口、迁移类型下沉、traffic-recorder 端口化）。
3. **低**：`user/routes.ts` 的 `account/user` 协议引用下沉。
4. 每完成一项重构，从 `EXEMPTIONS` 登记表删除对应条目并重跑守卫验证。

## 8. 已落地重构（登记表 54 → 36）

1. **守卫修复 + 第一版裁决**：`rel` 路径 bug 修复，登记表 54 条（见 §2）。
2. **home→arkodc 门面下沉**（-1）：`finishArkOdcGuideStory`/`ARK_ODC_GUIDE_STORY_ID`/`ensureArkOdcTopic` 自 `arkodc/routes.ts` 下沉至 `arkodc/guide.ts`，新增 `arkodc/public.ts` 门面；`home/routes.ts` 改经 `arkodc/public` 调用。
3. **SocialService 本地接口化**（-1）：`social/SocialService.ts` 对 `AccountManager` 的 type-only 依赖替换为本地结构化接口 `SocialAccountAccess`（仅依赖 core/kernel 共享类型）。
4. **战斗模型上移 kernel**（-16）：`battle-model.ts` → `kernel/battle-model.ts`、`BattleInfoStore.ts` → `kernel/battle-info-store.ts`，25 个引用点（含 3 处 kernel/events、13 处模块、core 2 处）全部改走 kernel；`BattleStore.ts` 保留在 battle 模块（运行时实现）。
5. 验证：`arkodc` 10/10、`battle` 32/32、`mission` 113/113、社交 23 用例、`model/battle` 全过；architecture 全量 23 用例过；`tsc --noEmit` 0 错误。
