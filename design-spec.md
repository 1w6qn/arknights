# DoctorateTs 项目设计规范

## 目录
1. [项目概述](#1-项目概述)
2. [目录结构规范](#2-目录结构规范)
3. [TypeScript编码规范](#3-typescript编码规范)
4. [路由设计规范](#4-路由设计规范)
5. [数据模型设计规范](#5-数据模型设计规范)
6. [设计模式和架构原则](#6-设计模式和架构原则)
7. [工具和配置规范](#7-工具和配置规范)
8. [启动模式与离线支持](#8-启动模式与离线支持)
9. [管理后台设计规范](#9-管理后台设计规范)
10. [好友系统与主数据层（多后端）](#10-好友系统与主数据层多后端)
11. [基建系统逻辑说明](#11-基建系统逻辑说明)
12. [战斗结算后处理逻辑](#12-战斗结算后处理逻辑)
13. [勋章系统实现](#13-勋章系统实现)
14. [任务系统实现](#14-任务系统实现)
15. [官服数据迁移](#15-官服数据迁移)
16. [集成战略 rlv2 接口补全](#16-集成战略-rlv2-接口补全)
17. [子域名分发与远程配置](#17-子域名分发与远程配置)
18. [助战系统](#18-助战系统)
19. [用户创建与自动注册](#19-用户创建与自动注册)
20. [服务端性能评估与优化](#20-服务端性能评估与优化)
21. [服务器地址配置](#21-服务器地址配置)
22. [资源与版本自动同步](#22-资源与版本自动同步)

---

## 1. 项目概述

### 1.1 项目定位
DoctorateTs 是一个基于 Express 框架的 Node.js 服务器应用，用于模拟明日方舟（Arknights）游戏的后端服务。

### 1.2 技术栈
- **框架**: Express 5.0
- **语言**: TypeScript 5.5
- **状态管理**: Immer 10.1
- **数据存储**: JSON 文件
- **工具**: ts-node、nodemon、eslint、prettier

### 1.3 核心特性
- 使用 Immer 进行状态管理，支持增量更新和撤销操作
- 所有游戏配置数据存储在 JSON 文件中，运行时加载为只读数据表
- 支持自动更新游戏数据和生成类型定义文件
- 支持完全离线启动模式（`--offline`），零网络操作，启动前校验本地数据完整性

---

## 2. 目录结构规范

### 2.1 整体结构
```
DoctorateTs/
├── app/                    # 应用核心代码
│   ├── auth/               # 认证模块
│   ├── config/             # 配置模块
│   ├── excel/              # Excel 数据表管理
│   ├── game/               # 游戏核心逻辑（DDD 分层：domain 纯领域 + service 应用服务）
│   │   ├── domain/          # 领域层（业务逻辑+路由契约+路由注册）：每路由域一目录（logic/模型/契约/handler），service 仅数据面
│   │   ├── service/         # 应用服务 + 基础设施：组合根与玩家子模块(PlayerDataManager 等位于根、player/ 存放玩家子模块)/玩法模块(按五文件约定)/activity(每活动一包)/router/shared/util
│   │   └── (根文件)          # 基础设施例外：app.ts/routes.ts/request-context.ts/resp-schema.ts/auth-strategy.ts
│   └── utils/              # 工具函数
├── data/                   # 数据文件
│   ├── announce/           # 公告数据
│   ├── crisis/             # 危机合约数据
│   ├── crisisV2/           # 危机合约V2数据
│   ├── excel/              # Excel 数据表
│   ├── gacha/              # 抽卡数据
│   ├── rlv2/               # 肉鸽V2数据
│   ├── shop/               # 商店数据
│   ├── tower/              # 爬塔数据
│   └── user/               # 用户数据
├── hook/                   # Frida hook 脚本
├── scripts/                # 脚本工具
└── .trae/specs/            # 设计规范文档
```

### 2.2 目录职责说明

| 目录 | 职责 | 文件组织方式 |
|------|------|-------------|
| `app/core/` | 基础设施内核：config/db/logs/utils/auth | 被依赖方，禁止 import game/ops |
| `app/game/` | 业务（特性切片）：`kernel/`（PlayerDataManager 组合根、PlayerStatus、player-composition、events 事件契约+总线、http 路由契约基建、inventory-pipeline、共享 util）、`excel/`（游戏数据 + 生成类型）、`modules/<mod>/`（一业务模块一目录：routes.ts 薄路由 + manager/业务 + rules/types + public.ts 对外出口）、`modules/activities/<family>/`（活动族：router.ts+logic.ts，共享逻辑在 `activities/shared/`） | 不设 domain/service/manager 目录；模块间仅可 import 对方 `public.ts` 或走事件总线（守卫见 `tests/unit/architecture/module-boundary.test.ts`） |
| `app/ops/` | 运营设施：admin/capture/proxy/updater/plugin/assets | 可依赖 core 与 game 模块的 public.ts |
| `data/excel/` | 游戏配置数据表，JSON格式 | 与Excel类属性一一对应 |
| `data/user/` | 用户数据存储，包括玩家数据和配置 | 按用户ID划分文件 |
| `scripts/` | 脚本工具，包括数据更新、类型生成等 | 每个脚本对应一个功能 |

---

## 3. TypeScript编码规范

### 3.1 命名约定

| 类型 | 规范 | 示例 |
|------|------|------|
| 接口 | PascalCase | `PlayerDataModel`, `CharacterData` |
| 类 | PascalCase | `PlayerDataManager`, `Excel` |
| 枚举 | PascalCase | `ItemType`, `Rarity` |
| 类型别名 | PascalCase | `ServerItemTable`, `FriendDataWithNameCard` |
| 属性/方法 | camelCase | `playerData`, `updatePlayerData` |
| 私有属性 | 下划线前缀 + camelCase | `_playerdata`, `_changes` |
| 常量 | UPPER_CASE_SNAKE_CASE | `MAX_AP`, `DEFAULT_PORT` |
| 文件 | kebab-case | `player-data-manager.ts`, `game-data-const.ts` |

### 3.2 类型定义规范

#### 3.2.1 接口定义
- 使用 `interface` 定义数据结构
- 接口命名使用 PascalCase
- 字段命名使用 camelCase
- 对于不确定的类型，使用 `any` 但需谨慎

```typescript
export interface PlayerStatus {
  nickName: string;
  level: number;
  exp: number;
  flags: { [key: string]: number };
}
```

#### 3.2.2 枚举定义
- 使用 `enum` 定义枚举类型
- 枚举名称使用 PascalCase
- 枚举值使用 UPPER_CASE_SNAKE_CASE

```typescript
export enum ItemType {
  MATERIAL = 1,
  CONSUMABLE = 2,
  EQUIPMENT = 3,
}
```

#### 3.2.3 类型别名
- 使用 `type` 定义复杂类型或联合类型
- 类型别名名称使用 PascalCase

```typescript
export type ServerItemTable = { [key: string]: ItemData };
export type FriendDataWithNameCard = PlayerSocial & { nameCardId: string };
```

### 3.3 函数结构规范

#### 3.3.1 函数声明
- 必须标注参数类型
- 必须标注返回值类型（除非返回 void）
- 异步函数使用 `async/await`
- 使用 JSDoc 注释描述函数用途

```typescript
/**
 * 获取玩家数据管理器
 * @param uid - 用户ID
 * @returns 玩家数据管理器实例
 */
async getPlayerData(uid: string): Promise<PlayerDataManager> {
  return this.data[uid];
}
```

#### 3.3.2 参数规范
- 参数命名使用 camelCase
- 参数必须标注类型
- 对于可选参数，使用 `?` 标注

```typescript
async setFriendAlias(uid: string, friendId: string, alias?: string): Promise<void> {
  // ...
}
```

#### 3.3.3 返回值规范
- 必须标注返回值类型
- 对于无返回值的函数，标注为 `void`

```typescript
async savePlayerData(uid: string): Promise<void> {
  // ...
}
```

### 3.4 类结构规范

#### 3.4.1 类声明
- 类名使用 PascalCase
- 使用 JSDoc 注释描述类的用途
- 属性在类顶部声明，按功能分组

```typescript
/**
 * 玩家数据管理器类
 * 
 * 作为单个玩家数据的核心管理类，负责协调玩家的所有子系统。
 */
export class PlayerDataManager {
  /** 背包管理器 */
  inventory: InventoryManager;
  /** 队伍管理器 */
  troop: TroopManager;
  
  constructor(playerdata: PlayerDataModel) {
    // ...
  }
}
```

#### 3.4.2 访问修饰符
- 使用 TypeScript 的访问修饰符（public/private/protected）
- 私有属性使用下划线前缀

```typescript
export class PlayerDataManager {
  private _playerdata: PlayerDataModel;
  private _changes: Patch[][];
  
  get uid() {
    return this._playerdata.status.uid;
  }
}
```

#### 3.4.3 Getter/Setter
- 使用 getter 获取私有属性
- 对于计算属性，使用 getter 而非方法

```typescript
get delta() {
  const delta = patchesToObject(
    this._changes.reduce((pre, acc) => acc.concat(pre), []),
    this._playerdata,
  );
  this._changes = [];
  return { playerDataDelta: delta };
}
```

#### 3.4.4 类内分区横幅（大类的公有/私有分区）

超过 300 行的类（或拆分后的薄委派类）应在类体内用**横幅注释**划分方法区，
对齐 OBS 的 `# ↑ 内部逻辑的公有方法 ↑ / # ↓ 内部逻辑的私有方法 ↓` 分区习惯：

```typescript
export class ExampleManager {
  // ↓ 内部逻辑的公有方法 ↓
  async publicApi() { /* ... */ }

  // ↑ 内部逻辑的私有方法 ↑
  // ↓ 内部逻辑的私有方法 ↓
  private _helper() { /* ... */ }
}
```

约定：
- 私有成员一律 `_` 前缀（§3.1），**不使用** `private` 关键字的情况仅限分区函数模块
  （`service/<mod>/logic/<section>.ts` 中被分区函数经 `mgr` 访问的成员，见 §2.2）；
- 横幅注释仅用于成员**分组语义**，不得承载行为说明（行为说明进 JSDoc）。

### 3.5 导入导出规范

#### 3.5.1 导入路径
- 使用路径别名 `@excel/*`, `@utils/*`, `@game/*`
- 避免使用相对路径 `../`

```typescript
import { PlayerDataManager } from "@game/manager/PlayerDataManager";
import { readJson } from "@utils/file";
```

#### 3.5.2 导出方式
- 使用 `export` 导出单个模块
- 使用 `export default` 导出主模块

```typescript
export class PlayerDataManager { /* ... */ }
export default router;
```

---

## 4. 路由设计规范

### 4.1 路由文件结构
- 每个业务模块对应一个路由文件（模块五文件约定的 `routes.ts` 薄壳；活动族为 `activities/<family>/router.ts`）
- 路由文件命名使用 kebab-case

```
app/game/modules/<mod>/
├── routes.ts        # 模块路由薄壳（挂载于 game/routes.ts）
└── handler.ts       # 路由处理（部分模块 handler 即路由载体）
app/game/modules/activities/<family>/
└── router.ts        # 活动族路由（聚合于 activities/index.ts）
```

### 4.2 路由注册方式
- 在 `app/game/routes.ts` 中聚合注册路由（`app/game/app.ts` 挂载该聚合根）
- 使用动态导入（`await import()`）实现懒加载

```typescript
// app/game/routes.ts
{ prefix: "/account", module: "./modules/account/routes" },
{ prefix: "/building", module: "./modules/building/handler" },
{ prefix: "/gacha", module: "./modules/gacha/handler" },
```

### 4.3 接口实现模式

#### 4.3.1 请求处理
- 使用 Express Router 定义路由
- 使用 `POST` 方法处理所有业务请求
- 通过 `httpContext` 获取玩家数据

```typescript
import { Router } from "express";
import httpContext from "express-http-context2";
import { PlayerDataManager } from "../manager/PlayerDataManager";

const router = Router();

router.post("/homeTheme/change", async (req, res) => {
  const player = httpContext.get<PlayerDataManager>("playerData")!;
  await player.home.setHomeTheme(req.body);
  res.send(player.delta);
});

export default router;
```

#### 4.3.2 响应格式
- 成功响应包含增量更新数据 `playerDataDelta`
- 额外数据通过扩展对象返回

```typescript
// 基础响应
res.send(player.delta);

// 包含额外数据的响应
res.send({
  items: [],
  ...player.delta,
});
```

#### 4.3.3 错误处理
- 使用 try-catch 捕获异常
- 返回错误信息和错误码

```typescript
router.post("/gacha/draw", async (req, res) => {
  try {
    const player = httpContext.get<PlayerDataManager>("playerData")!;
    const result = await player.gacha.draw(req.body);
    res.send({
      ...result,
      ...player.delta,
    });
  } catch (error) {
    res.status(500).send({ error: (error as Error).message });
  }
});
```

### 4.4 中间件规范

#### 4.4.1 全局中间件
- 在 `app/game/app.ts` 中注册全局中间件
- 顺序：context → bodyParser → auth → routes

```typescript
app.use(httpContext.middleware);
app.use(bodyParser.json());
app.use(async (req, res, next) => {
  // 身份验证逻辑
  next();
});
```

#### 4.4.2 路由中间件
- 对于需要特定权限的路由，使用路由级中间件

```typescript
router.post("/admin/reset", verifyAdmin, async (req, res) => {
  // 管理员操作逻辑
});
```

---

## 5. 数据模型设计规范

### 5.1 PlayerDataModel 结构

#### 5.1.1 核心结构
`PlayerDataModel` 是玩家数据的根对象，包含所有子系统数据：

```typescript
export interface PlayerDataModel {
  dungeon: PlayerDungeon;        // 地牢数据
  activity: PlayerActivity;      // 活动数据
  status: PlayerStatus;          // 状态数据
  troop: PlayerTroop;            // 队伍数据
  inventory: { [key: string]: number };  // 背包数据
  // ...其他子系统
}
```

#### 5.1.2 子系统划分
每个子系统对应一个管理器类：

| 子系统 | 管理器类 | 职责 |
|--------|----------|------|
| inventory | InventoryManager | 管理物品数量 |
| troop | TroopManager | 管理角色和队伍 |
| dungeon | DungeonManager | 管理地牢进度 |
| home | HomeManager | 管理基建和家园 |
| status | StatusManager | 管理玩家状态 |
| checkIn | CheckInManager | 管理签到记录 |
| storyreview | StoryreviewManager | 管理剧情回顾 |
| mission | MissionManager | 管理任务进度 |
| shop | ShopController | 管理商店交易 |

### 5.2 状态管理模式

#### 5.2.1 Immer 使用方式
使用 Immer 的 `createDraft` 和 `finishDraft` 进行不可变状态更新：

```typescript
async update<T>(
  recipe: (draft: WritableDraft<PlayerDataModel>) => Promise<T>,
) {
  const draft = createDraft(this._playerdata);
  const result = await recipe(draft);
  this._playerdata = finishDraft(draft, (patches, inversePatches) => {
    this._changes.push(patches);
    this._inverseChanges.push(inversePatches);
  });
  return result;
}
```

#### 5.2.2 增量更新机制
- 修改数据时自动生成变更补丁（patches）
- 通过 `delta` getter 获取增量更新数据
- 支持撤销操作（通过 inversePatches）

```typescript
get delta() {
  const delta = patchesToObject(
    this._changes.reduce((pre, acc) => acc.concat(pre), []),
    this._playerdata,
  );
  this._changes = [];
  this._trigger.emit("save", []);
  return { playerDataDelta: delta };
}
```

### 5.3 数据持久化

#### 5.3.1 存储方式
- 使用 JSON 文件 + 关系型数据库存储数据
- 玩家数据存储在 `data/user/databases/{uid}.json`
- 用户配置（账号/密钥/抽卡保底等 UserConfig）存储在**主数据层** `users` 表——`data/user/users.json` 仅作为首次迁移种子（2026-08 迁移）
- 主数据层后端可选：**SQLite（缺省，`data/user/social.db`）/ MySQL / PostgreSQL**，见 §10；战斗回放、结算信息、玩家存档与好友关系同库

#### 5.3.2 保存机制
- 通过事件触发器（TypedEventEmitter）触发保存
- 在数据变更后自动保存

```typescript
this._trigger.on("save", async () => {
  await this.savePlayerData(uid);
});
```

---

## 6. 设计模式和架构原则

### 6.1 设计模式

#### 6.1.1 单例模式
- `AccountManager` 和 `Excel` 使用单例模式
- 通过全局变量导出实例

```typescript
export const accountManager = new AccountManager();
export default new Excel();
```

#### 6.1.2 观察者模式
- 使用 `TypedEventEmitter` 实现事件发布订阅
- 用于数据变更通知和保存触发

```typescript
this._trigger.on("save", async () => {
  await this.savePlayerData(uid);
});

this._trigger.emit("save", []);
```

#### 6.1.3 组合模式
- `PlayerDataManager` 组合多个子管理器
- 通过统一接口访问所有子系统

```typescript
export class PlayerDataManager {
  inventory: InventoryManager;
  troop: TroopManager;
  home: HomeManager;
  // ...
}
```

#### 6.1.4 策略模式
- 不同功能模块使用不同的管理器策略
- 通过接口统一调用方式

### 6.2 架构原则

#### 6.2.1 分层架构
- **路由层（Router）**: 处理HTTP请求和响应
- **控制层（Controller）**: 处理复杂业务逻辑
- **管理层（Manager）**: 协调子系统数据操作
- **模型层（Model）**: 定义数据结构

#### 6.2.2 依赖注入
- 通过构造函数注入依赖
- 管理器之间通过 PlayerDataManager 共享上下文

```typescript
constructor(player: PlayerDataManager, trigger: TypedEventEmitter) {
  this.player = player;
  this._trigger = trigger;
}
```

**端口与组合根（2026-09 落地）**。依赖分三层，落地口径固定：

1. **构造注入（已完成，全量）**：子管理器统一 `(player, trigger)`；`PlayerDataManager(playerdata, battleStore?, deps?)`
   的 `deps.modules` 可部分覆写子模块。
2. **组合根工厂**：`kernel/player-composition.ts`（25 子模块）、`modules/roguelike/rlv2-composition.ts`（8）、
   `rlv2-module-composition.ts`（14 主题模块）。**new 顺序 = 事件订阅顺序 = 派发顺序**，由
   `tests/unit/architecture/composition-order.test.ts` 锁定，不可「顺手整理」。
3. **端口注入（新增）**：跨层能力收敛为接口 + 缺省绑定单例，测试注入替身即可，无需 `vi.mock` 模块打桩。
   - `kernel/excel-port.ts` → `ExcelData`（表 + 门面方法），经 `player.excel` 访问；
     模块层不得直连 `@excel/excel` 单例，棘轮守卫
     `tests/unit/architecture/excel-singleton-ratchet.test.ts` + `excel-singleton-baseline.json`（只减不增）。
     数据目录经 `excel/excel-data-dir.ts` 解析（`setExcelDataDir`/`ARKNIGHTS_EXCEL_DIR`，默认 `./data/excel`），
     为分服/夹具目录预留。
   - `kernel/http/auth-strategy.ts` → `AuthAccountPort`（`getUidByToken`/`registerUser`），
     `RealAccountStrategy(accounts = accountManager)`、`createAuthStrategy(cfg, accounts)`。
   - 既有端口：`BattleInfoStore`（战斗存储）、`CaptureRecorder`（抓包写入）。

**刻意不做**：不引入 DI 容器（tsx/vitest 走 esbuild，`emitDecoratorMetadata` 不生效，装饰器式自动注入不可行）；
不把 `PlayerDataManager` 门面接口化（router 层 200+ 处 `_playerdata`/`_trigger` 直接访问是其合法用法，
接口化的收益已被 `mockPlayerData` 覆盖）。详见 `docs/依赖注入-可行性分析与落地-2026-09-10.md`。

#### 6.2.3 单一职责
- 每个类只负责一个功能
- 管理器类负责特定子系统的数据操作

#### 6.2.4 不可变状态
- 使用 Immer 确保状态不可变
- 所有数据变更通过 `update` 方法进行

---

## 7. 工具和配置规范

### 7.1 TypeScript 配置
- 使用严格模式（`strict: true`）
- 使用路径别名（`@excel/*`, `@utils/*`, `@game/*`）
- 编译目标为 ES6

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "es6",
    "strict": true,
    "baseUrl": ".",
    "paths": {
      "@excel/*": ["app/game/excel/*"],
      "@utils/*": ["app/utils/*"],
      "@game/*": ["app/game/*"]
    }
  }
}
```

### 7.2 ESLint 配置
- 使用 TypeScript ESLint
- 使用 Prettier 进行代码格式化
- 遵循推荐规则

### 7.3 脚本命令
- `pnpm start`: 启动开发服务器（nodemon）
- `pnpm run build`: 编译 TypeScript
- `pnpm run update`: 更新游戏数据并生成类型
- `pnpm run test`: 运行测试
- `pnpm run update -- --offline`: 以完全离线模式校验本地数据完整性（不联网）
- 启动参数：`--offline` / `-o`（完全离线模式）、`--skip-update` / `-s`（跳过更新）

### 7.4 PlayerDataModel 类型生成

`app/game/excel/types-playerdata.ts` 是**运行时 PlayerDataModel 的唯一权威定义**——`app/game/kernel/playerdata.ts` 直接 `export *` 该文件（手写模型已全量替换删除），`app/game/modules/character/char.ts` 等对生成模型重叠类型做桥接 re-export。由官服反编译自动生成（客户端闭包 + 服务端协议适配 + 线格式适配），线格式经真实官服存档标量+结构双维度校验。

- 输入：`reference/com.hypergryph.arknights_<版本>.cs`（官服反编译，`reference/` 已被 gitignore，不入库；**文件名内嵌客户端版本号，每次客户端更新都会改名**——脚本统一经 `scripts/lib/cs-source.ts#resolveCsFile()` 通配探测最新，禁止硬编码版本号）
- 命令：`pnpm run generate:playerdata`
- 产物：纯闭包 802 类 / 113 枚举，含增量新增类型；`ListDict<K,V>` 映射为字典 `{ [key: K]: V }`（与真实存档 JSON 一致）
- 链路：`scripts/playerdata-parser.ts`（括号配对解析、完整枚举值、类型映射）→ `scripts/playerdata-builder.ts`（类型闭包、TS 生成、未定义引用自检）→ `scripts/playerdata-server-adapt.ts`（服务端协议适配 + 线格式适配）→ `scripts/generate-playerdata-types.ts`（CLI）
- **服务端协议适配层**（`scripts/playerdata-server-adapt.ts`）：客户端 2.7.61 模型与服务端 JSON 序列化协议分叉（服务端保守旧 key + 超集，如 `PlayerCharacter` 的 skin/tmpl 双结构并存）。适配层三操作：`renameFields`（客户端字段名→服务端 key，如 campaign→campaignsV2、towerId→tower、godCardId→id）、`addFields`（服务端独有字段，如 PlayerStage.startTimes/practiceTimes、商店 curShopId/info、房间 buff 结构）、`overrideFields`（结构差异，整接口转类型别名如 PlayerActivity 字典、PlayerBuilding.rooms 具名 12 房间类型、MissionPlayerDataGroup 索引字典）
- **线格式适配（wire pass）**：官服 JSON 把枚举/时间戳/布尔系统性降为数字——枚举字段→`number`（保留枚举定义作参考）、`System.DateTime`→`number`（unix ts）、布尔→`number`（0/1）；少数字符串序列化枚举（`roomId` "CONTROL"、`mode` "NORMAL"、`type` "CHAR" 等）与真实布尔（`avail`、`unlock` 等）经抓包标量审计反推的白名单保留
- **校验闭环**：`pnpm exec tsx scripts/validate-playerdata-json.ts --input test.json --root user`（官服账号文件 test.json 的 user 根路径）——**0 缺失 / 0 大小写差异 / 0 结构不匹配 / 0 标量不匹配**（95,694 节点）；`--input player_data.json`（官服大存档）同样全 0（107,515 节点）；`--input tmp/official/account/syncData/2026-08-09T07-31-24-506Z.json --root user`（最新抓包）同样全 0（95,977 节点）。清单增量维护流程：校验报告 → 更新适配清单 → 重生成 → 再校验
- 校验器含标量叶子类型比对（number/string/boolean/枚举字面量/基础类型联合）与 untyped 盲区报告（`object` 型字段路径）；已知线格式分歧（如 `flags` 官服 '1' 字符串 vs 运行时 number）在 `SCALAR_EXCEPTIONS` 文档化
- 运行时替换：`app/game/kernel/playerdata.ts` 为生成模型 re-export；`app/game/modules/character/char.ts` 保留生成模型不含的服务端社交/分享类型；rlv2 子系统（`app/game/modules/roguelike/rlv2-model.ts`）为功能实现内部模型，与生成模型在路由边界显式桥接

### 7.4.1 excel 表类型生成（从 cs）

`app/game/excel/types_excel_gen.ts` 从 cs 反编译生成 **47 个 excel 表的权威类型**（1480+ 类 / 349+ 枚举），`app/game/excel/excel.ts` 的 55 个表类型引用与 troop/mission/mailCollection/mockExcel 等直接引用方均已从 FBS 版 `types_auto_gen.ts` 切换过来（FBS 版已删除，不再依赖 OpenArknightsFBS）。以 `data/excel/*.json` 全量校验 **0 缺失 / 0 大小写 / 0 结构 / 0 标量**（3.29M 节点）。

- 命令：`pnpm run generate:excel`；链路：`scripts/types-builder.ts`（统一构建器：C# 数组 `X[]`、泛型 `Undefinable<T>`/`KeyFrames<T>`、类继承字段合并、`abstract class`、List 继承 → 数组别名，多根闭包）→ `scripts/excel-server-adapt.ts`（表根映射 + rename/add/override/optional/枚举补充/字段覆盖/索引签名）→ `scripts/generate-types.ts --excel`（CLI，统一生成器）
- **表根映射** `EXCEL_TABLE_ROOTS`：表键 → cs 根类（包装类如 StageTable/ZoneTable/ActivityTable，元素类如 CharacterData/SkillDataBundle，多根表如 enemy_handbook_table 按 key 映射）；由 JSON 顶层结构 × cs 类字段匹配自动反推
- **excel 线格式与 playerdata 不同**：枚举为字符串（`position:"RANGED"`）、bool 为 true/false、时间戳为 number——**无需 enum→number wire pass**；个别数值/字符串混合字段（spType/professionMask/direction）用 `number | string` 字段覆盖
- **校验闭环** `scripts/validate-excel-json.ts`：复用 playerdata 校验器 walk 逻辑，字典表/包装表/多根表三模式；`--tables t1,t2` 子集迭代，`--full` 输出聚合报告
- 已知结构分叉的适配实例：`StageData_DisplayDetailRewards`（JSON 为 DisplayRewards 基类字段 + occPercent）、`CharacterData_MainSkill`（JSON 用旧字段名 levelUpCostCond/unlockCond）、`TowerCurrent_GameCard`（C# 继承 PlayerCharacter，整接口覆盖补全）、`PlayerBuildingChar_BubbleContainer` 等

### 7.5 代码注释规范
- 使用 JSDoc 格式注释
- 每个类和函数都必须有注释
- 注释描述功能、参数和返回值

```typescript
/**
 * 获取玩家社交信息
 * 
 * 包含昵称、等级、助战角色、勋章板等信息。
 * @returns 玩家社交信息对象
 */
get socialInfo(): FriendDataWithNameCard {
  // ...
}
```

---

## 8. 启动模式与离线支持

### 8.1 启动模式总览

| 模式 | 触发方式 | 网络行为 | 适用场景 |
|------|----------|----------|----------|
| 在线更新（默认） | 直接启动 / `pnpm start` | 官方 CDN 热更管线（`scripts/official-excel.ts --download --decode --convert`，纯 TS 零 Python 依赖、**不依赖任何第三方数据仓库**）：拉热更清单 → 下载 excel bundle → UnityFS 解包 + FBO/AES 解码 → 转换；随后生成类型（CS 反编译源）、同步版本；失败自动回退本地缓存 | 首次部署、需要更新游戏数据 |
| 跳过更新 | `--skip-update` / `-s` | 跳过热更管线，仍执行类型生成（CS 反编译源）、版本同步 | 本地数据完整、希望快速启动 |
| 完全离线 | `--offline` / `-o`，或 `data/config.json` 中 `"offline": true` | **零网络操作**：不拉清单、不下载、不调用 npx | 无网络 / 内网 / 演示环境 |

### 8.2 完全离线模式设计原则

1. **零网络访问**：不执行任何 git 命令，不发起任何 CDN 请求，不通过 pnpm exec 启动需要联网的子进程，从根源上杜绝网络请求和长时间超时等待。
2. **启动前校验**：在加载数据表之前，对本地必需数据文件清单（`REQUIRED_DATA_FILES`，共 66 个文件）做完整性检查。
3. **快速失败**：数据缺失时立即退出（exit code 1），列出缺失文件清单并给出解决指引，绝不带病启动。
4. **两级版本校验**：① `data_version.txt#VersionControl` vs `gamedata_const#dataVersion`（`verifyLocalDataVersion`）；② **各表刷新批次一致性**（`verifyTableFreshness`，读 `data/excel/*.json.meta.json` 溯源指纹，极差 >1h 即告警）——仅有版本号无法发现「28/63 张表停留在旧批次而版本号恰好相同」的假通过。

### 8.3 校验范围

| 分类 | 路径 | 数量 |
|------|------|------|
| 应用配置 | `data/config.json`、`data/appConfig.json` | 2 |
| 用户数据 | `data/user/users.json` | 1 |
| Excel 数据表 | `data/excel/*.json` | 50 |
| 肉鸽/卡池 | `data/gacha_detail_table.json` | 1 |
| 商店数据 | `data/shop/*.json` | 11 |

校验实现位于 `scripts/update-data.ts` 的 `verifyLocalData(baseDir)`：基于 `REQUIRED_DATA_FILES` 清单过滤出不存在的文件，返回缺失列表；入口 `index.ts` 在离线模式下先执行该校验，返回非 0 则终止启动。

### 8.4 启动流程

```
启动 index.ts → 解析命令行参数
  │
  ├─ offline=true（--offline / -o / config.offline）
  │     └─ verifyLocalData()
  │           ├─ 数据缺失 → 打印缺失清单 + 解决指引 → exit(1)
  │           └─ 数据完整 → excel.init() → 监听端口 → 启动完成
  │
  ├─ skipUpdate=true（--skip-update / -s）
  │     └─ 跳过更新 → excel.init() → 监听端口
  │
  └─ 默认（在线更新）
        └─ git 拉取 + 复制数据 + 生成类型 + 合并 gacha
              └─ 成功 → excel.init() → 监听端口
              └─ 失败 → 回退本地缓存 → excel.init() → 监听端口
```

---

## 9. 管理后台设计规范

### 9.1 功能定位
管理后台面向服主，提供 CLI（`pnpm run admin`，离线可用）与 Web Dashboard（`/admin/dashboard`）两套入口，
覆盖用户全生命周期（建/查/改/批量/备份/导出导入/删除/修复）、物品/干员/皮肤发放、卡池管理、
关卡/任务/勋章/商店只读、邮件（单发/群发/查看/删除）、官服账号迁移、接口调试、统计、审计与一键启动。

### 9.2 架构
- **共享服务层 `app/admin/AdminService.ts`**：纯逻辑层，CLI 与 HTTP 共用（`adminService` 单例）。
  所有写操作统一 `pd.update`（Immer）+ `accountManager.flushSave(uid)` 落盘 + `_audit` 审计日志（`data/admin/logs.jsonl`）。
- **CLI `scripts/admin-cli.ts`**：无参数进入 REPL（Tab 补全）；全局 `--quiet/-q` 抑制内部日志（`LOG_LEVEL=error`，logger 运行时求值）；
  输出支持 `--json` / `--csv`。
- **HTTP 管理 API `app/admin/admin-router.ts`**：前缀 `/admin/api`，Token 认证（`admin-auth.ts`，`X-Admin-Token` 头）。
- **Dashboard `app/admin/dashboard/index.html`**：单文件静态页（内联 CSS/JS，零构建依赖），10s 轮询，全部注入走 `escapeHtml`。
- **端点规范 `app/admin/api-spec.ts` + `openapi.ts`**：`ADMIN_ENDPOINTS` 一份清单同时驱动接口控制台与 `GET /admin/api/openapi.json`（OpenAPI 3.0 文档）。
- **游戏协议代理 `AdminService.gameProxy`**：以玩家 secret 调用游戏端点（`game/app.ts` 锁中间件跳过 `/admin` 路径——
  否则 single 模式外层 admin 请求持有 singleUid 锁、内层代理等待同一把锁会死锁）。

### 9.3 配置
`data/config.json` 新增 `admin` 段：
- `enable`：是否开启 HTTP 管理接口（默认 `false`，安全默认）
- `token`：管理 API Bearer Token（服主自行修改）

### 9.4 安全
- 管理接口默认关闭；开启必须设置强 token。
- **危险操作双确认**：`users delete` 需 `--yes` + 服务端 `confirmWord="DELETE"`；`restore` 文件名白名单
  `^{uid}-[\d-]+\.json$` 防路径穿越；`gameProxy` 拦截 `/admin`、`/auth` 控制面路径。
- **审计日志**：所有变更操作（发放/邮件/建号/卡池/迁移/备份/删除/修复…）写入 `data/admin/logs.jsonl`，
  CLI `logs show` / Dashboard「操作日志」区块可查。
- 建议仅在内网/本机暴露；Dashboard 页面免认证，但所有 API 请求必须携带令牌。

### 9.5 数据一致性
- 写操作统一 `pd.update` + `flushSave`（`savePlayerData` + `saveUserConfig`），删除账号依赖 `upsertAll` 全量同步语义清 SQLite。
- 创建用户采用模板复制（uid=1 存档）保证字段完整，`reloadUser` 热加载进内存；官服迁移成功后逐个热加载。
- 干员引用（ID/中文名）统一走 `admin-names.resolveCharRef`；星级用 `charRarity` 归一化
  （character_table 的 rarity 为 `"TIER_5"` 字符串，`rarity + 1` 会变字符串拼接）。
- `runMigration` 接收账号**内容文本**（CLI 读文件、Dashboard 粘贴共用）；scripts 模块被 app/ 引用后纳入 tsc 编译。

### 9.6 CLI 命令一览
```
users list [--json|--csv] [--filter 关键字] | users info <uid>
users create <phone> [password]
users grant <uid[,uid...]> <itemId|名称> <count> | users grantall <uid> [count]
users grantchar <uid> <charId|干员名> | users skin <uid> <skinId>
users chars <uid> | users char <uid> <instId> [--level/--evolve/--potential/--skill]（无参数=详情）
users maxout <uid> | users maxchars <uid> | users repairchars <uid>
users stages <uid> | users unlock <uid> <stageId> | users unlockall <uid>
users items <关键字> | users missions <uid> | users medals <uid> | users shop <uid>
users backup <uid> | users backups <uid> | users restore <uid> <备份>
users dump <uid> [--pretty] | users export <uid> [path] | users import <存档JSON> [uid]
users delete <uid> --yes
mail send <uid[,uid...]|all> <subject> [content] [--items id:count,...] | mail list <uid> | mail delete <uid> <mailId>
server status | server refresh <uid> | server save [uid] | server check
config show | config set <key> <value>
gacha pools | gacha pool <poolId> | gacha state <uid> <poolId> | gacha up <uid> <poolId> [charId...] | gacha pity <uid> [ruleType] [count]
official accounts <file> | official migrate <file> [--template uid]
logs show [--last N] [--json]
全局：--quiet/-q（抑制日志）；无参数进入 REPL（Tab 补全）
```

### 9.7 REST API 一览（52 端点，前缀 /admin/api）
- 服务器/配置：`status`、`config`、`check`、`logs`、`spec`、`openapi.json`、`common-items`、`items`（搜索）、`stats`
- 用户：`users`（?filter=）、`users/:uid`、`users`（POST 建号）、`users/:uid/grant`、`grantchar`、`grantskin`、
  `chars`、`chars/:instId`（详情）、`chars`（POST 编辑）、`maxout`、`maxchars`、`repair-chars`、`building-max`、
  `grant-all`、`stages`、`stages/unlock`、`stages/unlock-all`、`missions`、`medals`、`shop`、`raw`、`mails`、`mails/:mailId`（DELETE）、
  `pools/:poolId`（玩家状态）、`pools/:poolId/up`、`pity`、`backup`、`backups`、`restore`、`export`、`refresh`、`save`
- 邮件/卡池/迁移：`mail`、`mail/all`、`pools`、`pools/:poolId`、`official/migrate`、`import`
- 调试：`game-proxy`（带玩家 secret 调游戏端点）

### 9.8 Dashboard 功能区块
概览（资源中文名网格 + 签到区 + 一键满配/基建/刷新/保存/备份/恢复 + 发干员/发皮肤）| 干员（星级分布条/搜索/详情弹窗/行内编辑/全部满级/修复结构）|
邮件（列表/删除/群发）| 卡池（清单/详情 + 玩家 UP/保底管理）| 接口（管理 API 控制台 + 游戏协议调试器 + OpenAPI 链接）|
迁移（官服迁移 + 官服操作 + 通用调用 + 卡池同步）| 数据（raw JSON 复制/下载）| 统计（默认折叠摘要）| 操作日志 | 用户列表搜索/分页

### 9.9 Dashboard 交互与视觉规范（2026-08 UI 升级）
- **零依赖约束**：单文件 `index.html`（内联 CSS/JS）+ `manifest.webmanifest` + `icon.svg`，无构建链、无框架。
- **布局**：`.layout` flex——左侧垂直侧边栏（8 Tab：概览/干员/邮件/卡池/接口/官服/像素画/数据）+ 右侧内容区；
  全局功能 Tab（接口/官服/卡池）不依赖选中用户、隐藏用户列表内容全宽；用户 Tab 未选用户时提示。
- **官服工具库**：独立「官服」页——tool-card 卡片网格（游戏工具库风格，点击卡片头展开/收起）：共享账号凭据 +
  状态/签到/邮件/一键日常/通用调用/卡池同步/账号迁移 7 工具，结果区复制按钮；当前后端地址显示。
- **通知**：Toast 替代 `alert`（自动着色 + 3s 消失；带 detail 时点击复制详情）；危险操作 `confirmDialog` 风险分级
  （danger 红标红底 / warn 黄标）。
- **轮询**：10s 只刷状态 + 用户列表（编辑输入框时跳过），统计/日志 30s；Tab 状态保持（切 Tab 回来恢复输入）。
- **主题**：CSS 变量 + `[data-theme=light]` 浅色覆盖；手动切换 + localStorage，未选择时跟随系统 prefers-color-scheme。
- **状态色语义**：`--ok/--err/--star5/--star4` 统一干员星级、邮件状态等；即时输入校验（数量/JSON 实时红框）。
- **数据展示**：星级分布条、分页（每页 50）、骨架屏、相对时间（fmtRel + tooltip 完整时间）、术语 tooltip、首次引导卡片。
- **批量多选**：用户列表复选框 + 全选 + 批量栏（发物品/发邮件/一键满配/清空），modal 批量模式循环发送。
- **导航**：URL hash 同步 Tab（#pools 直达/前进后退）；全局快捷键（/ u r 1-7）。
- **多端**：`@media (max-width:900px)` 侧边栏转顶部横排可滚动、内容单列；PWA manifest（不做 service worker——
  与 no-cache 冲突）；`@media print` 只保留详情内容。
- **缓存**：`/admin/dashboard` 与 manifest/icon 均 `no-cache`——单文件无版本号，禁止浏览器缓存旧版。
- **快捷键**：`/` `u` 聚焦搜索、`r` 刷新、`1-7` 切 Tab（非输入框时生效）。
- **代码质量**：内联 JS 用 `node --check` 语法校验（sed/批量改后必查括号配对），每批服务器页面冒烟。

### 9.10 关键设计决策
- **CLI 与 HTTP 共用 AdminService**：新增能力先在服务层实现 + 单测，再分别接 CLI / router / Dashboard，避免三端逻辑漂移。
- **scripts 引用策略**：AdminService 直接 import scripts 模块（`migrate-official`、`generate-max-account`），
  使其纳入 tsc 编译（曾暴露 `official-register` 潜在类型错误）；共享构建器（`buildMaxedSkills` 等）迁至 `app/game/maxout.ts`。
- **parseArgs 吞值**：`--quiet users list` 会把 `users` 当 flag 值吞掉——全局 flag 解析前先从 argv 剔除。
- **状态修复闭环**：`server check` 诊断（status/troop/干员字段/阿米娅 tmpl）→ `users repairchars` 修复 → 复检，形成闭环。

---

## 附录

### A. 常用类型定义位置
| 类型来源 | 文件路径 | 说明 |
|----------|----------|------|
| CS自动生成 | `app/game/excel/types_excel_gen.ts` | excel 表权威类型（1470+ 类 / 347+ 枚举，原 FBS 版 types_auto_gen 已删除） |
| PlayerDataModel | `app/game/excel/types-playerdata.ts` | 796个接口，1065个枚举 |
| Excel数据表 | `app/game/excel/excel.ts` | 统一管理所有数据表 |

### B. 状态管理流程
```
1. 路由接收请求
2. 获取 PlayerDataManager 实例
3. 调用子管理器方法
4. 子管理器使用 update() 修改数据
5. Immer 生成变更补丁
6. 通过 delta 返回增量更新
7. 触发 save 事件保存数据
```

### C. 数据更新流程
```
1. 启动时执行 update-data.ts
2. 官方 CDN 热更管线：拉热更清单 → 下载 excel bundle → UnityFS 解包 + FBO/AES 解码
3. 转换为服务端格式（camelCase + 枚举字符串）并写入 data/excel/（旁挂 *.meta.json 溯源指纹）
4. 官服热更 anon 资源 Lua 自动提取（非致命）
5. 生成 types-playerdata.ts + types_excel_gen.ts（统一 CS 反编译源生成器）
6. 同步游戏版本（syncGameVersion）
7. 加载 Excel 数据表
8. 启动服务器
```

> gacha 卡池详情（`data/gacha_detail_table.json`）**不在本管线生成**（`data/gacha/` 源目录已移除），由 `pnpm run admin -- official gacha-sync` 从官服同步。
>
> 完全离线模式（`--offline`）跳过步骤 2-6，仅校验本地数据完整性（`verifyLocalData`）+ 版本一致性（`verifyLocalDataVersion`）+ 各表刷新批次（`verifyTableFreshness`）后直接进入步骤 7；数据缺失时退出并提示先联网执行 `pnpm run update`。

---

## 10. 好友系统与主数据层（多后端）

### 10.1 数据存储
好友关系数据（好友列表、好友申请、访问记录）、**用户账号配置**（UserConfig）、战斗回放/结算信息与**玩家存档**
统一存放在**主数据层**，支持三种可选后端：

| 后端 | 驱动 | 说明 |
|---|---|---|
| `sqlite`（缺省） | Node 24 内置 `node:sqlite` | 零第三方依赖，单文件 `data/user/social.db`；行为与历史版本完全一致 |
| `mysql` | `mysql2`（optionalDependencies） | 需 `pnpm add mysql2`（已列入 optionalDependencies）；驱动运行时动态加载 |
| `postgresql` | `pg`（optionalDependencies） | 需 `pnpm add pg`；同上 |

未安装可选驱动不影响启动——只有显式选用该后端时才会加载并给出带安装指引的错误。
`data/user/users.json` 中的 `social` 字段仅作为首次迁移来源，迁移后不再作为数据源（重置为空结构）。
**2026-08 起 users.json 整体退化为首次迁移种子**——`AccountManager.init` 在 `users` 表为空时导入，之后用户配置以数据库为唯一事实源（`saveUserConfig` 只写库，不再写 users.json）。
SQLite 库文件为运行时生成产物，已在 `.gitignore` 中忽略，不加入离线校验清单（REQUIRED_DATA_FILES，users.json 种子文件保留在清单中）。

### 10.2 表结构
表规格声明在 `app/core/db/schema.ts`（声明式 `TABLES`），由 `buildSchemaSql(backend)` 生成三种后端的 DDL：

- `friends(uid, friend_uid, alias, create_ts, star)`：好友关系，主键 (uid, friend_uid)；`star` 为星标标记（上限 `gamedata_const.maxStarFriendNum`）
- `friend_requests(from_uid, to_uid, create_ts)`：好友申请，主键 (from_uid, to_uid)
- `friend_request_log(from_uid, to_uid, last_ts)`：申请冷却基准（`requestSameFriendCd`），申请被处理后**不删除**
- `visited(uid, visited_uid, ts)`：访问记录，主键 (uid, visited_uid)
- `users(uid, data, updated_ts)`：用户账号配置，主键 uid；`data` 为 UserConfig JSON 列
- `replays(uid, stage_id, replay, updated_ts)`：战斗回放，主键 (uid, stage_id)
- `battle_infos(uid, battle_id, info, updated_ts)`：战斗结算信息，主键 (uid, battle_id)
- `battle_records(battle_id, uid, stage_id, record, created_ts)`：战斗结束记录留存，主键 (battle_id, uid)
- `player_data(uid, data, updated_ts)`：玩家存档（gzip 二进制文档，替代 `databases/*.json` 全量写）

**类型映射**（`schema.ts#physicalType`）：`uid`/`text` → SQLite `TEXT` / MySQL `VARCHAR(191)` / PG `TEXT`
（MySQL 的 TEXT 不能作主键，且 utf8mb4 下索引键长上限 3072 字节，191×4=764 安全）；
`longtext` → `TEXT`/`LONGTEXT`/`TEXT`；`bigint` → `INTEGER`/`BIGINT`/`BIGINT`
（毫秒时间戳 1.7e12 超出 INT4 上限，必须 64 位）；`blob` → `BLOB`/`LONGBLOB`/`BYTEA`。

MySQL 的二级索引内联为 `KEY`（MySQL 不支持 `CREATE INDEX IF NOT EXISTS`），SQLite/PG 用独立 `CREATE INDEX IF NOT EXISTS`——
三种后端的建表脚本因此都保持**幂等**。

### 10.3 架构（`app/core/db/`）
- `types.ts`：多后端契约——`SqlDatabase`（`prepare`/`exec`/`transaction`/`close`/`isOpen`）、`SqlStatement`（`get`/`all`/`run`）、`DatabaseOptions`。**接口全异步**：`node:sqlite` 是同步 API，mysql2/pg 只能异步，统一以 Promise 暴露后三种驱动行为一致（SQLite 驱动内部同步执行后立即 resolve）
- `dialect.ts`：方言纯函数——`insertIgnoreSql`（`INSERT OR IGNORE`/`INSERT IGNORE`/`ON CONFLICT DO NOTHING`）、`insertReplaceSql`（`INSERT OR REPLACE`/`ON DUPLICATE KEY UPDATE`/`ON CONFLICT … DO UPDATE`）、`convertPlaceholders`（`?` → `$n`，跳过字符串字面量与注释）、`normalizeParams`、`toCount`
- `schema.ts`：声明式表规格 + 三种后端 DDL 生成（见 §10.2）
- `introspect.ts`：跨后端结构探测（`columnExists` / `addColumnIfMissing`）——`CREATE TABLE IF NOT EXISTS` 不会给既有表补列，加列须先探测
- `drivers/sqlite.ts` / `drivers/mysql.ts` / `drivers/postgres.ts`：三个 `SqlDatabase` 实现（MySQL/PG 为连接池 + 独占连接事务，驱动经 `drivers/load.ts` 动态加载）
- `database.ts`：单例入口——`openDatabase()`（建连 + 建表 + 结构迁移，复用前用 `isOpen()` 剔除已关闭连接）、`getDatabase()`、`closeDatabase()`、`createDatabase()`（不走单例，供跨后端搬迁同时持有两个连接）
- `config.ts`：连接配置解析（入参 > 环境变量 > `config.json`）与日志描述（不含密码）
- `friend-repo.ts` / `user-repo.ts` / `replay-repo.ts` / `player-data-repo.ts`：仓储层，只写 `?` 占位符与公共 SQL，不出现方言分支
- `migrate.ts`：`migrateFromUserConfigs` 首次启动从 users.json 导入好友数据并重置 JSON 社交字段
- `AccountManager`：init() 中 `openDatabase()` 建连一次后注入全部仓储（避免模块加载时创建数据库文件）；社交方法（getSocial/addFriend/deleteFriend/sendFriendRequest/deleteFriendRequest/setFriendAlias/getFriendRequests）委托 `SocialService`，战斗数据委托 `BattleStore`，公共签名不变
- `AccountManager._userRepo`：`configs = await getAll()`（空则迁移 users.json 种子）；`saveUserConfig` 全量 `upsertAll(configs)`（未 init 时 no-op，测试安全）
- 官服迁移脚本（`scripts/official-register.ts`/`migrate-official.ts`）注册/读取用户同样走主数据层（users.json 仅种子）
- 抓包索引（`app/ops/capture/capture-db.ts`）与资源注册表（`app/ops/assets/asset-registry/asset-db.ts`）**仍为本地 SQLite**——它们是本机缓存/索引而非业务数据，不参与后端切换

### 10.4 后端切换与配置
配置入口 `data/config.json` 的 `database` 块（缺省不存在 = sqlite 默认，零迁移成本）：

```jsonc
{
  "database": {
    "type": "mysql",            // sqlite（缺省）| mysql | postgresql
    "host": "127.0.0.1",
    "port": 3306,               // 缺省 mysql 3306 / postgresql 5432
    "user": "root",
    "password": "***",
    "database": "arknights",    // 库须预先创建（本层只建表不建库）
    "connectionLimit": 10,      // 连接池上限，缺省 10
    "charset": "utf8mb4",       // 仅 mysql
    "ssl": false
  }
}
```

优先级：`openDatabase(options)` 显式入参 > 环境变量（`DB_TYPE`/`DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`，容器化部署用）> `config.json` 的 `database` 块 > 缺省 SQLite。

**数据搬迁**：切换后端不会自动搬运数据（新库为空表）。用 `pnpm run db:migrate` 整表复制：

```bash
pnpm run db:migrate -- --dry-run     # 先看各表行数
pnpm run db:migrate                 # 源 ./data/user/social.db → 配置的后端
pnpm run db:migrate -- --force      # 目标非空时覆盖（默认拒绝执行）
```

逐表按主键覆盖写（可重复执行，不产生重复行），每 200 行一个事务；`--from-file` 可指定旧库路径。

### 10.5 业务规则
- 双向好友：同意申请（processFriendRequest action=1）时双方互加；删除好友（deleteFriend）时双方互删
- 请求校验（sendFriendRequest）：不能向自己发送；对方已是好友拒绝；重复申请拒绝
- 申请接受后同步删除申请记录，并清除接收方 pushFlags.hasFriendRequest

### 10.6 已知约束
- 游戏中间件（app/game/app.ts）将所有 secret 强制映射为 uid=1（单机私服设计），多玩家交互逻辑由单测与独立进程集成脚本覆盖
- MySQL / PostgreSQL 的**端到端链路需真实服务端**才能验证；CI 中可离线验证的部分（SQL 方言生成、占位符改写、DDL、参数归一化、可选驱动缺失时的错误文案、跨后端复制语义）由 `tests/unit/db/dialect.test.ts` 与 `tests/unit/scripts/db-migrate.test.ts` 覆盖
- 切换后端后 `users` 表会从 users.json 种子重建账号配置，但玩家存档/回放无种子来源——务必先执行 `pnpm run db:migrate`
- 单例 `openDatabase()` 一次只持有一个后端连接；需要同时连接两个库的场景用 `createDatabase()`

---

## 11. 基建系统逻辑说明

### 11.1 覆盖范围
BuildingManager（app/game/manager/building.ts）已实现完整基建玩法：
- 房间管理：建造/升级/降级/清理槽位
- 干员分配：assignChar / 批量更换（batchChangeWorkChar）/ 批量休息（batchRestChar）
- 生产：制造结算（settleManufacture）/ 贸易结算（settleSale）/ 加工合成与分解（workshopSynthesis / workshopDecomposition）/ 加速（accelerateOrder / accelerateSolution）
- 信赖：gainIntimacy / gainAllIntimacy / gainAssistIntimacy（单次量由 basicFavorPerDay 派生，默认 12）
- 线索：getDailyClue / sendClue / receiveClueToStock / putClueToTheBoard / deleteOwnClue 等 11 个方法
- 预设队列：add / delete / edit / use / useOne / changeName / saveDiy / editLock（存储于 building.presetQueues）
- 其他：buyLabor / confirmMessageBoardReward / 专精（upgradeSpecialization / completeUpgradeSpecialization）

### 11.2 实现约定
- 所有变更通过 PlayerDataManager.update（Immer）落盘
- **Excel 驱动（2026-08-07，替代硬编码简化）**：查询工具层 `app/game/excel/building_excel.ts`（getManufactFormula / getWorkshopFormula / getRoomPhase / getGoldRate / getBuildingConstant）
  - 制造结算：查 `manufactFormulas`（14 配方：F_EXP 2001-2003 / F_GOLD 3003 / F_ASC 3213-3283 / F_DIAMOND 3141）——产出 `itemId×count×outputSolutionCnt`、消耗 `costs`（MATERIAL 扣 inventory / GOLD 扣金币）
  - 贸易结算：对齐真实订单结构 `{instId, delivery:[{id,count}], gain:{id,type,count}}`——扣 delivery 物品、加 gain 物品（不再 count×500 假结算）；instId 查找
  - 加工合成：查 `workshopFormulas`（68 配方）——goldCost/costs 消耗、产出、`extraOutcomeRate` 概率触发 `extraOutcomeGroup` 加权副产物；formulaId 支持请求体传入（回退房间 formulaId）
  - 劳动力：`laborRecoverTime`（360 秒/点）自动恢复（sync 入口，封顶 maxValue）
  - 房间建造/升级：查 `rooms[roomId].phases[level].buildCost`——扣 items（MATERIAL/GOLD）与 labor
  - 信赖：单次量 = `basicFavorPerDay`（720）÷ 60（每小时量，默认 12/次），同步 troop.chars 与 charGroup
- 线索：每日一条（getDailyClue），ownStock/receiveStock/board 三区流转，**type 用 7 阵营**（RHINE/PENGUIN/BLACKSTEEL/URSUS/GLASGOW/KJERAG/RHODES）、**id 用真实格式 `{uid}#{随机}#{时间戳}`**（对齐真实存档，替代递增 clue_ID）
- 预设队列：building.presetQueues（key 为 roomSlotId），旧存档惰性初始化（_presetQueues）
- 专精：upgradeSpecialization 置技能 state=1，completeUpgradeSpecialization 提升 specializeLevel 并复位
- 家具分解：产出木材（30012），简化固定产出 count × 2

### 11.3 简化项（YAGNI）
- 社交展示类接口（getRecentVisitors / getInfoShareVisitorsNum / sendEmoji / visitBuilding 等）返回空
- 加速不消耗道具（私服友好）；buyLabor 1 源石/次 +10 劳动力（apToLaborRatio=2 为 AP→劳动力比例，未接入）
- 制造站心情消耗通过 `changeScale` 持续扣减（已接入）；`costPoint` 作为生产进度阈值（已接入，非心情成本）
- ~~加工体力消耗（apCost）~~已接入（2026-08-14，见 11.7——单位经 manpowerDisplayFactor=360000 确认）

### 11.4 干员基建技能（buff）引擎（2026-08-12 新增）
干员技能**服务端生效**：`app/game/building/buff.ts`（纯函数引擎）+ BuildingManager 集成——不再是"客户端自行计算显示"。

- **数据源**：`BuildingData.buffs`（760 个）数值字段 `efficiency`（百分比整数，15=15%）；无 efficiency 的 buff（控制中枢/宿舍/心情类）数值嵌在描述 `<@cc.vup>/<@cc.vdown>` 富文本标签内
- **激活条件**：`chars[charId].buffChar[].buffData[] = {buffId, cond:{level,phase}}`——干员 level ≥ cond.level、evolvePhase ≥ cond.phase；buff.roomType === 进驻房间
- **数值解析**：`efficiency>0` → /100；否则描述 vup 带 `%` → /100、宿舍（DORMITORY）无 `%` → 原值（点/小时）、其余无 `%`（机器人/阈值等）→ 0 不贡献（避免误读）；多 vup 标签优先取带 `%` 的（"每16个机器人+4%"→4）
- **叠加规则**：输出型（MANUFACTURE/TRADING/…）跨干员累加、同一技能（buffId 去 `[]` 后缀）取最高档（槽位多档 = 同一技能不同解锁）；控制中枢/宿舍"同种效果取最高"（与描述标注一致）
- **控制中枢全局**：`control_prod_*→MANUFACTURE / control_tra_*→TRADING / control_dorm_*→DORMITORY / control_meeting*→MEETING / control_hire_*→HIRE`，同组跨干员取最高

**集成点（时间驱动，sync/换班入口）**：
- 制造站容量 = 房间等级 `manufactData.phases[level-1].outputCapacity`（24/36/54）× (1 + 进驻干员技能加成 + 控制中枢全局加成)，回写 `room.capacity`/`room.buff.speed`——生产随时间累积受技能驱动；buff.targets（F_GOLD/F_EXP/…）按配方类型过滤
- **计划耗尽即停（2026-08-13 修复赤金异常）**：`remainSolutionCnt ≤ 0` 时停止生产——原实现 remain=0 时跳过钳制 → 产出无上限累积（制造站赤金数量异常）；现在计划完成即停摆待收取（官方行为），结算后 state=0 清空配方
- **会客室死循环/无限信用修复（2026-08-13）**：① 干员心情（`building.chars[].ap`）累积**不进 sync**——会客室会话（getInfoShareReward/startInfoShare）按该增量推进情报分享状态，若 sync 抢先推进 lastApAddTime，紧邻调用同一秒 elapsed=0 → 空 delta → 客户端死循环重拉（58 字节响应）；② `getMeetingroomReward` 发放 `status.socialPoint += daily+search` 并清零 socialReward（一次性，官方格式 `{id:"SOCIAL_PT",...}`）——原实现只透传不发放/不清零 → 无限信用点；③ `startInfoShare` 记录 `infoShare.ts=now`（会话推进，访客不再重复计信用）
- **会客室增量恒在（2026-08-13 续修）**：`_accrueCharAp` 的 `lastApAddTime` 写**浮点秒（毫秒精度）**——秒级整型在客户端紧邻重拉（同一秒多次调用）时无法变化 → 空 delta → 无限重复获取；浮点秒保证任意两次调用（≥1ms 间隔）必有增量；`getInfoShareReward` 同时**推进 `infoShare.ts=now`**（官方响应 delta 含 MEETING 房间 + socialPoint 信用发放）——同一批访客首次调用后即"旧"，不再重复计信用
- **infoShare.reward 待领取指示（2026-08-13 再修）**：官方 `infoShare.reward` 为 **0/1 待领取指示**（抓包：sync/结算等基建请求响应为 1，getInfoShareReward 处理后归 0）——`sync`/`getInfoShareReward`/`startInfoShare` 按 `socialReward.daily+search > 0` 置 1，`getMeetingroomReward` 领取后归 0；原实现硬编码 0 → 客户端红点/领取状态不刷新
- **收获后一键补货（2026-08-13）**：`changeManufactureSolution`（客户端收获后补货入口：settle → 同配方 + 补满数量）响应补 `change` 字段（官方 BuildingChangeManufactResponse，抓包 6 例均 false——服务端确认标识，方案按请求生效）；收获已耗尽计划后该接口重启同配方（state=1、remain=补货量、output/processPoint 归零、lastUpdateTime=now），链路真实存档验证通过
- **换班协议对齐（2026-08-13）**：官方 `BuildingBatchChangeWorkCharRequest`/`BuildingBatchChangeRestCharRequest` **无字段**（Python 参考亦返回 `{}, 202`）——实际换班/清人走 `assignChar`（每房间一条，清人 `assignChar [-1]`，抓包证实）；`batchChangeWorkChar`/`batchRestChar` 兼容字段名变体（roomSlotId/slotId、charInstIdList/charInstIds/list），空请求体按官方不改分配；新增 `/cleanRoom` 路由（CS `BuildingCleanRoomRequest`，原仅 `/cleanRoomSlot`）
- **预设队列对齐官方模型（2026-08-13）**：预设队列存 **`room.presetQueue`（number[][] 按索引）**（MANUFACTURE/TRADING/POWER/CONTROL/MEETING/HIRE），请求字段 `slotId` + `index`（CS：Add{slotId} / Use/Delete/Edit{slotId,index}，Add 存房间当前排班）——原实现存 `building.presetQueues[roomSlotId]` 且读 roomSlotId → 客户端 usePresetQueue/useOnePresetQueue 查不到队列 → 空 delta；现按索引应用/删除/编辑，`useOnePresetQueue` 应用首个队列；名称/锁定存 `building.presetQueues` 元数据（官方线格式无名称）
- 训练室：trainee 进度 × (1 + 教官 train_* buff)
- 心情档位（`building.chars[i].changeScale`）重算：输出房间基础消耗（制造/贸易/加工 -55、会客/人力/发电 -65，AP/秒，真实存档校准）− 技能附加消耗（描述"消耗"语境 `<@cc.vdown>/<@cc.vup>` 数值 ×100，正=消耗/负=减免）；宿舍恢复 = (基础 `manpowerRecover/160` + 舒适度 `comfort/1000×0.55` + dorm_* buff + control_dorm_* 全局) × 100——5 级 5000 舒适 + 技能 ≈ 405，与真实存档吻合；未进驻 0
- 换班（assignChar/batchChangeWorkChar/batchRestChar）后立即重算档位，下次 sync 按新档位累积

### 11.5 基建系统完整性修复（2026-08-14 审计）

**协议字段别名（CS 字段名 → 服务端兼容，修复"客户端发 CS 字段 → 服务端读不到 → 空 delta/no-op"）**：
- `settleSale`：CS `roomSlotIdList[]`（原读单值 slotId）——现兼容两种形态
- `changeSaleSolution`：CS `roomSlotId/stockIndex/targetFormulaId/solutionCount`（原读 slotId/solution）——targetFormulaId→strategy、solutionCount→stockLimit
- `workshopDecomposition`：CS `furniId/times`（原读 furnitureId/count）——现兼容两种形态
- 线索系列：`sendClue`（clueId）/`receiveClueToStock`（clues[]）/`putClueToTheBoard`/`deleteOwnClue`/`deleteReceiveClue`（clueId）——全部兼容 CS 字段
- `changePresetName`：兼容 `name`（CS BuildingDIYRenamePresetSolutionRequest.solutionId/name）

**房间管理**：
- `buildRoom`：① 建造前资源足额校验（不足拒绝，不再扣成负库存/负金币）；② 创建 `rooms[roomId][slotId]` 房间对象（客户端按类型查房间不为空）；③ 建造完成时间按 `buildCost.time` 推进
- `completeUpgradeRoom`：实际完成建造——state=1 且 completeConstructTime 已到的槽位置 2（原实现只刷新 event.building → "建造中"卡死）
- `upgradeRoom`/`degradeRoom`：等级边界（升级钳制到 phases 上限、降级不低于 1）+ 升级前资源校验

**干员分配**：
- `assignChar`：训练室按房间类型（roomId===TRAINING）定位，不再硬编码 slot_13
- `setPrivateDormOwner`：双端同步——旧 owner 的 `chars[].privateRooms` 清除、新 owner 从其他私人宿舍迁移、`privateRooms` 写入

**生产/贸易**：
- `gainIntimacy`/`gainAllIntimacy`/`gainAssistIntimacy`：emit `GainIntimacy`（基建信赖任务推进）；`gainAllIntimacy` 同步结算助战干员并返回真实 normal/assist 计数（CS BuildingGainAllIntimacyResponse）
- `_refreshTradingOrders`：按 `room.stockLimit` 补单（原恒补 2 单）
- `changeDiySolution`：舒适度服务端计算（方案内家具 `customData.furnitures[].comfort` 求和，写回 `room.comfort`）——DIY 影响宿舍恢复
- `workshopDecomposition`：分解产物按家具 Excel 配置（processedProductId/processedProductCount），不再恒产木材×2
- `changeBGM`：同步 `music.inUse`

**会客室/每日刷新**：
- `sendClueAuto`/`putClueToTheBoardAuto`：同步 pushFlags.hasClues 红点
- `dailyRefresh`：留言板 `messageLeave.sp` 周切（周一 4:00 边界：lastWeek ← thisWeek、累计入账）
- `getInfoShareVisitorsNum`/`getRecentVisitors`：返回真实好友数据（原恒 0/空）
- `getOthersMessageBoardContent`：读取对方会客室 messageLeave 返回（原纯透传）；路由合并结果（原丢弃返回值）
- `getThumbnailUrl`：返回空列表（私服无云端缩略图）

**事件接线（任务/勋章推进）**：
- `completeUpgradeSpecialization`：emit `UpgradeSpecialization`（建筑训练室路径，char.ts 直改路径已发）
- `settleManufacture`：emit `BuildingManufactureProductTimes`
- `workshopSynthesis`：emit `BuildingWorkshopSynthesisGroupByID`（formulaType 分组）
- inventory FURN 发放：emit `BuildingGotFurnitureThemeCount`（持有家具去重主题数）
- medal.ts 三个 Building 模板从 JoinGameDays 复制 stub 修正为真实计数（主题数/制造次数/按组合成次数）

**简化项（YAGNI，未建模）**：加速不消耗道具（私服友好）、发电站进驻干员对无人机充能速度的影响、制造心情消耗（costPoint）。电力系统/加工心情消耗/工坊 ws_bonus 已接入（见 11.7）。

### 11.6 基建协议完整性审计 + 线索板格式校准（2026-08-14）

**协议完整性审计（对照客户端 ServiceCode.cs 全量 60+ BUILDING_* 服务码）**：
- 逐一比对 `app/game/modules/building/handler.ts`——**唯一缺失端点** `building/takeClueFromBoard`（CS BuildingMeetingClueTakeClueFromBoardRequest{type}，客户端 UnequipClue 按阵营取下留言板线索）已补
- 家具商店端点 `shop/getFurniGoodList`/`shop/buyFurniGood`（CS BuildingGetFurnitureGoodListRequest/BuildingBuyFurnitureGoodRequest{goodId,buyCount,costType}）确认已存在于 shop 路由（非 building 命名空间）
- 其余 60 端点全部命中现有路由（含别名/兼容字段）

**线索板（MEETING board）格式校准（真实存档 2222 校准，此前实现两处错误）**：
1. **board 键为阵营 type、值为线索 id**：真实存档 `{"RHINE":"100566259#3490#...","PENGUIN":"086186062#3369#..."}`——原实现写成 `{[clueId]: clueId}`，客户端按阵营槽位读板 → 上板线索不可见
2. **线索保留在库存中，以 inUse=1 标记上板**：真实存档中板线索（6 条）全部仍在 ownStock/receiveStock（inUse 0/1 并存）——原实现 splice 移除 → 取下时线索数据丢失
- 修复：`putClueToTheBoard`/`putClueToTheBoardAuto` 改写 `board[clue.type]=clue.id` + `clue.inUse=1`（不移除）；新增 `takeClueFromBoard({type})` 删除 board 条目并复位 inUse
- 红点语义：`_refreshClueFlag`——存在未上板（inUse=0）线索 → hasClues=1；全部上板 → 0（原"两库存皆空才清"在保留模型下会红点常亮）
- 删除线索时 `_clearBoardEntry` 清理指向该线索的板条目（不留孤儿索引）

### 11.7 基建经济系统补全（2026-08-14）

**电力系统（发电站供给/消耗，官方行为）**：
- 数据：房间相位 `electricity`——POWER 正向（+60/+130/+270 发电），其余负向消耗（MANUFACTURE/TRADING/HIRE/MEETING/TRAINING -10/-30/-60、DORMITORY -10/-20/-30/-45/-65、WORKSHOP -10、CONTROL/PRIVATE/ELEVATOR/CORRIDOR 0）
- `_powerBalance(draft)`：全部 roomSlots 按当前等级求和；模板存档（满配布局）余额恰为 **0**
- `buildRoom`/`upgradeRoom`：目标房间耗电增量后余额 < 0 即拒绝（需先升级发电站）——客户端显示"电力不足"，服务端防越权
- 发电量仅随房间等级（相位），进驻干员 `power_*` buff 影响无人机充能速度（未建模，YAGNI）

**加工站干员心情（体力）消耗**：
- 单位确认：`manpowerDisplayFactor = 360000`——1 心情点 = 360000 raw AP = 1 小时 -100 档消耗；公式 `apCost`（模板公式 1 = 360000 = 1 点/次）即每次合成的心情成本
- `workshopSynthesis`：从进驻加工站（WORKSHOP 槽位）干员的 `building.chars[].ap` 扣减 `apCost × 次数`，心情不足时按可承担次数合成；未进驻干员不扣（私服友好）
- 依据：客户端 `BuildingCharModel.RoundCharApToInt` 按 manpowerDisplayFactor 换算、`BuildingWorkshopModel.moodCost` 直读 `workshopFormula.apCost`

**工坊 bonus（ws_bonus，进驻干员技能）**：
- 语义确认（技能描述「进驻加工站时，累积 N 点因果/业报必定产出一次副产品」）：`status.workshop.bonus[bonusId]=[curPoint,totalPoint]`（模板 ws_bonus1_40=[16,40] = 16/40 进度），满格后 `bonusActive=1`，下一次合成必定产出副产物并重置计数
- 干员-技能映射：`BuildingData.workshopBonus[charId]`（如 char_4019_ncdeer → [ws_bonus1_40, ws_bonus2_80]）；buff `workshop_formula_bonus{N}[000]` 的 targets 过滤配方类型（F_BUILDING/F_EVOLVE/F_SKILL/F_ASC）
- `workshopSynthesis` 逐次合成推进计数：未蓄力 cur+1，满格置 bonusActive=1；已蓄力本次必定触发加权副产物（extraOutcomeGroup）并重置该 bonus
- 阈值兜底：存档条目缺失时按 id 解析（`ws_bonus1_40` → 40）

**加速不消耗道具（2026-08-14 修复代码-文档矛盾）**：
- `accelerateSolution` 原实现把请求体 `cost`（客户端本地消耗的**加速无人机**数量，CS BuildingManufactLaborAccelRequest{cost}）误当源石碎片从 `status.diamondShard` 扣费 → 玩家源石碎片被无故消耗，且与 `accelerateOrder`（免费）及文档「加速不消耗道具（私服友好）」矛盾；现移除扣费，加速免费
- 存档格式无服务端无人机计数字段（PlayerBuildingStatus={labor,workshop}、PlayerBuildingPower={buff,presetQueue}，反编译确认）——无人机为客户端本地时间显示（LaborAccelStateBean：remainPoint+lastUpdateTime+speed），服务端不建模

**发电站 buff.laborSpeed（未建模）**：
- 模板 POWER 房间带官方 laborSpeed 值（0.15/0.2/0.25，对应进驻干员 power_rec_spd 系列 buff）；客户端消费逻辑位于不可反编译的 hotfix/Lua 层，3 个数据点无法可靠推导公式 → 不回写（避免破坏客户端无人机充能显示），模板现值原样保留

**简化（YAGNI，未建模）**：发电站进驻干员对无人机充能速度的影响、多个 bonus 同时蓄力时的归属判定（单 bonusActive 标志，重置首个满格 bonus）

### 11.8 会客室信用（社交点）经济循环（2026-08-14）

**背景**：`socialReward.daily/search` 只在模板初值（search=40）领一次后永不累积——信用经济枯竭，getMeetingroomReward 领取一次即空。

**模型（封顶循环，无需日跟踪）**：
- 单次信用量 = 会客室相位 `friendSlotInc`（lv1/2/3 = 10/20/35，保底 `creditGuaranteed`=10）
- **被动信用 daily**：好友访问 → `daily += friendSlotInc`，封顶 `creditPassiveLimit`=100
  - `dailyRefresh` 模拟好友访问（按好友数累积，私服单账号无真实访问源）
  - `visitBuilding` 被访方：原 +20 socialPoint（绕过信用循环）→ 改为 `daily += friendSlotInc`
- **主动信用 search**：情报分享 `getInfoShareReward` 按本次有效访客数 → `search += 访客数 × friendSlotInc`，封顶 `creditInitiativeLimit`=100（原实现只推进会客室会话从不计信用）
- `getMeetingroomReward` 领取 daily+search → status.socialPoint，清零后重新累积（循环成立）

**依据**：credit 常量（creditGuaranteed/creditPassiveLimit/creditInitiativeLimit/creditCeiling）+ meetingData.phases[].friendSlotInc 均来自 building_data.json；`creditFormula` 字典为空（客户端计算在不可反编译层），采用上述封顶模型并在存档格式内自洽。

**简化（YAGNI）**：单账号私服无真实好友访问（模拟源为好友数）；creditComfortFactor=0 不产生舒适度附加信用。

### 11.9 统一 deltaTime 推进 + 贸易站订单时间模型（2026-08-19）

**统一 deltaTime 推进入口（_advanceBuilding）**：
- 原 `sync()` 各子系统内部各自取 `now()` 计算流逝——时间基准不统一（同一轮推进内不同毫秒），且无法注入时间做精确测试
- 新增 `_advanceBuilding(draft, ts, tsFloat)`：所有时间敏感推进以 `elapsed = ts - lastUpdateTime` 为唯一语义，时间基准由调用方注入（sync 传 `now()`；测试传任意 ts 即可验证 deltaTime，无需 mock 时钟）
- 推进顺序（与官方 sync 语义一致）：劳动力恢复 → 心情档位重算 → 干员心情累积（浮点秒，保证 chars 增量恒在）→ 制造站生产 → 贸易站订单推进 → 贸易站静态补单兜底 → 训练室进度 → 会客室 infoShare 指示
- `sync()` 仅负责取时间基准 + 调 `_advanceBuilding` + completeWorkTime/event.building 刷新

**贸易站订单时间模型（_accrueTrading，官方 PlayerBuildingTradingNext）**：
- 官方模型：`next = {order, processPoint, speed, maxPoint}`——processPoint 随时间按有效速度累积，达到 maxPoint 逐笔生成订单（instId 从 order 递增）并回退阈值
- 有效速度 = 存档 `next.speed`（基础订单效率）× (1 + 进驻干员 `trade_*` buff + 控制中枢 `control_tra_*` 全局)，回写 `next.speed` 供客户端倒计时一致
- 回写官方线格式 `room.buff = {speed: 加成系数, limit: stockLimit}`（PlayerBuildingTradingBuff，客户端倒计时显示）
- **激活条件**：时间模型仅在存档已有订单进度（`next.maxPoint > 0`，官方迁移存档）时激活；旧存档无 next 数据 → 不惰性初始化（避免污染存档语义），交 `_refreshTradingOrders` 静态补单兜底（补满 stockLimit）
- 静态补单跳过 `next.maxPoint > 0` 的房间——避免"时间逐笔生成 + 静态补满"叠加破坏订单节奏
- `_genTradingOrder` 抽公共订单生成（静态补单/时间生成共用，结构对齐官服 O_GOLD：delivery 3003 → gain GOLD）

**技能描述解析器增强（buff.ts）**：
- `parseDescTags(desc)`：通用提取 `<@cc.vup>/<@cc.vdown>/<@cc.vdo>` 全部数值标签（tag/value/hasPct/signed）
- `parsePlainPercent(desc)`：纯文本百分数兜底（无富文本标签的描述，如"生产力+15%"→15）
- `buffValueForTarget` 兜底链路：efficiency → vup 标签 → vdown/vdo 带 % 标签 → 纯文本百分比 → 0（计数/阈值类不贡献，避免生产速度虚高）
- `parseMoodCostValue` 正则扩展支持 `<@cc.vdo>` 标签（心情消耗语境）

**测试**：`tests/unit/manager/building-deltatime.test.ts`（14 条）——deltaTime 注入推进（劳动力/制造/心情/训练）、贸易站时间模型（逐笔生成/效率加成/静态补单隔离/库存上限）、解析器新函数。全量基建 160 测试通过，tsc 干净。

### 11.10 特殊技能适配（2026-08-19）

**背景**：官方基建 buff 中 141 个技能描述含条件标签 `<$cc.tag.X>` / `<$cc.g.X>` / `<$cc.m.X>` / `<$cc.tra.X>`——加成语义为条件/数量依赖，旧实现 `buffValue` 会把其中 vup% 当无条件固定加成 → 生产/贸易速度虚高（薇薇安娜"每个骑士+7%"被当作无条件+7%）。

**数据源（100% 官方在库）**：
- `gamedata_const.termDescriptionDict`：`cc.tag.*`/`cc.g.*`/`cc.m.*`/`cc.tra.*` 术语 → 干员名单（中文名/特殊名，196 名 100% 可映射到 character_table）
- `character_table.name`：干员名 → charId 索引（惰性缓存）

**特殊技能类型（special.ts，新模块）**：
- **fraction（"每个"）**：每个符合条件标签的干员提供 +Y%（如薇薇安娜「每个进驻在制造站的骑士+7%」→ 加成 = 7% × 制造站骑士数；涤火杰西卡「每个黑钢国际+5%」）
- **token（条件触发）**：条件满足才 +Y%（如布丁「≥2台作业平台进驻发电站时+2%」；麒麟R夜刀「与怪物猎人小队干员同驻控制中枢时+2%」）
- 判定用 `roomTargetFromDesc` 精确解析"进驻在X"（X=制造站/贸易站/宿舍/发电站/控制中枢，剥 `<@cc.kw>` 标签）——避免"进驻控制中枢时…每个进驻在制造站的…"误取控制中枢干员池

**集成（buff.ts → special.ts 单向依赖，避免循环依赖）**：
- `roomSpeedBonus(chars, roomType, targets, ctx?)` / `controlGlobalBonus(controlChars, ctx?)` 新增 `SpecialSkillContext`（各房间干员 charId）；含条件标签的 buff 走 `specialBuffValue` 条件/数量计算
- `CONTROL_TARGET_PREFIX` 扩展映射 `control_token_prod_`/`control_token_tra_`/`control_bd_spd` → MANUFACTURE/TRADING
- BuildingManager `_specialCtx(draft)` 从 roomSlots 构造全房间干员上下文

**会客室线索概率（meet_spd_notOwned/Owned）**：
- `getDailyClue` 阵营抽取加权：晓歌（未拥有线索概率↑）→ 未上板阵营权重 ×2；U-Official（已拥有↑）→ 已上板阵营权重 ×2
- 私服无真实访客线索交换，getDailyClue 是唯一线索来源——技能实际生效

**贸易站独占订单（trade_ord_pepe/closure）**：
- `_genTradingOrder` 检测进驻干员技能：佩佩 → 特别独占订单（赤金交付 0、收益恒定 rate×2）；可露希尔 → 可露希尔特别订单（赤金交付 2、收益恒定 rate×3）；订单带 `special` 标记

**心情特殊（control_mp_cost_double/reset）**：
- `_recomputeCharScales` 控制中枢分支：魔王与阿米娅（char_002_amiya）同驻 → 自身心情恢复档位（vup ×100）；若叶睦与丰川祥子（char_4182_oblvns）同驻 → 消除自身心情消耗

**坑**：① special.ts 不得 import buff.ts（循环依赖致 vite 下函数绑定失效——实际症状为 fraction 返回 0）；② 注释中 `cc.tag.*/` 的 `*/` 序列提前终止 JSDoc；③ "N台以上"数量词被 `<@cc.kw>N</>` 包裹，需剥标签再正则匹配。

**测试**：`tests/unit/manager/building-special.test.ts`（16 条）——special.ts 纯函数（fraction/token/术语映射）、buff.ts 集成（roomSpeedBonus/controlGlobalBonus）、BuildingManager 集成（制造站容量含 control_prod_fraction、token 条件切换、贸易站独占订单、会客室线索加权、心情特殊）。基建 5 文件 169 测试通过，tsc 干净。

### 11.11 基建时间戳更新修复（2222 存档审计，2026-08-19）

**背景**：观察存档 2222（8-18 备份）基建发现"存在时间未更新"——CONTROL/MEETING/HIRE/TRADING `lastUpdateTime` 停在 8-13（6 天前）、TRAINING 空弦 `processPoint` 停摆、MEETING/HIRE 线索/人脉搜集进度停滞。

**根因（反编译官方枚举确认）**：
1. **训练室 state 语义错误**：官方 `PlayerBuildingTraineeState` = EMPTY(0)/TRAINING(1)/OUTOFDATE(2)/WAITING(3)——训练中为 **state=1**；旧实现 `state !== 3` 把 WAITING(3) 当训练态 → 真实存档（state=1）训练进度从不推进
2. **MEETING/HIRE 无时间推进**：`PlayerBuildingMeeting`/`PlayerBuildingHire` 的 `processPoint`（线索/人脉搜集进度）没有任何 accrue 逻辑——进度停滞 + lastUpdateTime 停留旧值
3. **CONTROL 无推进**：控制中枢无生产逻辑但官方有 `lastUpdateTime`（无 state 字段，恒运行）

**修复（building.ts）**：
- `_accrueTraining`：条件改为 `trainee.state === 1`（TRAINING），完成（state=2 OUTOFDATE）仍由 completeUpgradeSpecialization 驱动
- 新增 `_accrueMeeting`/`_accrueHire`：`processPoint += elapsed × 有效速度`，有效速度 = 相位 `gatheringSpeed`/`resSpeed` × (1 + 干员 `meet_*`/`hire_*` buff)，回写 `room.speed` 供客户端进度一致；私服简化——进度真实累积供显示，线索/招募位产出仍由边界/每日刷新驱动
- 新增 `_touchActiveRooms`：统一推进所有工作时间房间（state=1）及常驻房间（CONTROL 无 state）的 `lastUpdateTime ← ts`——sync 后基建时间戳恒为当前
- `_accrueTrading` 订单生成改 **while 循环**：长时间离线累积多笔时一次性结算全部达到阈值的订单（原 if 只生成 1 笔，进度滞留）
- `building_excel.ts` 新增 `getHirePhase`（人力相位：resSpeed/refreshTimes）

**测试**：`tests/unit/manager/building-archive-time.test.ts`（6 条，基于 2222 真实结构快照）——统一时间戳（6 房间 lastUpdateTime 推进）、训练 state=1 推进、会客室/人力进度推进 + speed 按 buff 重算、制造站产出累积 + 二次 sync 不重复、贸易站 while 批量结算；building-deltatime 补训练 state=3 不推进断言。基建 7 文件 186 测试通过，tsc 干净。

### 11.12 客户端交互三问题修复（2026-08-19）

**1. deliveryBatchOrder 交付无效果**：服务端逻辑验证正常（结算扣 delivery/加 gain/清 stock），但客户端改造版可能发非 `slotList` 字段 → 空循环 → 200 但未交付。修复：兼容 `slotList`/`slotIdList`/`roomSlotIdList`/单值 `slotId`/`roomSlotId`。

**2. batchChangeWorkChar 队列轮换**：官方 `BuildingBatchChangeWorkCharRequest` **无字段**——客户端"换班"按钮只带 `roomSlotId`（无干员列表）期望服务端**轮换预设队列**（应用下一组 `room.presetQueue`），原实现无干员列表时直接不改分配。修复：`_nextPresetQueue`——当前排班在队列中 → 应用下一组（循环）；不在队列 → 应用第一组；无队列 → 不改。显式 `charInstIdList` 路径保持。

**3. autoConfirmMissions 重复发放/任务状态**：
- **重复发放修复**：旧存档（8-12 模板迁移）已领任务 `state=3` 但无 `confirmed` 字段——confirmMission 只判 confirmed 会**重复发放奖励 + dailyPoint 无限累积**（每次一键领取 +5）；修复：`data.state === 3`（官方"已完成已领取"语义）一并视为已领
- 存档审计结论：当前 1.json 满进度任务均已 `state=3`（无可领任务），autoConfirmMissions 返回空 items 是**正确行为**；若客户端显示"进行中"，对应的是进度未满任务（如 daily_5828 7/10）——真实未完成，事件驱动进度追踪正常（日志 daily_70xx complete）

**测试**：`tests/unit/manager/building-client-fixes.test.ts`（12 条）——deliveryBatchOrder 五种字段变体、batchChangeWorkChar 轮换四场景（首组/循环/空体不改/显式列表）、confirmMission 已领不重复发 + 未领正常发放。基建+任务 9 文件 224 测试通过，tsc 干净。

### 11.13 基建全量对齐官服（2026-08-26，prts.wiki × excel 差距补齐）

以 prts.wiki 机制文档 + excel 数据为准的差距补齐（设计文档：
`docs/superpowers/specs/2026-08-25-building-full-parity-design.md`）。新增 6 个纯函数引擎模块（沿用 buff.ts/special.ts 分层，manager 薄接线）：

**① mood.ts 通用基座**：
- 注意力涣散（ap ≤ 0）技能失效：`getActiveCharBuffs` 默认拒绝涣散干员的 buff（宿舍休息语境 `allowDispersed` 豁免）；加工站无干员/涣散时副产物概率锁定 0%（官方）
- 头数心情减免：制造/贸易 2人 -0.05、3人 -0.1 点/时（_recomputeCharScales）
- 暖机工时：`building.chars[].warmupSec/warmupTs/warmupSlot`（服务端扩展）——在岗累积、离岗/换工位清零（`_accrueWarmup`）
- 修复：sync 浮点秒基准与 ts 同源（`ts + Date.now()%1000/1000`）——避免测试注入时间与真实时钟混用把心情超发扣成涣散

**② unlocks.ts + mastery.ts（配方解锁 + 专精）**：
- 配方解锁校验：`requireRooms`（曾达等级 + 房间数）/`requireStages`（关卡星，rank 语义）——制造/加工配方不再无门槛；曾达等级存 `building.maxLevelReached`（服务端扩展，建造/升级取 max、降级不回退）
- 开采协力（O_DIAMOND）策略需贸易站 ≥ `tradingStrategyUnlockLevel`(3)
- 专精门控：精英2 + 技能 7 级 + 专精≤3 且≤训练室等级 + 训练槽占用互斥；消耗 `levelUpCostCond[].levelUpCost` 材料（足额校验）；训练时长阈值 `trainee.maxPoint = lvlUpTime`（8/16/24h），`_accrueTraining` 达阈置待领取（state=2），`completeUpgradeSpecialization` 门控（旧存档无 maxPoint 保持原行为）
- 协助位非涣散基础 +5%（官方）叠加教官 train_* 技能；训练锁：训练中干员拒绝 assignChar 派往其他房间；开发者开关 `specializationTimeZero` 保持即时完成兼容
- 尤里卡特殊订单：数据表无对应 buff，不建模（已知限制）

**③ trade-orders.ts（贸易订单模型）**：
- 站级概率表（替代均匀随机 1~4）：Lv1 {2金:100%}；Lv2 {2:60%,3:40%}；Lv3 {2:30%,3:50%,4:20%}
- 暖机概率改写（`trade_ord_wt&cost` α[00x] 3h / β[01x] 5h）：α {4:55,3:30,2:15}；β {4:85,3:10,2:5}；双α {4:65,3:22,2:13}（玩家实测，中置信）；α+β 按 β；离岗清零由暖机基座保证
- 特殊订单补全：违约订单（trade_ord_law 交付<4 视为违约 + trade_ord_against 交付 +1/+2）、龙舌兰投资（trade_ord_long 交付>3 收益 +250/+500）；佩佩/可露希尔既有保留；订单上限沿用存档 stockLimit（官方线格式）
- 开采协力订单生成：源石碎片(3141)×2 → 合成玉(4003)×20（strategy=O_DIAMOND）

**④ 加速无人机语义**：审计确认客户端协议无持有点/急速充能端点、官服存档无无人机字段 → 官方行为为客户端本地推算，服务端不建模持有量（维持 11.7 结论）；`accelerateSolution` 带 `cost` 时按官方“1 架 = 3 分钟”推进等价进度（有效产能换算），`cost` 缺省保持旧行为（立即完成 1 方案）兼容旧客户端

**⑤ hire-contacts.ts + clue-speed.ts（人力 + 会客）**：
- 办公室联络：每 12h × 速度系数（进驻基础 +5% + hire_* 技能）得 1 次人脉库存（`room.refreshStock`，上限相位 refreshTimes=3，满则停工、无人进驻不恢复）；`gacha/refreshTags` 消耗人脉库存（库存 0 拒绝；无人力办公室/未进驻免消耗兑底，防公开招募锁死）
- 会客室线索速度全公式：相位 107/109/111% + 全宿舍氛围档（≥2000/3000/4000 → +5/10/15%）+ Σ干员（稀有度 4★2/5★4/6★5% + 精1 8%/精2 16% + 非涣散 5%）+ meet_* 技能（加算）
- 进度真实产线索：20h 基准阈值达即生成（阵营加权含晓歌/U-Official），长离线多份；自有库上限 10 满则停工（官方）

**⑥ dorm-special.ts + 中枢杂项**：
- 宿舍恢复公式对齐：(1.5+0.1×等级) + 氛围×0.0004（替换 /160 与 /1000×0.55 拆分，总和不变、低氛围场景拆分更准）
- 宿舍技能按作用域分发（修复：原实现把全部宿舍技能当全体恢复 → 自身/单体恢复错发全员）：all 全员（同种取最高）/ self 仅自身（dorm_rec_oneself*）/ single 心情最低成员（除施放者，dorm_rec_single*，含 &oneself 双数值拆分）/ shared 均分（小酌怡情 dorm_rec_all&single 0.8 总量均分给未满成员）
- buyLabor 双路径：中枢 ≥ `apToLaborUnlockLevel`(4) 时理智兑换（1 AP → `apToLaborRatio`(2) 劳动力），未达级保留源石兼容路径（文档记录）
- 未建模（已知限制，待后续立项）：副手信赖 4:00/16:00 定时结算（wiki 未给氛围折算公式，低置信，需真实存档校准）；患难之交（dorm_exchangeAp，需进驻顺序追踪）；自律/嗜睡/慵懒（当前数据表无匹配 buff）

**测试**：新增 5 个测试文件（building-mood / building-unlocks / building-trade-orders / building-contacts / building-dorm，共 80 条）；存量基建设定随行为对齐更新（头数减免、协助位 +5%、概率表、专精门控、宿舍公式）。基建 12 文件 298 测试通过，tsc 干净；全仓 2534/2536（2 失败为 rlv2 在途改动预存问题，与基建无关）。



### 11.14 dc-fix 真机四问题修复（2026-08-26）

用户真机报告 4 项，按 dc-fix 流程（Find 取证 → Verify → Fix 最小改动）修复：

1. **workshopSynthesis 400（roomSlotId 校验失败）**：CS `BuildingWorkshopSynthesisRequest` 仅 `formulaId + times`（反编译 2.7.61 取证），无 roomSlotId 字段——schema 改可选，manager 按 formulaId 合成（无需房间定位）。
2. **deliveryOrder 400（orderId 类型不匹）**：CS `BuildingTradingDeliveryRequest.orderId` 为 Int64（客户端发数字）——schema 改 `string|number` 兼容（manager 已按 String(instId) 匹配）。
3. **制造站无法补货（补不到 99）**：旧存档无 `maxLevelReached` 记录 → 11.13 引入的解锁门控把全部配方判为未解锁。修复：`_unlockCtx` 曾达等级 = max(记录值, 当前房间等级)——当前等级本身即“曾达”（lv3 制造站必然曾达 3 级）。
4. **制造/贸易生产速度过快**（两处单位错误，2222 真存档定量取证）：
   - 制造站：原按 `容量(54)×(1+加成)` 点/秒累积 → 快约 54 倍；官方速率 = **1×(1+加成) 点/秒**，阈值 costPoint = 配方基础秒数（赤金 4320=72 分钟）。存档实测验证：剩余进度 1481.3 ÷ 剩余 833s = 1.778 = 1 + buff.speed(0.78) ✓；容量 24/36/54 仅为仓库容量显示语义。
   - 贸易站：原 `next.speed = next.speed × (1+bonus)` 回写 → 加成每次 sync 复利滚雪球（订单越来越快）；存档 `next.speed` 已是有效值（1.78 = 1+0.78，maxPoint = 官方基础秒数，如 12600 = 3:30:00）。修复：速度 = **1 + 当前加成**（每次按进驻干员重算，换班即时生效，不复利）。
   - 无人机加速同步改单位：1 架 = 3 分钟 = 180×(1+加成) 进度点。
5. **测试**：新增 `building-dcfix.test.ts`（6 条：schema 形态/数字 orderId 命中/无记录补货 99/制造速率 4320 秒一批/贸易不复利）；存量速率断言随官方语义更新（6 处）。基建 13 文件 304 测试通过，tsc 干净；全仓失败仅剩 rlv2 在途预存项（与本次无关）。
6. **协议语义沉淀**（项目级约束）：基建请求体字段以反编译 CS 类为准（不凭服务端直觉加必填字段）；生产/订单进度单位以真存档实测速率反推（点/秒 = 1×加成，阈值 = 基础秒数）；回写到存档的速度字段不得被当乘数再相乘（复利陷阱）。

---

## 12. 战斗结算后处理逻辑

### 12.1 覆盖范围
BattleManager（app/game/manager/battle.ts）的战斗结束（finish）后处理：
- 结算清单：rewards / unusualRewards / additionalRewards / furnitureRewards / firstRewards / unlockStages 真实返回（此前为全空数组）
- 通关次数：胜利（completeState 2/3，非练习）时 `dungeon.stages[stageId].completeTimes + 1`
- 干员信赖：胜利时参战 squad 干员 `troop.chars[instId].favorPoint + 1`（battleInfo 新增 squad 字段，start 时保存）
- battleId：唯一化（时间戳 + 随机数），替代固定 "1"，避免多场战斗互相覆盖 battleInfo/replay
- 结算回传：`battle:finish` 事件新增可选回调，TroopManager.addonStageBattleFinish 收集结果，`/charBuild/addonStage/battleFinish` 路由合并 `{...result, ...delta}` 返回

### 12.2 修复的隐藏 bug
- **`in [` 操作符误用**（4 处）：`completeState in [2, 3]` 实际检查数组索引而非包含关系（`3 in [2,3]` 恒 false），导致关卡解锁、主线进度更新、dropType=8 首通奖励等逻辑从未生效 → 改为 `[..].includes(x)`
- **dropReward 无限递归**：零产出时用未收敛的 `displayDetailRewards` 重试（概率未中的条目永不移除）→ 真实掉落表下栈溢出崩溃 → 增加 depth 上限（10 轮）防死循环

### 12.4 掉落信息自动提取（excel 驱动）
- **归一化**：`app/game/excel/stage_table.ts` 的 `normalizeStageDropInfo` 在 excel 加载时（excel.init）将 `displayDetailRewards` 的 `occPercent`/`dropType` 字符串映射为数字档位（`ALWAYS→0, USUAL→1, OFTEN→2, SOMETIMES→3, ALMOST→4`；`ONCE→1, NORMAL→2, SPECIAL→3, ADDITIONAL→4, COMPLETE/CONDITION_DROP→8`），幂等（数字值保持不变）
- **修复前**：原始 excel 为字符串格式，而 dropReward 按数字比较 → **所有关卡掉落从未生效**（仅 finish 硬编码 GOLD/EXP 结算）
- **补产出**：对照 Python 参考 quest.py，`occPercent=0/dropType=2`（ALWAYS+NORMAL 必掉基础掉落）分支补 `pushReward()`——此前只 console.log 不产出，必掉材料（如 1-7 的 30012）从未掉落
- **保留的硬编码表**：SpecialGold / TacticalDrill / ToughSiege 等特殊关卡固定掉落（游戏设计值，excel 不含数量字段，无法自动提取）
- 已验证：main_01-07 归一化后 11 条掉落全部数字化，dropReward 正确产出必掉材料 30012 与概率掉落 30041/30061/3003 等

### 12.3 已知约束
- `/campaignV2/*` 等后半段路由（app/game/app.ts 61 行后）在真实服务器上未生效（404），为项目既有问题，与战斗结算无关；建议后续单独排查
- `/charBuild/addonStage/battleStart` 路由不返回 battleId，且固定练习模式（usePracticeTicket=1），HTTP 链路无法闭环非练习战斗——进程级 E2E 与单测覆盖结算逻辑
- 失败（completeState=1）不结算信赖/通关次数，rewards 为空

---

## 13. 勋章系统实现

### 13.1 架构
- **MedalManager**（app/game/manager/medal.ts）：勋章集合管理（init / setCustomData / rewardMedal / onMedalComplete / toJSON），构造时监听 `medal:complete` 事件
- **MedalProgress**：单个勋章进度追踪，**164 个 excel 模板全部实现**（PlayerLevel / PassStageSome / RecruitCount / GotChars / Rlv2* / Sbv3* / Act* 等），按模板注册事件监听推进进度

### 13.2 核心机制
- **挂载**：MedalManager 挂载到 PlayerDataManager（`player.medal`），构造时 `init()` 遍历玩家勋章创建进度实例
- **进度追踪**：构造条件放宽为「fts 未设 **或** 进度未满」→ 既有存档（1190 勋章中 228 个未满）也能继续追踪；模板事件（CompleteStage / char:get 等）触发时更新进度，达标后 `off` 监听并 emit `medal:complete`
- **领奖**：`/medal/rewardMedal` 路由调用 `player.medal.rewardMedal`，发放奖励组物品（items:get）并记录 rts
- **防重复**：rts != -1 视为已领取，重复请求返回空
- **持久化**：进度 val 与 `_playerdata.medal.medals` 共享引用（模板 update 直接写回）；rts 领取后显式同步写回持久态

### 13.3 容错（旧数据兼容）
- 勋章 `val` 缺失（旧存档）→ 构造兜底为 `[[]]`，不崩溃
- 勋章 ID 不在 excel MedalTable（活动下架残留）→ 跳过进度注册
- excel 未初始化时构造（PlayerDataManager 早于 excel 加载）→ 跳过进度注册

### 13.4 简化项（YAGNI）
- 164 个模板全部实现但仅核心模板有单测（PlayerLevel / JoinGameDays / CharNum / RecruitCount / GotChars / CharEvolveCount / PassTower）；活动类模板（Act*/Crisis*）依赖活动数据，按需验证
- 勋章展示（setCustomData / 名片展示）沿用既有实现，未扩展

---

## 14. 任务系统实现

### 14.1 架构
- **MissionManager**（app/game/manager/mission.ts）：任务集合管理（init / getMissionById / dailyRefresh / weeklyRefresh / confirmMission / confirmMissionGroup / autoConfirmMissions / exchangeMissionRewards），构造时监听 `refresh:daily` / `refresh:weekly` 事件
- **MissionTemplates**：按事件组织的任务模板映射（**46 个 excel 模板全覆盖**、无空实现），模板按 param[0] 细分（如 StageWithEnemyKill 的 0/1/2/3/5/6 分支）
- **MissionProgress**：单个任务进度追踪，按模板注册事件监听，达标后 off + state=3 + unlockNextMission

### 14.2 核心机制
- **挂载**：MissionManager 挂载到 PlayerDataManager（`player.mission`），构造时 `init()` 填充内存任务列表（DAILY 29 / WEEKLY 32 / GUIDE 72 / MAIN 82 / SUB 262 / OPENSERVER 4，共 481 个）
- **进度追踪**：MissionProgress.init 查 excel mission → 注册模板事件监听；事件触发时 update 推进，达标后写回 state=3 并解锁后续任务
- **刷新**：dailyRefresh 重置 dailyPoint + 按星期加载当日任务组；weeklyRefresh 重置 weeklyPoint + 加载全部 WEEKLY 任务
- **确认**：confirmMission 累计任务点数并自动兑换达标奖励组；autoConfirmMissions 批量确认
- **修复**：`/mission/confirmMission` 路由补 await（原返回 Promise 对象）

### 14.3 深层修复（任务系统从未生效的根因）
- **MissionManager.init 未挂载**：PlayerDataManager 构造未调用 → 481 个任务进度监听从未注册
- **init 未填充内存任务列表**：`this.missions` 为空 → getMissionById/confirmMission 依赖崩溃
- **Immer draft 内 push 崩溃**：init 在 `player.update` 回调内创建 MissionProgress（模板 push 到冻结 draft）→ 重构为「先补 ACTIVITY 分组，再在 draft 外创建进度实例」
- **Immer autoFreeze 冻结玩家数据**：finishDraft 默认冻结 `_playerdata`，管理器（MedalProgress/MissionProgress）直接修改数组（push）崩溃 → **全局禁用 autoFreeze**（PlayerDataManager 模块加载时 `setAutoFreeze(false)`），私服直接修改模式适用

### 14.4 简化项（YAGNI）
- 46 个模板仅核心模板有单测（CompleteStageAnyType / StageWithEnemyKill / UpgradeChar / CompleteAnyStage）；活动类模板依赖活动数据按需验证
- 任务状态 0/1 转换（未解锁→未接取）沿用既有实现，未扩展

---

## 15. 官服数据迁移

### 15.1 用途
用官服账号（手机号+密码）自动登录官服、拉取玩家数据、转换为私服存档并注册账号，实现「一键迁移官服数据到私服」。

### 15.2 使用方式
```bash
pnpm run migrate:official -- --accounts <账号文件路径> --template 1
```
- `--accounts`：账号文件（每行「手机号 密码」或两行一组「手机号\n密码」，忽略备注），默认 `reference/checkin-master/accounts.txt`
- `--template`：私服模板存档 uid（兜底字段来源），默认 1

### 15.3 登录协议（scripts/official-api.ts）
1. `getResVersion`：`ak-conf.hypergryph.com/config/prod/official/Android/version`
2. `getToken` 三步：`as.hypergryph.com/user/auth/v1/token_by_phone_password` → `oauth2/v2/grant`（appCode=7318def77669979d）→ `u8/user/v1/getToken`（u8_sign HMAC-SHA1）
3. `loginGame`：`ak-gs-gf.hypergryph.com/account/login`（拿 secret）
4. `syncPlayerData`：`/account/syncData`（返回完整玩家数据 user 字段）
全部使用 Node 24 内置 fetch + node:crypto，**零第三方依赖**。

### 15.4 转换与注册
- **convertOfficialData**（scripts/official-convert.ts）：官服 user 与私服存档同源——官方字段直接沿用、uid 替换为私服新 uid、移除连接态（secret/seqnum）、**模板全字段兜底**（官方缺失**或为空对象**的字段从模板存档复制，保证私服可加载——官服 syncData 中 shop/tshop/inventory/crisis 等可能为空对象，而私服路由直接访问 `shop.LS.info` 等深层结构，空对象会导致 500）
- **registerImportedUser**（scripts/official-register.ts）：新 uid 从现有账号递增；写入 `data/user/databases/{uid}.json` + SQLite `users` 表注册（auth.phone=官服手机号、auth.hgId=官服 uid、password 随机）

### 15.5 已知限制
- 真实官服调用未在测试中验证（全部 mock fetch）：官服接口可能变更、存在风控/验证码——脚本输出清晰错误，单个账号失败不中断其他
- 不迁移战斗回放/battleLog（仅全量拉取玩家数据）
- 迁移后的账号需重启服务器（或 `accountManager.init()` 重载）才能生效

---

## 16. 集成战略 rlv2 接口补全

### 16.1 背景
对照参考项目 Dorothinights（Python）的 rogue_3 接口集审计，现有 `app/game/modules/rlv2/logic.ts`（主管理器）已实现 28 个方法（createGame/buyGoods/moveTo/battleFinish/gameSettle 等），本次补全 5 个缺失接口。

### 16.2 本次补全接口
| 接口 | 行为 | 参考 |
|------|------|------|
| `refreshShop` | 重生成当前 SHOP 商品 + refreshCnt-1 | Dorothinights refreshShop.py |
| `leaveShop` | 清空 pending → WAIT_MOVE | finishNodeAndEndCheck.py |
| `confirmPredict` | 清空 pending → WAIT_MOVE（rogue_3 预兆确认） | confirmPredict.py |
| `useTotem` | 接线 `modules/totem.ts` 的 `use()`（上下板效果已实现） | useTotem.py |
| `closeRecruitTicket` | 招募票 state=3（关闭）+ 清空候选列表 | closeRecruitTicket.py |

路由：`app/game/modules/roguelike/handler.ts` 新增 5 个 POST（refreshShop/leaveShop/useTotem/confirmPredict/closeRecruitTicket）。

### 16.3 隐藏问题
- **`_status.pending` 是只读 getter**（经 `_pending._pending` 内部数组操作）——实现/测试都需注意
- **图腾管理器访问**：`_module.totem` getter（`_modules["TOTEM"]`）——返回 any 避免与 `Module.totem` 结构类型冲突
- **外援 buff 配置缺失**（buff.ts）：`RoguelikeConsts[theme].outbuff[id]` 在真实数据下可能 undefined → 可选链容错
- **createGame 真实数据链路**（既有问题）：`modebuff`/`outbuff` 等 excel 配置在真实存档下仍可能缺失——本次仅修复 outbuff，createGame 完整链路留后续

### 16.4 简化项（YAGNI）
- useTotem 的混沌值扣减未实现（fragment/chaos 模块结构复杂）——仅接线图腾 use
- leaveShop/confirmPredict 的 zoneEndChecker（关卡结束检查）未实现——复用现有 pending 清理模式

### 16.5 数据补全（2026-08，数据源与消费链路）

| 数据文件 | 覆盖 | 数据源 | 消费点 |
|---|---|---|---|
| `data/rlv2/event_choices.json`（505KB） | rogue_1..5 不期而遇全量效果 | 参考项目 odpy（官方 choices 的效果增强版，rogue_3/4/5 与官方 excel 数量完全一致） | `selectChoice`（lose/get/m_lose/m_get/i_get/i_lose/curse/get_id）、`moveTo` INCIDENT 生成 SCENE |
| `app/game/excel/roguelike_consts_gen.ts`（RoguelikeConsts） | 6 主题 outbuff/modebuff/recruitGrps | 运行时由官方 `customizeData[theme].developments`（含 commonDevelopment）的 `buffDisplayInfo` 派生（displayType→RoguelikeBuff 映射，PERCENTAGE 除 100、ABSOLUTE_VAL 作 count）；`buffDisplayInfo` 空的分队开发项按 `RAWRULES` 逐条给出；modebuff 官方 excel 无此表，内嵌常量（odpy rogue_2/3 难度 0-15）；recruitGrps 直接引用官方 `details[theme].recruitGrps` | `buff.create()`（outbuff/modebuff 应用）、`chooseInitialRecruitSet` |
| `data/rlv2/nodesInfo.json` | 6 主题 × zone 关卡列表（Normal/Emergency/Boss） | 官方 `details[theme].stages` 按 `ro{n}_{n|e}_{zone}_` 前缀提取 | `map.generate()` 优先读（缺失回退动态过滤） |
| `data/rlv2/choices.json` | 6 主题开局 buff（行动奖励）场景 | 官方 `choiceScenes` + `choices`（startbuff 前缀） | `RoguelikeV2Config.choiceScenes`（数据完整性） |

**selectChoice 数据源切换**：官方 excel choices 无 lose/get 效果字段（效果藏在 description `<@ro.get>` 标签），selectChoice 改读 `eventChoices[theme].choices[choice]`（lose/get/m_lose/m_get/i_get/i_lose），官方 excel 仅提供 nextSceneId/type 元数据。下一场景选项列表来自 event_choices 的 `choices` 数组（不再用 `choice_{sceneId}_` 前缀匹配——真实数据匹配不到）。

**不期而遇事件生成**：`moveTo` 到 INCIDENT（type=32）节点时从 `eventChoices[theme].enter` 随机抽场景生成 SCENE 事件。

**区域推进（zone 推进）**：`finishEvent`/`finishBattleReward`/`leaveShop`/`confirmPredict`/`selectChoice(choice_leave)` 节点结束后调 `checkZoneEnd()`——当前节点 `zone_end: true` 时推进 `cursor.zone+1` 并生成新层地图（`rlv2:zone:new`）；达到主流程最大层（`maxZone`，取有 Normal/Emergency 关卡的 zone 最大值）触发 `gameSettle()` 结算。初始阶段（zone=0）结束生成第一层地图。

**容错**：`buff.create()` 对 `outer[theme]` 缺失（从未玩过该主题）与 `modebuff[modeGrade]` 缺失均容错；`chooseInitialRecruitSet` 招募组缺失回退官方 excel recruitGrps。

**死文件清理**：`data/rlv2/choiceBuffs.json`、`data/rlv2/recruitGroups.json` 零引用已删除（数据由官方 excel/data/rlv2/event_choices.json 覆盖）。`data/rlv2.json`（RoguelikeConsts）已改为由官方 excel 派生（`buildRoguelikeConsts`），该文件已删除，不再维护。

### 16.6 藏品池功能（2026-08，战斗收藏品掉落）

**池分类**（`app/game/modules/rlv2/pool.ts` `create()`，官方 `details[theme].items` 动态分池）：
- `pool_relic_all`：全部收藏品（type === "RELIC"）
- `pool_relic_normal` / `pool_relic_rare` / `pool_relic_super_rare`：按 `rarity` 分类（NORMAL/RARE/SUPER_RARE，BORN 不在稀有度池）
- `pool_sacrifice_n/r`：可献祭物品（value 8/12）
- `pool_fragment_3/4/5`：构想碎片（INSPIRATION/WISH/IDEA，仅含 fragment 模块的主题）

**随机抽取**：`getRelic(poolId, hasRelic)`——从池随机抽一个**未拥有**的收藏品（过滤 hasRelic），**不放回**（同池不重复，`splice` 移除）。池空或全部已拥有返回空串。

**战斗掉落**（`battle.ts` `finish()` 胜利分支，参考 Dorothinights `generateBaseBattleRewards`）：
- 掉落顺序：招募券 → 金币 → 碎片 → **随机收藏品**
- 收藏品项格式 `{index, items: [{sub, id, count: 1}], done: 0}`，id 来自 `pool_relic_all`（过滤已拥有）
- 概率：普通/紧急 40%，boss 战（stage 含 `_b_`）**必掉 2 个**
- 选择链路：`chooseBattleReward` → `rlv2:get:items` → `inventory.getItem`（RELIC type）→ `rlv2:relic:gain`（已有，无需改动）

**简化（YAGNI）**：官方无"battle 池/boss 池"分组（relics 只有 id+buffs），战斗统一用 `pool_relic_all`；精确概率在客户端，私服用简化概率。

### 16.7 增益树（科技树）解锁与加成（2026-08）

**数据**（官方 excel，6 主题全）：`customizeData[theme].developments`（rogue_1..3）或 `.commonDevelopment.developments`（rogue_4..6）——节点 `{buffId, frontNodeId[], nextNodeId[], tokenCost, nodeType, buffName}`。解锁状态存 `outer[theme].buff = {pointOwned, pointCost, unlocked: {buffId: 1}, score}`（已验证 pointCost == 已解锁节点 tokenCost 总和）。

**解锁**（`rlv2.ts` `unlockBuff(theme, buffId)` + `router/roguelike.ts` `POST /roguelike/upgradeOutBuff`）：
- 校验：节点存在 → 未解锁 → 前置（frontNodeId 数组）全部解锁 → pointOwned ≥ tokenCost
- 成功：pointOwned -= tokenCost、pointCost += tokenCost、unlocked[buffId] = 1
- 请求体 `{theme, id}`（兼容 buffId 字段名）；失败返回 `{result: 1, errorMsg: NODE_NOT_FOUND/ALREADY_UNLOCKED/FRONT_NOT_UNLOCKED/POINT_NOT_ENOUGH}`
- 注意：update（Immer）替换 _playerdata 后需刷新 `this.outer` 引用

**加成**：`buff.ts create()` 开局应用 `outer[theme].buff.unlocked` 的 outbuff（已有）——新解锁节点下一局生效。

**探索分数结算**（`gameSettle()`，官方公式，用户提供 2026-08：萨卡兹方式，各主题一致）：

| 项目 | 分值 |
|---|---|
| 通过层数（档位 0/30/80/150/270/400/550/650，>7 按 7） | 档位值 |
| 通过步数（trace.length） | ×1 |
| 普通战斗次数（trace 节点 type 1） | ×10 |
| 招募干员次数（recruit.tickets[].result 非空） | ×2 |
| 获得物品数（收藏品 relicList + 战术道具 activeToolList，不含思绪） | ×5 |
| 领袖战斗次数（trace 节点 type 4） | ×30 |
| 精英战斗次数（trace 节点 type 2） | ×20 |

求和 × 难度倍率（`details[theme].difficulties[].scoreFactor`，按 mode+modeGrade 匹配，MONTH_TEAM/CHALLENGE=0）= 探索分数；默认分数→魂灵书签转换效率 1:1（`score += 探索分数`、`pointOwned += 探索分数`）。历史重构提升转换效率暂未实现（YAGNI）。

**注意**：createGame 把 MONTH_TEAM/CHALLENGE mode 转成 NORMAL（现有行为），实际结算按 NORMAL 倍率；若需 MONTH_TEAM=0 需改 createGame 保留 mode。

### 16.8 商店系统修复与路由补全（2026-08-14）

**商店（BATTLE_SHOP）原实现断裂**：
- `events.ts BATTLE_SHOP()` 返回空 content（真实实现被注释）→ 商店节点无任何商品；
- `buyGoods/refreshShop` 读 `content.shop`，官方线格式为 `content.battleShop`（抓包确认）→ 永远 no-op；
- `generateShopGoods` 价格全 0（archiveComp.relic 池 + priceCount 0）→ 客户端商店不可用。

**修复**（对照官方抓包 refreshShop/buyGoods/shopAction/leaveShop 线格式）：
- `events.ts BATTLE_SHOP(args)` 透传 `{ battleShop: args }`；
- 控制器新增 `buildShopContent(theme)`：`{ bank, id: zone_{层号}_shop, goods, canBattle, hasBoss, refreshCnt: 2, showRefresh, withdrawMethod: "fee_add", refreshMethod: "direct", _done, recycleGoods?, recycleCount? }`（FRAGMENT 模块主题附碎片回收，1 金币/件）；
- `generateShopGoods` 重写：票 4 / 临时票 8 / 碎片 4 / 战术道具 8 / 藏品 NORMAL 8 / RARE 12 / SUPER_RARE 16，约 25% 商品打折（displayPriceChg=true 价减半）；藏品池过滤已拥有、按稀有度分层抽取；
- `moveTo` SHOP 节点、`triggerNodeEvent` SHOP、`gridZoneMoveTo` 商店节点 → 生成真实 battleShop 事件；
- `buyGoods`：读 `content.battleShop ?? content.shop`（兼容旧格式），金币不足拒绝，售出商品 count 置 0（官方保留列表非移除）；
- `refreshShop`：重生成商品 + refreshCnt-1。

**路由补全**（客户端路径与既有路由不一致，官方抓包确认）：
- `/rlv2/battlePass_getReward`（下划线）——原仅 `/battlePass/getReward`（斜杠）；
- `/rlv2/nodeMission_confirm|giveUp|closeTip`（下划线）——原仅 `/nodeMission/*`（斜杠）；
- `/rlv2/scrap/identify`（缺失）——废品鉴定：控制器新增 `scrapIdentify({count})`，从 scrapItemToType 池抽 count 件入零件箱 + LEGACY 型部件，响应顶层 `{ scrap, legacy }`。

**鲁棒性**：
- `selectChoice`：pending[0] 为 GAME_INIT_GIFT（客户端先 selectChoice 后 finishEvent）时先消费礼物；
- `chooseInitialRelic`：按类型查找而非盲目 shift（重复调用不 500）；
- `rlv2/mission.ts`（0 字节空文件）、`rlv2/game.ts`（空壳类）零引用死代码已删除。

**注意（既有竞态）**：`TypedEventEmitter.emit` 为异步（Emittery），控制器构造期 `emit("rlv2:init")` 的处理器（status/map/inventory init 重置）在微任务中执行——测试在构造后立即改 rlv2 状态需先 flush 微任务（`await new Promise(r => setTimeout(r, 0))`），否则会被异步 init 覆盖。

### 16.9 黑流树海（rogue_6）集成战略方案（2026-08-19）

黑流树海是首个**无相地图（GRID_ZONE）**主题：地图不再是「层内若干节点 + 连线」，而是 **x/y 网格 + 行动力（stepRemain）驱动的自由移动**，并叠加零件箱（SCRAP）与天气（WEATHER）两个专属模块。以下为架构、接口、数据流、安全四部分设计与落地结论。

#### 16.9.1 系统架构

| 层 | 文件 | 职责 |
|---|---|---|
| 主题规则注册表 | `app/game/modules/rlv2/theme-rules.ts` | **单一事实来源**：节点类型数值、商店/战斗节点集合、各层行动力、场景前缀、结局关卡与收藏品、重掷类型映射。**不 import 任何管理器**（避免循环依赖） |
| 主管理器 | `app/game/modules/rlv2/logic.ts` | 请求编排：`gridZoneMoveTo` / `gridZoneEmptyStep` / `gridZoneReadStepZero` / `changeVehicle` / `loseScrap` / `scrapIdentify`；节点 → 事件分发 |
| 地图模块 | `rlv2/modules/grid_zone.ts` | 网格生成（构造模板 + BFS 边距离 + 数量规则）、视野、移动、误入奇境隐藏层 |
| 零件箱模块 | `rlv2/modules/scrap.ts` | 废品增删、载具切换、官方 `sellPrice` 估价 |
| 天气模块 | `rlv2/modules/weather.ts` | 层天气状态 |
| 路由 | `app/game/modules/rlv2/handler.ts` | 8 个 rogue_6 专属 POST（协议见 `api.md`） |

**分层原则**：「主题相关的**数据**」集中到 theme-rules；「主题相关的**行为**」留在各自管理器（不做上帝对象）。重构前 `theme === "rogue_6"` 与节点数值字面量散落 7 个文件 20+ 处，现全部改为查表 / `isBlackstream(theme)`。`grid_zone.ts` 对外 re-export `ROGUE6_NODE`，既有调用方零改动。

#### 16.9.2 节点语义确证（官方 `RoguelikeEventType` 位标志枚举）

关键发现：`types_excel_gen.ts` 的 `RoguelikeEventType` 按声明顺序 2^n 展开后，与 `details.rogue_6.nodeTypeData` 的 **21 个键逐一吻合**——据此可确证每个节点的官方语义，不再依赖中文名猜测：

| 值 | 官方枚举 | 中文名 | 落地行为 |
|---|---|---|---|
| 1 / 2 / 4 | BATTLE_NORMAL / _ELITE / _BOSS | 作战 / 紧急作战 / 险路恶敌 | 战斗（关卡按三池分流） |
| 16 | REST | 安全的角落 | 事件引擎：6 选项随机出 3，displayData 发放（对照文档 §13.2） |
| 32 | INCIDENT | 不期而遇 | 事件引擎 `incident.ts` 完整事件池（见 design-spec §16.9 与对照文档 §十三）；回退 `normal` / `bat` |
| 512 / 1024 | WISH / SACRIFICE | 得偿所愿 / 失与得 | 事件引擎：免费收藏品（撬桶 4 金刷新提档）/ 藏品与零件交换 + 复原“文明”差分（`relic` 血衣之下/擒与缚归不期而遇，prts.wiki 实锤） |
| 2048 | EXPEDITION | 先行一步 | SCENE `scout*`（**三结局远征入口**） |
| 4096 / 2097152 / 33554432 | BATTLE_SHOP / SCRAP_SHOP / EMPLOY | 诡意行商 / 秘境行商 / 应急助力 | BATTLE_SHOP 事件（应急助力另有 `hire*` 场景） |
| 8192 | PORTAL | 误入奇境 | 生成隐藏层（未萌生的摇篮） |
| 32768 / 65536 | STORY / STORY_HIDDEN | 命运所指 | 二结局 / 调谐仪式入口 |
| 262144 | DUEL | 狭路相逢 | SCENE `sala*` |
| 4194304 | DOOR | 曲折密道 | 地图机制（传送），无场景 |
| 8388608 | FINAL | 险路尽头 | 事件引擎：+1 加工品 + 全部行动力转希望 → ZONE_END 进区；召集同伴（留存券招募） |
| 16777216 | **EVACUATE** | 险路小径 | 事件引擎：+1 珍贵加工品，保留行动力 → ZONE_END 提前进层（三重身 3 差分） |
| 67108864 | LIGHT | 羽瞰点 | 地图机制（视野扩大 + 行动力 +1，grid_zone.moveTo），无场景 |
| 134217728 | **BATTLE_SAVAGE** | “居民”据点 | 归入战斗类（`moduleConsts.savageBubble`） |
| 268435456 | EMPTY | 林间空地 | 空节点 / 起点 |

`scrapTypeData` 官方语义同样以数据为准：**`MOVE` = 加工品**（可用于地图移动 / 误入奇境消耗）、`GOODS` = 自然物、`PASSIVE` = 概念体。

#### 16.9.3 数据流转

```
POST /rlv2/gridZone/moveTo {route:[nodeId…]}
  → router 校验 route 非空数组
  → manager.gridZoneMoveTo：清空 _pushMessages
     → gridZone.moveTo(route)（逐格扣 stepRemain、揭示视野、写 cursor.position）
     → 读 node.content.kind → 查 theme-rules 分发：
         战斗类 → BATTLE 事件 ／ 商店类 → BATTLE_SHOP 事件
         PORTAL → generatePortal（新建 3000+ 递增 zone 键）
         其余 → createRogue6NodeScene(kind)：按前缀筛 scene_ro6_*_enter，
                派生选项 choice_{stem}_*
         无匹配 → WAIT_MOVE
     → 累积 pushMessage：rlv2NodeArrive{nodeType} + rlv2NodeChange{nodeList}
  → res.send(player.delta, …, player.rlv2.takePushMessages())
```

**状态归属**：网格与游标写在 `rlv2._map.zones[1000+zoneId-1]`（隐藏层 `3000+`）与 `_status.cursor`，全部经 `player.update(recipe)` 记录 patch；`pushMessages` 为**一次性**队列，`takePushMessages()` 取走即清空，与 `player.delta` 同样禁止一次请求读两次。

#### 16.9.4 安全策略

| 面 | 措施 |
|---|---|
| 入参校验 | `gridZone/moveTo` 拒绝空/非数组 route；`scrap/loseScrap` 拒绝 `instId == null`（原静默 no-op，客户端拿不到错误） |
| 越权移动 | 路径由 `gridZone.moveTo` 逐格判定可达性与 `stepRemain`，服务端持有唯一真值，客户端仅提交路径 |
| 键冲突 | 隐藏层键从 `3000 + random*900`（可撞键覆盖已有层）改为 `nextPortalZoneKey()` 单调递增 |
| 资源消耗一致性 | `consumePortalScrap` 按官方语义消耗 **MOVE（加工品）**，并在消耗的是当前载具时切回步行，避免出现「载具指向已不存在的废品」的悬垂引用 |
| 类型安全 | `RoguelikeModule` 补 `gridZone/weather/scrap`、`CustomizeData` 补 `rogue_5/6`，消除全链路 `as any` 与 6 处 `sCRAP` 拼写兜底死分支 |
| 账号面 | 沿用私服既有约束（单账号 uid=1、`secret` 强制为 "1"），本方案未新增鉴权面 |

#### 16.9.5 bug 台账（复现 / 根因 / 修复 / 验证）

| # | 复现 | 根因 | 修复 | 验证 |
|---|---|---|---|---|
| B1 | rogue_6 走到安全的角落/得偿所愿/失与得/**先行一步**，客户端无事件、直接可继续移动 | `triggerNodeEvent()` 定义但**零调用**，`gridZoneMoveTo` 只处理战斗/商店/PORTAL/PROPHECY/INCIDENT，其余落 WAIT_MOVE；三结局入口因此不可达 | 新增 `createRogue6NodeScene(kind)` 按 `ROGUE6_NODE_SCENE_PREFIX` 生成 SCENE；删除死方法 `triggerNodeEvent` | `rlv2-node-dispatch.test.ts` 参数化 8 类节点断言 SCENE 生成 + `choice_ro6_scout_1/3` 存在 |
| B2 | rogue_6 隐藏层重掷节点无任何变化 | `rerollNode` 用 `zones[zone]` 而非 `zones[zoneKey(zone)]`（rogue_6 为 1000+ 键）直接 return；且 typeMap 缺 11 类新节点 | 改用 `this.zoneKey(zone)`；typeMap 换成 `ROLL_NODE_TYPE_VALUES`（25 项） | 同上测试：1000+ 键可取到节点、`SCRAP_SHOP → SECRET_SHOP` |
| B3 | 客户端地图不刷新节点状态 | `gridZone/*` 路由未传第 5 参 `takePushMessages()`，`rlv2NodeArrive` 永不下发 | 路由接线 + 控制器内累积两类消息 | 断言累积后取走即清空 |
| B4 | 精英/首领节点打出普通关卡 | `generate()` 算出 `eliteStages` 后**未使用**，三类节点共用普通池 | 引入 `ZoneStagePools{normal,elite,boss}`，正则 `^ro6_b_{zone}(_|$)` 提 boss 池 | 断言 map 内节点 stage 前缀分流 |
| B5 | 多次误入奇境偶发覆盖已生成隐藏层 | 隐藏层键 `3000 + Math.random()*900` 可能重复 | `nextPortalZoneKey()` 递增分配；起点 state 与主层统一为 2 | `rlv2-gridzone-portal.test.ts` |
| B6 | 误入奇境消耗加工品时选错件 | `scrap.gain()` 的 `value` 恒为 1，排序失效 | 新增 `sellPriceOf()` 读官方 `goods/move/passiveScrapData.sellPrice` | 断言 gain 值=2、开局 s_1 值=1 |
| B7 | 全链路 `as any`、`sCRAP` 拼写兜底 | `RoguelikeModule`/`CustomizeData` 类型缺口 | 从 `types_excel_gen.ts` 复用权威定义并补字段 | `tsc --noEmit` 全绿 |
| B8 | — | 死代码 `NODE_TO_KIND`、未用 `occupied` Set、硬编码 `PORTAL_FAMILY` | 删除；改 `pickPortalTemplate` 按数据字段 `utopiaPortal(s)` 筛选（该字段实为**雾色场景族编号**，非"列") | 全量 rlv2 测试通过 |
| B9 | 误入奇境后零件箱少的是自然物而非加工品 | `consumePortalScrap` 筛 `t !== "MOVE"`，与官方 `scrapTypeData` 语义**颠倒** | 改为 `=== "MOVE"`，并处理载具回退 | portal 测试由红转绿 |

**验证结果**：`pnpm exec tsc --noEmit` 通过；`pnpm exec vitest run` 1957 passed（2 个失败为改动前既有：`pay-gate`、`plugin-config-service`，已用 `git stash` 复核与本方案无关）；新增 `tests/unit/controller/rlv2-node-dispatch.test.ts` 21 条全绿。

#### 16.9.6 简化项（YAGNI）

- `data/rlv2/event_choices.json` 无 rogue_6 分区，选项效果沿用官方 excel 元数据，不补效果增强表；
- `nodesInfo.json` 已含 rogue_6 关卡列表，但 `grid_zone.ts` 仍从 `details.stages` 前缀过滤（两处结果一致，未做切换）；
- 三结局的完整剧情分支（远征后续场景链）仅接通入口，未逐幕实现。

---

## 17. 子域名分发与远程配置

### 17.1 子域名分发（app/config/host-router.ts）
私服场景：客户端通过改 hosts/DNS 将 `*.hypergryph.com` 指向私服，请求保留官服子域名 Host 头。`createHostRouter()` 中间件按子域名映射：
- `as.hypergryph.com/*` → `/auth/*`（账号系统）
- `ak-conf.hypergryph.com/*` → 保持（配置：/config/prod、/api/remote_config）
- `ak-gs-gf.hypergryph.com/*` → 保持（游戏：/account、/user 等）
- `game-config.hypergryph.com/*` → 保持（新版远程配置）
- 非 `*.hypergryph.com`（localhost/IP 直连）不重写

**mitmweb 重定向场景**（`mitmweb -M "|^https?://.*\.hypergryph\.com(.*)|http://127.0.0.1:8443\1"`）：
mitmproxy map remote 设置 URL 时会同步改写 Host 头为 `127.0.0.1:8443`，子域名信息丢失。此时启用**路径级兜底分发**（`applyPathFallback`）：
- `/game/*` → 剥 `/game` 基址前缀（ak-gs 域路径化形式）
- `/app/*`、`/u8/*`、`/user/auth*`、`/user/info*`、`/user/online*`、`/user/oauth2*` → 加 `/auth` 前缀（as 域接口）
- 游戏域 `/user/changeSecretary`、`/user/buyAp` 等二级段不在列表，不会被误判

**客户端事件批量上报**：`POST /batch_event`（游戏域根级接口，home.ts）——客户端定期上报行为事件，私服返回空对象 `{}`（客户端只认状态码）。

### 17.2 新版远程配置接口（app/config/remote-config.ts）
新版客户端（game-config 域名）请求的两个接口：
- `/api/remote_config/1/prod/default/Windows/network_config` → 网络端点配置（官方扁平格式：an/as/gs/hu/u8/hv 等，域名替换为私服地址）
- `/api/remote_config/1/prod/default/Windows/remote_config` → 功能配置（官方格式：fapv2/HGDownload_1/2、enableGameBI、enableNativeLicense、bakeMuzzleEnableRate 等）

功能配置字段可在 `data/config.json` 的 `RemoteConfig` 覆盖，缺省使用官服默认值。

### 17.3 已知约束
- Node fetch 会覆盖自定义 Host 头——子域名验证需用 node http 或 curl（E2E 经验）
- 旧版 `/config/prod/official/network_config`（{sign, content} 格式）保持兼容（prod.ts 复用 buildNetworkConfigContent）

### 17.4 抓包专用官服转发模式（app/proxy/official-forward.ts，--capture）
主服务器新增可切换的抓包专用官服转发模式：`pnpm run start:capture`（等价 `tsx index.ts -s --capture`）或 `data/config.json` 的 `capture.enabled: true` 开启。开启后 **as/gs 流量不再由私服响应，而是转发到官服**并记录响应到统一抓包存储 `tmp/capture/`（capture 模式强制 `debug.recordTraffic=true`，source=official），用于与私服响应逐接口对比 / 协议逆向（§17.7）。

**挂载位置**：index.ts 在 host-router + `/config/prod`、`/api/remote_config`、`/api/gate`、`/api/game`（launcher）之后、`/` auth 之前挂 `createOfficialForwarder()`。config/launcher 保持本地——客户端才能拿到指向本代理的 network_config 被引导连进来。

**路由分发规则**（`resolveForwardTarget` 纯函数，与 scripts/proxy-harness.ts / §17.1 路径级兜底一致）：
- **Host 优先**：`as.*` → `as.hypergryph.com`（路径原样，官服无 /auth 前缀）；`ak-gs-*` → `ak-gs-gf.hypergryph.com`（剥 `/game` 基址前缀，本地挂载点同样排除）；其余 `*.hypergryph.com`（ak-conf/game-config 等配置域）→ 不转发，保持本地
- **路径级兜底**（Host 非官服：localhost/IP 直连 / mitmweb 重写）：as 前缀 `/user/auth|info|online|oauth2`、`/u8`、`/app`、`/general`、`/as`（剥路径化前缀）→ as 域；`/game/*` → gs 域（剥前缀）；**其余 POST** → gs 域根路径兜底（/account、/shop、/activity、/user/checkIn、**/arkodc**（ODC 小游戏活动路由——安洁莉娜的旅行小记 / act53side；OBS 即从官服逆向，照常转发抓真实响应）等），但**排除本地挂载点** `/admin` `/assetbundle` `/pcSdk` `/config` `/api` `/audit` `/batch_event`（管理/配置/事件上报由私服响应——`/batch_event` 由 home.ts 返回 `{}`，转发官服只得 404 噪音，用户明确要求不转发；Host 级 ak-gs-* 分支同样排除）；GET 非 as 路径不转发（保持本地响应）
- 官服对双斜杠路径返回 404，endpoint 统一归一化去前导斜杠；`validateStatus: () => true` 原样透传官服 401/400 等状态；网络层错误（官服不可达）返回 502
- **content-length 剥离**（2026-08-09 修复）：客户端原始 body 可能带空白/换行（实测 oauth2/v2/grant 原始 94B、解析后重序列化 74B），透传 `content-length` 会让官服按声明长度等剩余字节而**永久挂起**（`POST /user/oauth2/v2/grant` 20s 无响应）。转发头剥离 `host`/`content-length`/`transfer-encoding`，由 axios 按实际 body 重算。test.ts 同步修复。
- **/u8 双写修复**（2026-08-09）：路径级兜底的 as 前缀 baseUrl 一律为 as 域根地址、path 保留完整原路径（含 `/u8`）——若 baseUrl 再拼 `/u8` 基址会与 path 里的 `/u8` 双写（实测 `as.hypergryph.com/u8/u8/user/v1/getToken` → Go 404，修复后 400 字段校验）。test.ts 的 `app.post("/u8/*endpoint", ...)` 通配符不含 `/u8` 前缀，无此问题。
- **multipart 原始字节透传**（2026-08-09 修复）：非 JSON 请求（实测 `POST /activity/arkhub/savePixelArt` 为 multipart/form-data 2106B）`express.json` 不解析 → `req.body` 为空 `{}`，透传会让官服 400 `"Invalid multipart payload format"`。index.ts capture 块在 `bodyParser.json` 后挂非 JSON 原始体捕获中间件（`req.rawBody`），转发器 POST 时优先用 `rawBody` 原样透传字节（content-length 已剥离由 axios 重算）。test.ts 同步修复。

**登录链路**：客户端经本地 network_config 连到本代理 → `/user/auth/*`、`/u8/*`、`/user/oauth2/*` 转发 as 域拿到**官服真实 token** → `/account/login` 等 gs 请求带真实 secret 转发 `ak-gs-gf` 由官服校验。转发命中后不 `next()`，私服 authMiddleware/游戏路由不参与，故不受单例 secret 强制影响。

### 17.5 arkhub 网关特殊适配（app/game/modules/activities/arkhub/capture/proxy.ts）

> **模块分层（2026-09-13 重构）**：arkhub 活动族已按 enemyDuel 样式重组为
> `domain/`（状态 / ARKDEX / 像素格式）+ `session/`（长连接协议栈 `messages → codec → contract → dispatch → handlers → server`，
> 启动绑定 `session/bindings.ts`）+ `capture/`（本节转发器与帧解析）；
> 模块外（`app/server.ts`、`app/ops/**`、`scripts/**`、`tests/**`）一律经 `public.ts` 门面，
> 守卫见 `tests/unit/architecture/module-boundary.test.ts` 的 R5/R6，
> 完整记录见 `docs/arkhub-重构-2026-09-13.md`。

阿卡狄亚（arkhub）是独立实时网关玩法：`POST /activity/arkhub/enterHall` 响应返回 `{ result, endpoint: "arkhub-gateway.hypergryph.com", port: 30000 }`，客户端随后用 BestHTTP WebSocket 连该网关（私有协议，明文 TCP；TLS 握手被直接断开、明文 WS 握手无响应）。capture 模式两项适配（2026-08-09）：
1. **enterHall 响应改写**：`createOfficialForwarder` 收到 `arkhubGateway` 选项且路径为 `/activity/arkhub/enterHall` 时，把 `endpoint` 改写为 `config.Host` 去 scheme、`port` 保持网关端口——否则客户端直连官服网关（hosts 重写时连 127.0.0.1:30000 无监听而失败，且网关流量不经过代理）。非网关形状响应（如 401）原样透传。
2. **TCP 转发器（端口自动避让 + ODC 帧解析）**：`startArkhubGatewayProxy` 首选 `config.capture.gatewayPort`（缺省 30000），被占时自动尝试下一个空闲端口（port, port+1, ... 最多 50 次）——多实例并存时每个实例各拿一个空闲端口（如 30000/30001/30002），enterHall 改写用**实际监听端口**，客户端互不干扰。返回 `{ server, port, exhausted, adjusted }`：全部避让端口被占（exhausted，极罕见）时仍改写指向配置端口（其上大概率有另一实例转发器）。每个连接建立到官服网关的透传管道（纯 TCP pipe，客户端自带上层握手/鉴权），双向字节流落盘 `tmp/capture/records/{connectionId}/`（统一抓包存储的网关记录目录：up.bin=客户端→官服、down.bin=官服→客户端、meta.json；connectionId 即记录 rid），连接关闭时按 **奇象巡展（arkhub）网关帧协议**（见下）解析写 `parsed.json`/`messages.json`，并提交一条 direction=gateway-bidi 的抓包记录（source=gateway）。实现注意：每次尝试**新建 server**（复用同一 server 重 listen 有回调错乱问题，实测 adjusted 结果错乱）。

**奇象巡展（arkhub）网关帧协议**（app/game/modules/activities/arkhub/capture/protocol.ts，2026-08-11）：帧 = `[4B 大端总长度][4B 大端消息 ID][8B 头字段（8-11 疑 seq、12-15 疑 flag/会话ID）][protobuf payload]`。`decodeProtobuf` 通用解码（varint/fixed64/length-delimited/fixed32 + 嵌套消息，嵌套启发式：首字段 wire 0/2 且非可读文本——避免 uid 等 ASCII 串误判）。MSG_NAMES 观测映射：1=MoveReq（8B 非 protobuf）、2=MoveNotify、4=Login（UserLoginReq up / UserLoginResp down）、8=NetProbeData（心跳 08 00 / 探针 10 80 02+15B / 玩家数据 0a 变体）。实测 up 流 3176 帧零断帧；**down 流部分会话登录后为连续 protobuf/自定义封装**（长度前缀不可切，余量 hex 如实记录——该变体仅在特定玩法触发，需进一步逆向）。离线重解析：`pnpm exec tsx scripts/parse-arkhub-gateway.ts [rid]`（从统一抓包存储读取，缺省解析全部 gateway-bidi 记录）。

**网关协议完全解析**（docs/arkhub-gateway-protocol.md，2026-08-11）：帧格式/消息族（msgId1/2=定长二进制 type+param 移动协议、msgId4=Login 双向字段号实测验证、msgId8=位置/探针通道）/down 记录流恢复/37 类消息字段名清单/剩余未知项精确定位（msgId8 位置块布局、记录流帧边界、msgId 注册表）。工具：`pnpm exec tsx scripts/dump-gateway-dict.ts` 输出协议字典。

**与 scripts/proxy-harness.ts 关系**：`scripts/proxy-harness.ts`（`pnpm run ts`，8444）是独立纯转发抓包代理，规则同源、记录写入同一统一抓包存储（source=harness，支持 `--session <名称>` 命名会话）但可独立运行；本模式把同一套规则并入主服务器（8443），免去另起进程。**账号说明**：capture 模式用官服账号登录（reference/checkin-master/accounts.txt），与私服账号体系互不相通。

### 17.6 管理后台像素画工具 + 上传官服（2026-08-09）
Dashboard 新增「像素画」Tab（app/admin/dashboard/index.html `loadPixelPane`）：24×24 画布编辑器（40 色调色板绘制/橡皮擦/清空/示例），下载 PNG / 像素数据，上传官服。

**像素数据格式**（逆向确认）：24×24×3 RGB 共 1728 字节，空白 (255,255,255) 为透明背景；md5 即 1728 字节的 md5（`RequestPixelArtUploadTokenReq` 的 Md5 字段）。工具模块 `app/ops/admin/arkhub-pixel.ts`（PIXEL_PALETTE 默认 40 色——官服热更 display_meta_table.pixelMapData.paramMap.htmlColors 本地为空，可替换）。

**上传官服流程**（`official-ops.uploadPixelArt`，`/admin/api/pixel/upload-official`）：
1. `OfficialSession.login`（HTTP 会话）→ uid/secret
2. **网关**（app/ops/admin/arkhub-gateway-client.ts）申请上传 token：帧 `[4B 大端总长含自身][4B mainID][8B subID][protobuf]`；UserLoginReq mainID=4 subID=0x0fa1（HTTP secret 可直接网关登录，code 100=OK、112=RelayLoginSuccess 表示账号已有活动会话）；RequestPixelArtUploadTokenReq mainID=8 subID=0x00029CE231D603B3，消息体 `[4B 递增序列前缀][field2=Md5]`，响应 subID=0x00029CE231D60CF6 `[前缀][Code][Credential{pixelArtId,uploadToken,expireTime}]`
3. **HTTP multipart 上传** `POST /activity/arkhub/savePixelArt`（与真实客户端字节级一致）：`json` part（name="json" filename="json_info"，body=`{"brief":{"activityId":"act1arkhub","token":"<token>"}}`）+ `pixelData` part（name="pixelData" filename="pixelDataFile" Content-Type=multipart/form-data，1728B）
4. **网关保存确认** SavePixelArtReq mainID=8 subID=0x00029CE231D674D5 `[PixelArtId][UploadSuccess=1][DoPublish=0]`

**实现要点（2026-08-09 已端到端验证）**：登录后须发**场景 hello**（mainID=8 subID=0x00018FB64DE29CDB proto=`08 00`）并等约 1.5s 让场景数据就绪，token 请求才可用（缺 hello 时服务器关连接）；close 时发登出帧（subID=0x0002C89B38B3C3C9 proto=`08 01`）释放会话绑定。**限制**：账号同时只允许一个活动网关会话（重复登录返回 112 中继，RelayLoginSuccess），旧会话过期（约 1-3 分钟）后恢复；失败时给出可操作错误。已实测上传成功：pixelArtId 返回、getPixelArt 可查。

### 17.7 现代化抓包管理系统 + 统一日志管理（2026-08-14）

把散落的抓包能力与日志来源统一为一个**有索引、可查询、可管理**的系统，并在管理后台新增「抓包」「日志」两个 Tab。

**统一抓包存储**（`app/capture/capture-manager.ts` 单例 `captureManager` + `app/capture/capture-db.ts`，SQLite `node:sqlite`）：

```
tmp/capture/
  index.db                  # 元数据索引：sessions（会话）+ records（记录）
  records/{rid}/            # body 文件目录（rid = R-{ts}-{seq}）
    req.json|req.bin        # 请求体（JSON→.json；原始字节/二进制→.bin）
    res.json|res.bin        # 响应体
    up.bin/down.bin         # 网关连接原始字节流（direction=gateway-bidi）
    parsed.json/messages.json  # arkhub 网关帧解析产物（连接关闭时生成）
    meta.json               # 完整元数据副本（导出/便携）
  exports/                  # 会话导出 zip（jszip）
```

- **来源统一**（records.source）：`private`（私服 traffic-recorder）/ `official`（capture 官服转发）/ `harness`（独立代理 proxy-harness）/ `gateway`（arkhub 网关连接）/ `ops`（官服操作 official-ops）。无显式会话的记录自动归入「自动-{yyyyMMdd}」默认会话（每源每天一个，保持全量记录旧行为）。
- **写入方改造**：`traffic-recorder.ts` 改为调 `captureManager.addRecordAsync`（中间件不落散文件；source 由 index.ts 传入）；**默认排除本地管理/资源/配置噪音**——`/admin`（管理页面 + API + 30s 轮询）、`/assetbundle`（资源大文件）、`/pcSdk`、`/config`、`/api`（launcher/remote_config）、`/audit`、`/batch_event`（事件上报）不记录（与 official-forward 的 LOCAL_ONLY_PREFIXES 对齐），可用 `debug.recordTrafficExclude` 覆盖（`[]` = 全部记录）；`scripts/proxy-harness.ts` 弃 console.*/printJson，改用 logger + captureManager（支持 `--session <名称>`）；`app/game/modules/activities/arkhub/capture/proxy.ts` 连接关闭时提交 gateway-bidi 记录（记录目录即统一 records/ 子目录，rid=connectionId）；`official-ops.ts` 官服调用记录 source=ops（保留 secret 脱敏）。
- **查询/管理**：`captureManager.query()`（sessionId/source/method/path/module/endpoint/status/direction/from/to/q + 分页 + total）、`getRecordDetail()`（JSON body 解析对象、bin body 返回 base64/hexPreview、缺失文件标记 missingFiles）、会话 start/stop/delete（级联删记录目录）、`clearAll(CLEAR)`、`exportSession(id)`/`exportRecord(id)`（jszip）、`stats()`（来源/状态码/按天）、`subscribe()`（新记录事件 → SSE 实时尾随）。
- **旧格式迁移**：原 `tmp/{module}/{endpoint}/{ts}.json` 散文件格式废弃；`scripts/extract-arkhub-pixel.ts`（从 store 查最近 savePixelArt 记录读 req.bin）、`scripts/parse-arkhub-gateway.ts`、`scripts/dump-gateway-dict.ts`（从 store 读 gateway-bidi 记录）已迁移；测试真实抓包期望值归档 `tests/fixtures/rlv2-finishEvent.json`。**存量旧数据合并**：`pnpm exec tsx scripts/migrate-capture-legacy.ts [--dry-run] [--keep]` 把历史散文件（记录器目录格式 + 顶层扁平 `{模块}_{接口}_req|res_{id}.json` + official + arkhub-gateway 连接）合并进统一存储（归入「旧格式迁移」会话，note 记录源路径，成功即删源文件）——旧代理 req/res 序号存在 n↔n-1 偏移，扁平配对按此规则；无法还原路径的顶层旧文件（getAllProductList*/tokenpass*/v2grant* 等）跳过保留。
- **测试**：`tests/unit/capture/capture-manager.test.ts`（11 用例：CRUD/过滤/会话/clear/导出/订阅/惰性 init，临时根目录注入，不碰真实 tmp/capture/）。

**统一日志管理**（`app/logs/log-service.ts` 单例 `logService` + `app/utils/sse.ts`）：

- **服务器日志** `logs/server-YYYYMMDD.log`：`listServerLogDates()` / `readServerLog({date,level,tag,q,limit,offset})`（行正则解析、倒序分页）/ `clearServerLogs(CLEAR)`。
- **审计日志** `data/admin/logs.jsonl`：`readAuditLog({action,uid,q,limit})`（复用 AdminService）；`AdminService._audit` 广播 `logService.emitAudit` → 实时尾随数据源。
- **看门狗日志** `logs/watchdog-*.log`：`readWatchdogLog()`。
- **实时日志**：`logger.subscribeLog`（app/utils/logger.ts 新增订阅列表，write() 级别过滤后广播 `{ts,tsMs,level,tag,text}`，不影响文件/控制台输出）。
- **SSE**（app/utils/sse.ts）：`createSse`（text/event-stream + 15s 心跳 + close 清理）+ `sseSend`；index.ts compression 已排除 `/stream` 路径（zlib 缓冲会破坏逐事件推送）；adminAuth 支持 `?token=` 查询参数（EventSource 无法自定义请求头）。

**管理 REST API**（app/admin/admin-router.ts，全部登记进 api-spec.ts → OpenAPI 自动生成）：

- 抓包：`GET/POST /api/capture/sessions`、`POST /api/capture/sessions/:id/stop`、`DELETE /api/capture/sessions/:id`、`GET /api/capture/records`（过滤+分页）、`GET|DELETE /api/capture/records/:id`、`POST /api/capture/clear`、`GET /api/capture/stats`、`GET /api/capture/sessions/:id/export`（zip 下载）、`GET /api/capture/records/:id/export`、`GET /api/capture/stream`（SSE）。
- 日志：`GET /api/logs/server`、`GET /api/logs/server/dates`、`GET /api/logs/watchdog`、`GET /api/logs/audit`（兼容旧 `/api/logs`）、`POST /api/logs/server/clear`、`GET /api/logs/stream?kind=server|audit|capture`（SSE，回填 50 条后直播）。

**Dashboard**（app/admin/dashboard/index.html）：侧边栏新增「系统」分组——「🕸️ 抓包」Tab（会话新建/停止/删除/导出、来源/方法/状态码/关键字过滤、3s 轮询或 SSE 直播、行点击查看请求/响应头 + 语法高亮 JSON + 二进制 base64、单条导出、**与基准记录逐接口 JSON diff 对比**（新增/删除/修改红绿高亮，支撑"官服 vs 私服"核心场景））与「📜 日志」Tab（服务器/审计/看门狗三个子页、级别/日期/关键字过滤、SSE 实时尾随、导出当前视图、清空（确认词））。全局 Tab 注册进 GLOBAL_TABS/TAB_LABELS/loadPane。

**CLI**（scripts/admin-cli.ts dispatch，cli-exec.ts 自动继承）：`capture sessions|start|stop|records|show|stats|export|clear`、`logs server|watchdog|audit|clear|server-clear`。

---

## 18. 助战系统

### 18.1 用途
明日方舟助战：玩家在助战位放置干员（社交）、好友在编队时可借用（战斗）。私服单机场景：多账号互相借用。

### 18.2 接口
| 接口 | 行为 | 状态 |
|------|------|------|
| `POST /social/setAssistCharList` | 保存助战干员列表（charInstId/skillIndex）到 `player.social.assistCharList` | 既有 |
| `POST /quest/getAssistList` | 编队助战列表：按职业筛选好友助战干员，随机最多 6 个、charId 去重，返回 OrigChar 结构 | **本次新增** |
| `POST /quest/battleStart` | 战斗开始保存 `assistFriend`（uid/assistChar/assistSlotIndex）到 BattleInfo | **本次补全** |

### 18.3 数据流
1. **设置**：`setAssistCharList({assistCharList})` → `player.social.assistCharList`（{charInstId, skillIndex} 引用）
2. **展示**：`socialInfo` getter 把助战 charInstId 映射为完整干员数据（charId/skills/level/favorPoint 等）——好友列表/助战列表复用
3. **借用**：`getAssistList({profession})` 读好友 `socialInfo.assistCharList` 按职业匹配（excel.CharacterTable[charId].profession）→ 构造 OrigChar（nickName/uid/level/avatar/assistSlotIndex/powerScore=200 简化）；**好友数据不足 6 个时从其他账号随机补位**（isFriend=false、canRequestFriend=true、aliasName=null）
4. **战斗**：`battleStart` 的 `assistFriend`（SquadFriendData）保存到 BattleInfo（供结算/日志）

### 18.4 已知约束
- 战斗内助战干员数据由客户端自带（encryptBattleData）——服务端仅记录 assistFriend，不额外处理干员进队
- 助战社交点结算（借出方 yesterdayReward.assistAmount 累加）**未实现**（YAGNI）——需跨玩家写入 + 每日重置机制，留后续
- powerScore 简化为固定 200（参考实现也是 TODO）
- 好友关系数据来自 SQLite（social.db）——getAssistList 依赖好友关系存在

---

## 19. 用户创建与自动注册

### 19.1 创建方式（三种等价入口）
| 入口 | 说明 |
|------|------|
| `POST /auth/user/auth/v1/token_by_phone_password` | **登录自动注册**：手机号+密码不存在时自动创建用户并返回 token（新 uid） |
| `pnpm run admin -- users create <phone> [password]` | 管理后台 CLI 创建 |
| Dashboard「+ 创建用户」 | Web 管理界面创建 |

### 19.2 实现（AccountManager.registerUser）
- **模板复制**：以 `data/user/databases/1.json` 为模板深拷贝，替换 uid/昵称（博士{uid}）/注册时间
- **uid 递增**：现有账号最大值 +1
- **注册**：写入 `databases/{uid}.json` + SQLite `users` 表（auth.phone=手机号、hgId=uid、password=密码；users.json 已迁移为种子不再写入）
- **secret 生成**：`generateSecret(phone)` = MD5(phone + 渠道密钥)（确定性）——token=secret 语义（参考 DoctoratePy）
- **查重**：手机号已存在抛错

### 19.3 数据流
1. 客户端输入新手机号+密码登录 → `tokenByPhonePassword` 未匹配 → `registerUser` 自动创建 → 返回账号 secret 作为 token（**不是 uid**——旧实现返回 uid，2026-08 对齐 DoctoratePy token=secret 模型）
2. 后续 `grant`/`getToken`/`syncData` 走标准流程（token=secret 或 uid 兼容）
3. 管理后台 CLI/Dashboard 的 createUser 复用同一注册逻辑（DRY）

### 19.4 已知约束
- 模板存档缺失（1.json 被删）时注册失败并给出清晰错误
- 新用户昵称固定「博士{uid}」、等级/资产继承模板（1 号账号）——私服简化
- 服务器运行中注册的新用户**免重启**：`getPlayerData(uid)` 懒加载（`_loadPlayer`）——data 缺失时自动从 `databases/{uid}.json` 读取并加载（与 init/ensureSingleUser 共用加载逻辑）

### 19.5 完整 Token 登录流程（2026-08-07）
客户端登录链路（对齐 DoctoratePy `server/account.py` accountLogin）：

```
① POST /user/auth/v1/token_by_phone_password {phone, password}
      → {data: {token}}                                   [as 域，账号 token = secret]
② POST /user/oauth2/v2/grant {appCode, token}
      → {data: {code, uid}}                               [as 域，授权码]
③ POST /account/login {token, clientVersion, networkVersion}
      → {result:0, uid, secret, serviceLicenseVersion:0, majorVersion:"446"}   [gs 域，换游戏凭证]
④ 客户端所有游戏请求带 secret 头 → authMiddleware 解析玩家
      single：强制 secret=singleUid（任意 token 收敛）
      real：getUidByToken(secret) → getPlayerData(uid)，无效 401
```

关键实现：
- **`/account/login` 按 token 动态解析**（`app/game/modules/account/routes.ts`）：读 `req.body.token` → `accountManager.getUidByToken(token)`（real 按 uid/secret 双查；single 任意 token 收敛 singleUid）→ 返回动态 `uid` + `secret`（账号 secret，无则回退 uid）——**无效 token 返回 `{result: 3}`**（参考 DoctoratePy「记忆已经模糊，请重新输入登录信息」）
- **版本校验 YAGNI**：`clientVersion`/`networkVersion` 读取但不拦截——私服客户端版本可能滞后于配置（用户不跑 update），严格校验（result 2/5）会卡登录且客户端不报原因；版本同步由 `syncGameVersion`（22 章）负责
- **`getTokenByUid(uid)`**：返回 `configs[uid].secret || uid`（完整 token 语义；旧账号无 secret 回退 uid）
- **`getPlayerData(uid)` 懒加载**：data 缺失时 `_loadPlayer` 从存档文件读取——real 模式注册新账号后登录/同步免重启
- **防御**：`/account/syncData`、`/account/syncStatus`、`/account/syncPushMessage` 在 `httpContext` 无 playerData（real 模式无 secret 头）时返回 **401** 而非 500
- **`loginout`**：返回 `{result: 0}`（对齐 DoctoratePy onlineV1LoginOut）

---

## 20. 服务端性能评估与优化

### 20.1 实测基准（2026-08-06，真实存档 + 本地压测）
| 指标 | 实测值 |
|------|--------|
| 启动耗时 | excel 927ms + accountManager 123ms ≈ 1.05s |
| 请求延迟（/account/syncStatus ×100） | p50 22ms / p95 37ms / p99 109ms |
| 内存 | RSS 455MB（heap 230MB——excel 154.6MB 源文件对象驻留） |
| 存档序列化 | 6.6ms/次（1.3MB JSON） |
| 磁盘写 | <1ms（1413MB/s） |

### 20.2 已实施优化
1. **原子写**（`savePlayerData`）：先写 `{uid}.json.tmp` 再 `rename`——避免写盘中断导致存档截断损坏（评估中发现 1.json 曾损坏）——`perf(auth): 存档原子写与防抖合并保存`
2. **防抖合并**（`scheduleSave`/`flushSave`）：save 事件改为 500ms 防抖——窗口内多次变更只落盘一次（多玩家/高频请求场景每请求省 ~6.6ms 序列化）；`flushSave(uid)` 可显式立即保存（服务器关闭时调用）——同上提交
3. **excel 并行加载**：`excel.init` 的 44 个串行 `await readJson` 改为 `Promise.all` 批量加载（loaders 数组）——IO 重叠，启动 927ms → 848ms（~9%）；收益受限于 JSON.parse 单线程 CPU——`perf(excel): 数据表并行加载`
4. **syncData 直改时间戳**：登录全量同步改为直改 `pushFlags.status`（免 Immer update 与存档防抖保存）；实测基线 avg 20.7ms / p95 52ms（响应 1290KB）——大头为 1.3MB 序列化（不可避免），Immer 惰性代理本就不深拷贝全量——`perf(sync): syncData 直改时间戳`

### 20.3 待优化项（YAGNI 暂缓）
- **excel 懒加载**：启动 927ms 主要耗时（154.6MB JSON 全量 parse）——可改为按需加载 + 缓存（收益：启动降至 ~200ms）
- **存档拆分**：玩家活跃/历史数据分文件——降低单次序列化体积
- **多实例内存**：excel 对象驻留 230MB heap——多开场景注意

### 20.4 评估结论
单玩家私服场景性能充足（p95 37ms，余量 5 倍以上）；已实施原子写保证数据安全；防抖为多玩家场景预留扩展。

---

## 21. 服务器地址配置

### 21.1 Host 默认值
`data/config.json` 的 `Host` 默认 `http://127.0.0.1`（本机/模拟器连接）——不再硬编码局域网 IP。

### 21.2 auto 自动检测
`Host` 设为 `http://auto` 时，启动自动检测本机**第一个非回环 IPv4**（`os.networkInterfaces`）——真机/局域网连接场景（换网络环境无需改配置）；无局域网 IP 时回退 127.0.0.1。

```json
{ "Host": "http://auto" }   // 自动检测局域网 IP
{ "Host": "http://127.0.0.1" }  // 本机/模拟器（默认）
```

客户端通过 `network_config` 接口（gs 字段）拿到实际连接地址。

---

## 22. 资源与版本自动同步

### 22.1 触发时机
- `pnpm run update`（CLI 手动）
- 服务器**在线模式**启动（index.ts 自动调 `updateModule.main(false)`）
- 离线模式跳过（不联网）

### 22.2 更新流程（scripts/update-data.ts main）
1. **官方热更 excel 管线**：`pnpm exec tsx scripts/official-excel.ts --download --decode --convert`（纯 TS，零 Python 依赖，不依赖任何第三方数据仓库）——拉热更清单（本地无网时自动选 `reference/hotupdate/hot_update_list_*.json` 中最新的快照）→ 下载 excel bundle → UnityFS 解包 + FBO/AES 解码到 `reference/hotupdate/excel_json/` → 转换为服务端格式（camelCase + 枚举字符串）写入 `data/excel/`，并为每张表旁挂 `<表>.json.meta.json` 溯源指纹（`sourceMtime`/`schemaMtime`/`csSource`）
2. **anon Lua 提取**：`scripts/extract-lua-hot.ts`（非致命，复用上一步已下载的 anon 资源，不额外联网）
3. **类型生成**：`generate-types.ts`（统一 CS 反编译源生成器 → `types-playerdata.ts` + `types_excel_gen.ts`，原 FBS 版已删除）；CS 源经 `scripts/lib/cs-source.ts#resolveCsFile()` 通配探测最新，`reference/` 缺失时跳过并告警而非失败
4. **版本同步**（`syncGameVersion`）：调官服 `ak-conf.hypergryph.com/config/prod/official/Android/version`（复用 `scripts/official-api.ts` 的 `getResVersion`）→ 更新 `data/config.json` 的 `version`（clientVersion/resVersion）——客户端版本接口/热更新列表据此工作
5. **收尾自检**：`verifyTableFreshness()` 校验各表是否同批刷新（发现「部分表未重转」的混合数据集）

> **gacha 卡池详情**（`data/gacha_detail_table.json`）不在本管线生成（`data/gacha/` 源目录已移除），由 `pnpm run admin -- official gacha-sync` 从官服同步。

### 22.3 实测
`syncGameVersion` 真实拉取：`2.6.xx/… → 2.7.71/26-09-03-04-06-11_79371a`（版本无变化时跳过写盘）。

> 参考数据链路（客户端反编译 → FBO schema）：`pnpm run decompile`（Cpp2IL + ilspycmd）产出 `reference/arknights-<版本>-csharp/` 与签名文件 `reference/com.hypergryph.arknights_<版本>.cs`，随后自动执行 `cs2schema --check` 做 **schema 漂移门禁**——C# 字段序 = FBO vtable slot 序（`slot = 4 + 2×字段序`），字段插入中部会让其后全体 slot 位移并导致解码错位（症状：向量长度天文数字、V8 `Invalid string length`、OOM）。手动命令：`pnpm run schema:check` / `schema:diff` / `schema:write`。

### 22.4 注意
- **版本与资源需同步更新**：单独跑 syncGameVersion 会得到新版本号但本地 excel/assets 仍是旧数据（客户端请求新资源会 404）——正确做法是完整 `pnpm run update`（数据+版本一起）
- 版本更新后需重启服务器生效（config 启动时读取）

---

## 23. OBS 缺失 API 移植记录（2026-08-08）

### 23.1 背景
以 `reference/OpenBachelorS-master`（EN 版 FastAPI 私服）为参考，补齐 DoctorateTs 缺失/拼错的 API。对比工具：`scripts/_diff-routes.py`（挂载感知路由 diff，140 条 OBS 路由未覆盖 → 122 条，P1 全部覆盖）。

### 23.2 修正（P0，api.md 契约）
- `/gacha/cancleNormalGacha` → `/gacha/cancelNormalGacha`（拼写）
- `/mail/listMailbox` → `/mail/listMailBox`（大小写；Express 匹配大小写不敏感，行为等价）

### 23.3 新增端点（P1，参考 OBS bp 蓝图）
quest: battleContinue / finishStoryStage（委托 BattleManager.finishStoryStage）/ editStageSixStarTag
gacha: choosePoolUp（gachaRuleType 反查池类型，写 `gacha[type][poolId].upChar`）/ getFreeChar（空操作）
charBuild: changeSkinSpState（`skin.skinSp[skinId]`）
social: setStarFriendList（空实现）
mailCollection: getList（新 router，挂 `/mailCollection`，读 `DisplayMetaTable.mailArchiveData`）
medal: setCustomData（`medal.custom.customs["1"]`）
gallery: saveDiyMagazineV2（与 V1 共用 saveDiyMagazine 逻辑）
retro: typeAct20side/competitionStart + competitionFinish（固定 stub）
home: firework savePlateSlots/changeAnimal、car confirmBattleCar、templateTrap setTrapSquad、troop pinSpecialOperator
auth: `/u8/user/auth/v1/agreement_version` POST 别名（响应同 GET）

完整清单见 `api.md`「OBS 移植端点」附录。

### 23.4 冒烟验证结论
- 新端点：mailCollection/getList、quest/battleContinue、car/confirmBattleCar、retro/vecbreak 双前缀均 200
- **双前缀修正（2026-08-09）**：原记录「/retro/*、/campaignV2/* 双前缀为既有设计」经全量客户端路由核对确认为 bug——客户端调用单前缀（`/campaignV2/battleStart`、`/retro/unlockRetroBlock`），双前缀命中不到；已补根挂载使单前缀可用（双前缀仍兼容，见下节）。
- **已知问题（非本次引入）**：`POST /gacha/cancelNormalGacha` 对 uid=1 满级号返回 500（recruit.cancel 内部异常，路由命中正常），待单独排查
- **P2 部分完成（2026-08-08，参考 DoctoratePy/CS 2.7.61/抓包）**：bossRush（尖灭测试）模块已实现——`/activity/bossRush/battleStart|battleFinish|relicSelect|relicUpgrade`（battleStart/battleFinish 复用标准战斗结算 + 尖灭专属 wave/milestone/token/best 更新，掉落加值数据驱动），并修正 `/activity/rewardMilestone` 对 BOSS_RUSH 活动写入 `milestone.got`（对齐官服快照结构）。
- **P2 补全（2026-08-08 续）**：enemyDuel（怪猎对决 8 路由，排行榜 NPC 填充）、act24side（怪猎 6 路由，合成抽奖数据驱动）、act25side（生息演算 6 路由）、football、act29side、act36side、trainingGround、aprilFool act3fun/act4fun/act6fun/act7fun 补全，以及 act13side/act1vhalfidle/act27side/act35side/act38side/act42d0/act42side/act44side/act45side/act46side/actBlessOnly/actCheckinAccess/loginOnly/prayOnly/year5General/teamQuest/typeAct3d0/typeAct4d0/typeAct5d0/typeAct5d1/typeAct9d0/typeAct20side/arcade/autochessSeason 约 110 条 stub（参考 ODPY 202 stub）。
- **路由前缀修正（2026-08-08）**：客户端将 roguelike/interlock/vecBreakV2 挂在 `/activity` 前缀下（`/activity/roguelike/*` 等），但既有 router 自带 `/roguelike|/interlock|/vecBreakV2` 路径 —— 在 app.ts 补 `/activity` 挂载别名；act25side/act29side/act36side/trainingGround/actcheckinvs 为根路径路由，新增 activity 模块 `rootRouter`（同 user.ts 模式）挂载到 `/`，修复合签到 `actCheckinvs/sign`（客户端 `/actcheckinvs/sign` 根路径调不到）的隐藏缺口。
- **全量客户端路由覆盖（2026-08-09，541 条客户端游戏路由逐一 curl 冒烟，404 清零）**：
  - campaignV2/retro 的 router 自带模块前缀 + 既有 `/campaignV2|/retro` 挂载产生双前缀，客户端调用单前缀 —— 补根挂载（双前缀仍兼容）
  - `/crisis/getInfo` 客户端路径别名（既有 `/getCrisisInfo` 客户端调不到）；`/crisisV2/*` 用 URL 重写中间件别名到 `/crisis/v2/*`
  - `/sandboxPerm/sandboxV2|V3/*` + `/sandboxPerm/changeTopic|pinTopic` URL 重写别名到 sandbox router 的 `/v2|/v3|/changeTopic|/pinTopic`；补 6 条 racing stub
  - `/activity/multiplayerV3/*` 补 /activity 挂载别名；`/rune/battleStart|battleFinish` 新 router（复用标准战斗）；`/vecBreakV2/getSeasonRecord` 根挂载
  - rlv2 补 31 条缺失路由（buyGoods 接线控制器已实现方法 + bank/copper/gridZone/nodeMission 等 rogue_3/4/5 stub）；quest 补 getCowLevelReward/getMainlineRecordRewards/getMainlineCache/unlockStageFog/unlockHideStage；mission 补 confirmMissionList/confirmMultiGroupMissionList
  - 杂项：shop/buyREPGoodWithTicket、social/getFriendAndRequestSendList、tower/seasonMissonsAward（客户端拼写）、gacha 裸 `/gacha`、autoChess/act1|act2autochess、audit/official/*（新 router）
- **rlv2/selectChoice 接线修复（2026-08-08）**：控制器已实现（§16.5）但路由未暴露，已补 `POST /rlv2/selectChoice`（CS: RoguelikeSelectChoiceRequest，抓包 body `{choice}`）
- **pay 补全（2026-08-08，参考 DoctoratePy + 抓包）**：新增 `/pay/createOrder`（返回对齐抓包形状的 extension JSON）与 `/pay/confirmOrder`（现金包 CS_ 复用 shop.buyCashGood 发放钻石，含首充双倍）；订单存内存 Map，重启即失效（私服可接受）
- **arkodc 模块（2026-08-09，参考 OBS misc_bp + CS ArkOdc 类 + ODPY arkodc 类）**：`/arkodc/battleStart|battleFinish`（战斗 stub）、`/arkodc/savePosition`（写 `arkodc.topics[topicId].position`）、`/arkodc/triggerInteraction`（awardId 标记 `rewards[awardId]=1`）、`/arkodc/restart` —— 根路径挂载
- **稀有度索引修复（2026-08-09，实机冒烟发现的真实 bug）**：`CharacterTable.rarity` 为字符串枚举 `"TIER_N"`，但 char/recruit 多处按数值下标/比较使用（`maxLevel[rarity]`、`evolveGoldCost[rarity]`、`data.rarity === 5`、`charsList[rarity]` 字符串键 vs 数值键）→ upgradeChar/evolveChar 500、公共招募星级分组/高星 tag 失效、rlv2 招募免费稀有度升级失效。新增 `@utils/rarity`（`rarityToIndex` TIER_N→N-1）并全量修复 char.ts/recruit.ts/rlv2 recruit.ts；upgradeChar/evolveChar 补 maxLevel/evolveCost 防御钳制。验证：实机 upgradeChar（char 2 正常升级）、evolveChar（含 null evolveCost 的预备干员）均 200。
- **ODPY 缺失清单逐条核对（2026-08-09，`scripts/_audit-odpy-gaps.py`）**：ODPY 663 条路由中 DoctorateTs 未覆盖 260 条，逐条 curl 冒烟标注——**已覆盖 174**（HTTP 200/202/500 路由命中，含 sandboxPerm 72 条、crisisV2 7 条、campaignV2/retro 5+5、rlv2 28、aprilFool 11 等）+ **设计跳过 68**（单账号 auth 19、yostar 4、支付变体 9、admin 5、遥测/埋点 8、config/remote_config 变体 8、GET 覆盖 5、ODPY 独有 3 等）+ **需补充 16 全部分类为已覆盖**（remote_config 4 条为 GET 覆盖、shop `<string:shop_type>` 模板 3 条由具体路由覆盖、静态资源 gallery/jpg + announce/images + assetbundle 302 等路径参数路由为设计跳过/静态资源）
- **既存未决项处理（2026-08-09）**：
  - `gacha/cancelNormalGacha` 满级号 500 已修复——根因是客户端请求未初始化的招募槽位（满级号仅 4 槽但客户端发 slotId 4/5），recruit.cancel 补缺失槽位初始化守卫（不再 500）
  - `gallery/jpg`、`announce/images` 静态图片路由已补齐——私服无素材文件，返回 1x1 透明 PNG 占位图（客户端不再收 HTML 404）
  - **syncData 对齐决策（用户确认）**：保持现状（Immer 单点 patch + 刷新 pushFlags，客户端实测可用）；移除 delta.ts 未接线的 `buildSyncDataDelta`/`SYNC_DATA_DELTA_KEYS` 死代码与 account.ts 未使用 import
  - **目标完成边界（用户确认）**：参考项目全量对齐（ODPY 663 条全量覆盖，含此前标注的设计跳过项）
- **参考项目全量对齐（2026-08-09，用户确认边界后实施）**：ODPY 260 条缺失清单 → **已覆盖 256 / 设计跳过 2（/arknights 子域名转发、/api/game/<subpath> catch-all 已补）/ 需补充 0**；OBS 105 条缺失运行时复核 **0 个 404**；DoctoratePy 36 条缺失全部补齐（pay alipay/wechat/success、/login、shop/buyFurniGroup、quest/changeSquadName2 别名、旧版 auth 路径 11 条 URL 重写别名）。新增 `router/misc-alignment`（遥测/pay 变体/api 端点/yostar/common EN stub 约 30 条）、launcher catch-all、building/getMessageBoardContent、config prod b/network_config、remote_config bilibili/101 变体。

- **基建系统修复（2026-08-09，审计发现 7 项问题后修复 5 项核心）**：
  - 制造站生产随时间累积：`sync()` 新增 `_accrueManufacture`（房间 capacity × 流逝时间 → processPoint，每满 formula.costPoint 产 1 批，remainSolutionCnt 递减/outputSolutionCnt 递增）；`changeManufactureSolution` 改为从 0 开始累积（remainSolutionCnt=目标，outputSolutionCnt=0）而非立即满产——生产速度 buff 与时间挂钩
  - 贸易站订单补充：`sync()` 新增 `_refreshTradingOrders`（工作时间 stock < 2 单时按 3003×汇率生成金币订单，结构与官服样本一致）——原实现无生成逻辑，交付完即枯竭
  - 余额校验：制造结算/加工合成按可承担次数部分结算，避免负库存/负金币
  - `deliveryOrder` 按客户端指定 instId 结算（原忽略 orderId 总结算队首）
  - 非法 roomSlotId 守卫：settleManufacture 等不再 500
  - 训练室 `_accrueTraining`：trainee.processPoint 随时间累积（进度显示一致；完成仍由客户端 completeUpgradeSpecialization 驱动）
  - 单测 5 条 + 实机冒烟（settle slot_999 200、清空 stock 后 sync 补 2 单、8 秒产出 processPoint=486 与 54×9s 吻合）


- **抽卡系统修复（2026-08-09，用户报告 tenAdvancedGacha 500）**：
  - 缺详情卡池回退：`gachaPoolClient` 有但 `gacha_detail_table.details` 缺失的 5 个池（LIMITED_76_0_1/SINGLE_75_0_3/DOUBLE_75_0_4/CLASSIC_DOUBLE_75_0_1/CLASSIC_DOUBLE_76_0_1）抽卡不再 500——`_poolDetail` 回退到首个结构完整池（去 UP 走通用池）+ WARN 记录；`gachaPoolClient.find()!` 补守卫（池完全缺失回退 NORMAL）；`_getRarityRank` 空 perAvailList 防御
  - **char:get 订阅 bind 丢弃 bug（重大）**：`char.ts` 原 `this._trigger.on("char:get", () => { this.onCharGet.bind(this); })` 把 bind 结果丢弃，`onCharGet` 从未执行——**抽卡/招募的干员从未真正入账**（charGet 响应只有 logInfo、无 charInstId/charId/itemGet）。改为异步闭包调用后，抽卡完整返回 char 数据（潜能/兑换物正确发放）；onCharGet 签名兼容事件可选参数
  - 单测 2 条 + 实机验证：正常池与缺详情池十连均返回完整干员数据

  - ruleType 缺失处理（续）：gachaPoolClient 中 DOUBLE(37)/CLASSIC_DOUBLE(31)/BACKFLOW(1)/SPECIAL(7) 共 76 个池的 ruleType 不在 funcs 映射 → funcs[ruleType] is not a function 500；补齐四类走通用 _handleGacha + 调用处防御回退 NORMAL。实测四类池抽卡均 200 且新干员入账

- **getGoodPurchaseState 响应形状修复（2026-08-09，用户报告 41KB 响应异常）**：CS 协议（GetGoodPurchaseStateResponse { result: Dictionary<string, int> }）与抓包均要求扁平 `{goodId: 1|-1}`（1=可购买/-1=已购买），原实现直接返回各商店原始 info 数组（41KB 且形状不符，客户端无法解析限购状态）。已按客户端 goodIdMap 重写：常规商店读 `.info`、GP 嵌套结构展平；响应从 41KB 降到 306 字节。单测 2 条。

- **charRotation/setCurrent 500 修复（2026-08-09，用户报告）**：满配号生成器重排 charInstId，预设 preset.profileInst（138/1）指向不存在的干员 → `draft.troop.chars[profileInst].charId` 崩溃。已加守卫：未知预设直接返回；profileInst 查不到时回退到 profile 字符串（"char_xxx#皮肤" → charId）。实测 preset 1 → secretary=char_1012_skadi2、未知预设 200。单测 2 条。

- **招募结算响应缺 result 修复（2026-08-09，用户报告 finishNormalGacha 客户端提示异常）**：CS FinishNormalGachaResponse/CancelNormalGachaResponse 均要求 `result: Int32`，原实现缺失 → 客户端解析异常。已补 `result: 0` 并更新协议类型为必填；实机验证 finishNormalGacha/cancelNormalGacha 均返回 result: 0。单测 1 条更新。

- **shop/decomposePotentialItem 500 修复（2026-08-09，用户报告）**：`potentialMaterialConverter.items` 按数值键（0~5）索引，而 `CharacterTable.rarity` 为字符串枚举 "TIER_N"——`items["TIER_5"]` undefined → `item.id` 500。用 `rarityToIndex` 修复 troop.ts 两个分解方法（decomposePotentialItem/decomposeClassicPotentialItem）+ 不存在的干员/无配置防御。单测 3 条（含字符串 rarity 场景）。

- **storyreview/readStory 500 修复（2026-08-09，用户报告）**：原实现把完整 storyId 当 group key 查（`groups["act6d5_level_act6d5_st02"]` undefined）→ `.stories` 崩溃；正确 group 应为 storyId 前缀（如 act6d5）。新增 `_groupKeyOf`：组 key 直接匹配 → 最长前缀匹配（兼容多下划线组名）→ DoctoratePy 首段+min→mini 兜底；unlockStoryByCoin/readStory/rewardGroup 全补守卫与去重。实测 readStory rc 正确递增、未知 group 200。单测更新 3 条。

- **ODPY 参考更新复核（2026-08-09）**：用户更新 opendoctoratepy-ex-public（663→668 条路由），重跑全量运行时扫描——**668 条全部覆盖，0 个 404**（新增 5 条路由均已被现有实现命中）。审计工具 `_audit-odpy-gaps.py` 复跑：已覆盖 261 / 设计跳过 2 / 需补充 0。

- **arkodc 对齐 ODPY 更新（2026-08-09）**：用户更新 opendoctoratepy-ex-public（663→668，新增 5 条均为 arkodc API），参考实现含完整逻辑（依赖 arkvent_table）。已对齐：
  - excel.ts 接入 `ArkventTable`（data/excel/arkvent_table.json，原未加载）
  - triggerInteraction 完整实现：宝箱（awardId → rewards 标记 + odcDataMap.rewardGroups 物品 + q 后缀触发关联 actor varSeqs）、任务（avgId → actorData.actorShowCondition varSeqs 推进 + 黑名单/intro/trademan 特例）
  - battleFinish：解密战斗数据判定完成（q001_logic_after_bat_p1 非中断/放弃，其余 completeState 2/3）→ actorData varSeqs 推进
  - battleStart 记录 topic（模块级）供 battleFinish 消费；restart 重置 varSeqs + position 并下发 deleted 列表
  - 实机：battleStart/triggerInteraction/restart 均 200，restart 正确返回 deleted varSeqs 列表

- **arkhub（方舟枢纽）游戏路由实现（2026-08-09，用户报告 /activity/arkhub/syncInfo 404）**：客户端 7 条路由（enterHall/getFriendUidList/getPixelArt/savePixelArt/setSecretary/setSquad/syncInfo）原未实现。按抓包实现：enterHall 返回 gateway 端点+端口、setSecretary/setSquad 更新 activity.ARK_HUB[act1arkhub]、syncInfo 空增量、getPixelArt/savePixelArt 私服空（像素画走 admin 的 arkhub-gateway-client 与官服网关通信）。全部 200 且 setSecretary 正确持久化。

- **templateShop 商店打不开修复（2026-08-09，用户报告奇象巡展/arkodc 商店）**：getGoodList 原返回空 data（商店无法打开）。已复制 ODPY 数据源 `data/shop/templateShop.json`（33 家商店含 sandbox_1/2、shop_act53side（ODC / 安洁莉娜的旅行小记 店）），getGoodList 返回完整商店配置（32KB，含 shopGroup 商品）；buyGood 实现购买（扣货币→发物品→限购记录），修复 tshop 初始化崩溃。实机：getGoodList 完整返回、buyGood 无货币返回空列表不 500。

- **ODPY 9-10 更新同步（2026-09-11，用户更新 opendoctoratepy-ex-public 后要求同步实现）**：以 `server/app.py` 的 `add_url_rule` 提取 **679 条** 路由为基线（另有 2 条 reslock 注册因 **拼写错误 `add_url_rile`/`add_url_reul` 从未生效**），对本地起服后逐条 POST/GET 冒烟（`tmp/odpy-sync/sweep.mjs`）。
  - **保险库（reslock，全新）**：客户端 4 条端点（CS `ServiceCode.ITEM_REPO_LOCK/UNLOCK_INVENTORY|CONSUMABLE`）本地全缺。新增 `app/game/modules/reslock/`（routes.ts 薄壳 + reslock.ts 领域 + schema），按 `PlayerReslock{inventory,consumable}` 存取、`item_table.canReslock` 资格校验、计数归零摘除条目、消耗品实例 ts 保留；16 条单测。**参考实现不可用**：ODPY `server/reslock.py` 第 24 行 `dict.get(...) += count` 是 Python 语法错误（import 即失败）+ 路由拼写错误 + 仅覆盖 consumable 两条，故按客户端协议重写。
  - **rlv2 新增 5 条路由**：`/rlv2/setSeed`（自定义种子：18 位/字符集校验 → CS `ResultCode`，`_pendingSeed` 由 `gameSeed()` 一次性消费；顺带修复开新局未清 `_gameSeed` 导致每局结算种子相同的缺陷）、`/rlv2/normal/unlockBuff`（接线既有 `unlockBuff` 领域逻辑——此前科技树节点**点不动**）、`/rlv2/battlePass/buyReward`（扣 `bp.point` + 发里程碑奖励 + 幂等，支持 `grand_N` 归一）、`/rlv2/copper/change`、`/rlv2/copper/confirmDraw`（对齐 ODPY 状态机语义）；11 条单测。
  - **藏品 buff 下发补全**：`event.ts`（事件触发战斗）、`grid-nav.ts`（二结局首领战）、`incident.ts`（黑流树海遭遇战）三处 `unKeepBuff` 原固定 `[]` → 改 `_buff.getBuffs()`，并对齐 ODPY `getBuffs` 增加 trap/exploreTool 的 relics 登记 buff 并入；`inventory.ts` 的 `EXPLORE_TOOL` 原为空操作 → 入 `inventory.exploreTool`（键 `e_N`），修复工具既不入库也不生效。
  - **杂项对齐**：`/app/getCode|getSettings`（ODPY 为 POST）、`GET /user/agreement|pay/order/v1/state|user/pay/v1/query_payment_config`、寻访记录/卫戍战绩 webview 占位页；`/user/auth`、`GET /user/info/v1/basic` 经核实由 auth 域处理（无 token 返回 404 属正确行为，非缺口）。
  - **鉴权健壮性**：`/u8/user/v1/getToken`、`/u8/user/verifyAccount` 的 `JSON.parse(req.body.extension)` 在空 body 下抛 SyntaxError → 500；`/user/auth/v1/token_by_phone_password` 空凭据透传给 AccountManager 落到注册分支 → 500。均改为显式 400（core 层内联响应，不引入 game 依赖）。
  - **最终扫描**：679 条 **0 个 500**；7 条 404 全部为已逐条核实的误报/设计跳过（`/arknights/<path>` 官服资源反代、`/assetbundle/...` 假 hash 命中的处理器 404、`/shop/<string:shop_type>Good*` 三条 Flask 模板由具体路由覆盖、`/user/auth` 与 `GET /user/info/v1/basic` 的“无 token 404”）。

- **官方 excel 数据转换回退修复（2026-09-11，随 9-10 同步发现）**：当前 `data/excel/*.json`（converterVersion 2，01:52Z 转换）相比 09:20 备份出现**静默失效**的形态回退，逐一定位并修复：
  - **KV 表定义缺失（根因）**：`cs2schema.ts` 只重生成 `clz_*` 表，`dict__K__V`（FBO 键值对表）依赖历史 vendored 定义 → 新出现的组合（`dict__string__enum`、`dict__enum__clz_X`、`dict__string__vec:clz_X` 等 10 个 / 7 张表）缺表，`vendor/fbo.ts` 的「纯 KV 表折叠为 dict」判定失效 → 解成「空对象数组」，字段整体失效（实测：roguelike `scrapItemToType`、campaign `dropGains`、display_meta `avatarTypeData`、battle_equip `tokenAttributeBlackboard`）。已加 `collectMissingKvTables()` 按 `Key@4/Value@6` 约定补齐缺失表定义（`schema:check` 现在报告这 7 张表的差异，0 slot 位移），并清理 `reference/hotupdate/excel_json` 的旧解码缓存后重转。**注意**：`official-excel.ts` 的解码缓存（`excel_json/<表>.json`）不随 schema 失效，schema 变更后须手动删除对应缓存。
  - **集成战略主题键/展示枚举归一化**：新数据 `customizeData` 以客户端键 `rl01..rl06` 存放（`details/modules/topics` 为 `rogue_1..6`）、`buffDisplayInfo[].displayForm` 为未转枚举的数值 0/1 → 科技树解锁一律 `NODE_NOT_FOUND`、`buildRoguelikeConsts` 以 rlNN 建表导致 outbuff/modebuff 全不生效。新增 `app/game/excel/roguelike-keys.ts#normalizeRoguelikeTopicTable`（幂等），在 `excel.init()` 与 `buildRoguelikeConsts` 前各调用一次（配对依据：rl01 的 difficulty 1..6 对应 rogue_1 的 EASY..CHALLENGE，同序号一一对应）。
  - **零件类型枚举**：`modules.<theme>.scrap.scrapItemToType.<id>` 值为 `RoguelikeScrapType`（1=MOVE/2=GOODS/3=PASSIVE），因取值重号被唯一值兜底弃转 → 数值形态下 `=== "MOVE"` 判定失效（林间代步/先行一步归来选零件）。已加 `PATH_ENUM_OVERRIDES` 条目（路径 4 段：`<theme>.scrap.scrapitemtotype.<id>`）。
  - 修后全量测试：9 文件 14 用例失败 → **2 文件 3 用例**（均为既有/版本快照问题：`account-authmode` 依赖仓库中不存在的 `player_data.json` 种子、`pack-lua-min-current` 的 Windows `KNOWN_LUA_HASH_PREFIXES` 仍是 26-08 版本 hash，需联网扫描重认）。


- **抽卡 charGet 响应修复（2026-08-09，用户报告）**：
  - curCharInstId 从不递增 bug：onCharGet 新干员用 `draft.troop.curCharInstId` 作为 instId 但从不 +1 → 后续新干员 instId 冲突互相覆盖。已在新干员创建后递增
  - potent 字段缺失：CS GachaResult.potent（潜能提升信息），未满潜重复干员应返回 `{delta, now}`。已实现（potentialRank < maxPotentialLevel 时返回）
  - 单测 2 条

- **building/setPrivateDormOwner 破坏存档修复（2026-08-09，用户报告）**：CS 字段名为 `charInsId`（大 S），原实现读 `charInstId` → undefined 被 JSON 序列化为 null → `owners:[null]` 写入存档。已改读 `charInsId ?? charInstId` 并加 null/非法 slotId 防御；实测 charInsId 正确写入数字。单测 1 条。
- **进程自动退出防护（2026-08-09，用户报告程序可能自动结束）**：Node 24 未处理 Promise 拒绝默认终止进程——`rlv2.checkZoneEnd` 的 `void this.gameSettle()` 在无进行中游戏（game 为 null）时崩溃。已加 `.catch()` 记录；index.ts 增加全局 `unhandledRejection`/`uncaughtException` 处理器（记录错误栈 + 保持进程存活）。

- **存档健康检查与自动修复（2026-08-09）**：新增 `app/game/kernel/save-health.ts`——加载/保存时自动检测并修复常见损坏：必填顶层结构缺失（重建）、troop.chars 非法干员（移除）、`building.rooms.PRIVATE[].owners` 含 null 条目（setPrivateDormOwner 字段名 bug 残留，过滤）、status.uid 类型（转字符串）。幂等、保守（不做破坏性重建）；修复结果 WARN 记录。实机：2222 存档 slot_47.owners [null] 加载时自动修复并落盘。单测 6 条。

- **P4 跳过**：YoStar/EN 专属（yostar/get-auth、user/login、user/quick-login、user/detail、/common/* 等）——CN hypergryph 客户端不调用（全量对齐后已补 stub，路径可达）

## 24. 状态管理技术约定（2026-08-11 增补）

### 24.1 共享引用与 Immer 克隆（A2）

部分管理器持有 `_playerdata` 子对象的**直接引用**（非 Immer draft），并在 `update()` recipe 之外原地修改：

| 模块 | 持有引用 | 持久化机制 | 保护措施 |
|------|----------|------------|----------|
| `RoguelikeV2Controller` | `this.outer/current/pinned` | 原地写 + 全量落盘捕获 | `update()` wrapper 末尾统一刷新三个引用（Immer finishDraft 克隆被写子树后引用会指向旧对象） |
| `MedalProgress` | `this.val`（与 `_playerdata.medal.medals[id].val` 共享数组引用） | 共享引用原地写 | 构造器回填缺 val 旧数据 + `_syncToPersist()` 显式写回（自愈断链）+ `markDirty` 回调 |

**约定**：`finishDraft` 会对 recipe 中**被修改的子树**做克隆——任何「在 recipe 外持子对象引用并原地写」的代码，在该子树被 recipe 克隆后都会写到孤儿对象。因此：
- 引用刷新/显式写回必须在克隆点之后（rlv2 在 wrapper 末尾、medal 在进度更新事件里）；
- 绕过 `update()` 的直接变更**必须**调 `player.markDirty()`（条件落盘只保存有变更的请求）；
- 新增此类模式时优先走 `update()`，或严格按上表补齐刷新/写回。

### 24.2 账号数据存储演进方向（B2，YAGNI 暂缓）

现状：玩家账号为 JSON 全量落盘（`data/user/databases/{uid}.json`，满配号 ~5.4MB，已紧凑化 + 条件落盘降频）；账号配置/社交/回放/结算信息已 SQLite 化（social.db：users/friends/visited/replays/battle_infos 表）。

**方向（未实施）**：玩家账号主体 SQLite 化或增量补丁日志，替代全量 JSON dump。当前 JSON 全量 dump 在条件落盘 + 紧凑化后成本已大幅下降，单账号私服场景足够；多账号/频繁落盘场景再迁移。

### 24.3 待评估（C-2/D-4，需客户端验证或专项）

- **C-2 运行时散文件 SQLite 化**：`data/` 根下 `mails.json`/`building.json`/`battleReplays.json`/`user.json` 等仍是 JSON 文件存储（非玩家账号主体，属各管理器独立状态）——社交/回放/结算已入 social.db，其余可逐步收编，按需迁移。（`rlv2.json` 已于 2026-08 改为官方 excel 派生，不再作为独立文件。）
- **D-4 业务校验错误响应**：游戏路由统一 JSON 500（gameErrorHandler）——业务校验失败（如社交自请求）也走 500。若客户端只处理业务码（result/status 字段）不处理 HTTP 500，需实测确认；确认前不改为 200 + 业务码。

### 24.4 性能优化记录（2026-08-11）

- **A-1 logger 批量落盘**：文件日志从"每行 appendFileSync"改为 200ms 批量合并（`logBuffer` + 定时 flush + 进程退出同步 flush 兜底），`logger.flush()` 可显式落盘。事件循环不再被每条日志的同步磁盘写阻塞。
- **B-1 excel 懒加载**：`handbook_info/charword/enemy_database/enemy_handbook×2/handbook_team/skill_table` 7 张启动期不触碰的大表（合计 ~30MB JSON）改为首次访问时同步 parse（getter 透明，访问模式不变）；启动解析时间与常驻内存下降，首请求摊付单表 parse（~100ms）。
- **D-1 空闲账号卸载**：real 模式 30 分钟无请求的账号先落盘后从内存卸载（`data[uid]` 删除），下次请求自动重载；singleUid 与 fresh 账号保留。单例模式不启用（单账号卸载会抖动）。
- **A-2 savePlayerData 序列化**：实测 `JSON.stringify` 5.4MB 对象 ~9ms，已防抖离请求路径 + 紧凑输出（1.7MB）——`savePlayerData` 增加耗时 debug 日志；worker_threads 序列化收益低（9ms 可接受）暂缓（YAGNI）。
- **D-2 excel 内存**：82MB 源 JSON 全量解析后驻留内存较大；懒加载已缓解内容表，核心表（character/stage/item/skill）仍常驻——多账号/大内存压力场景再评估分表卸载。

## 25. ODC（安洁莉娜的旅行小记）修复记录（2026-08-16）

### 25.1 无限新手教程（bool_end_guide_done 缺失）

**症状**：ODC 地图每次进入都重放新手教程（`ark_odc_act53side_guide`）。

**根因**（对比官服完成态快照 `tmp/capture/records/R-1786248128589.9783-0050`）：
- 教程触发 actor `logic_game_end_p1` 的 `actorShowCondition` = `q003_prog==4 && bool_end_guide_done==0 && q003_banner_showed==1`，`actorTriggerType=AUTO_ONCE` → `PlayArkodcTutorial(ark_odc_act53side_guide)`。
- 客户端提交教程剧情走 `/story/finishStory`（storyId `activities/act53side/ark_odc_act53side_guide`，story_table trigger=CUSTOM_OPERATION），原实现只写 `status.flags`，**从未把主题 varSeq `bool_end_guide_done` 置 1** → 条件恒真 → 每次进图重放教程。官服完成态含 `varSeqs.bool_end_guide_done=1`。

**修复**：
- `home.ts /story/finishStory`：提交 ODC 教程剧情后同步 `arkodc.topics[topicId].varSeqs.bool_end_guide_done=1`（helper `finishArkOdcGuideStory` 在 `arkodc.ts`，topicId 从 excel `TYPE_ACT53SIDE[].constData.arkOdcTopicId` 动态取）。
- `unlockActivity.ts` 播种时回填：`status.flags[该教程剧情]` 已置 1 但 varSeq 缺失的旧存档补置（修复前漏洞账号无需重新提交即自愈；未提交过教程的账号保持待触发状态）。
- 单测：unlockActivity 回填 ×2 + arkodc helper ×2；实机验证 2222 回填生效、2223 提交后 flag+varSeq 同步。

### 25.2 人物模型不显示排查结论

- ODC 地图 actor 显示由 `arkventDataMap[topicId].taskData.actorData[].actorShowCondition`（VARSEQ EQ 语义，缺失键=0）驱动；空 varSeqs（新账号播种）→ 初始 5 名 NPC（阿米娅/九色鹿/博士家/博士宿舍/森蚺）应显示，完成态 → 5 名 q003 角色（aosta/broca/firwhl/chiave/ray，均为默认皮肤）应显示——与官服行为一致，无服务端数据缺陷。
- **方舟枢纽广场玩家模型缺失（实锤根因，2026-08-16 二次排查）**：对比官服网关真实抓包（`tmp/capture/records/2026-08-09T04-29-12-534Z/parsed.json`），官服 EnterSceneNotify 的 `PlayerSyncData.PlayerBrief` 含 `4:level、5:avatarId、6:charId、7:skinId`，本地应答器原实现只发 uid/nickname/nicknumber → 客户端**无法渲染广场玩家模型**（"不显示人物模型"）。另缺 `AvatarInfo`（f2）与 `GuideFlags`（f3，area_*_block/guard、arkhub_login 等 hub 区域/引导状态）→ 区域引导状态缺失。
- **修复**（`app/game/modules/activities/arkhub/session/server.ts` + `index.ts`）：PlayerBrief 补 level/avatarId/charId/skinId（char/skin 取 `status.secretary`/`secretarySkinId`，即主界面秘书干员——与官服网关一致）；补 AvatarInfo；GuideFlags 一次性标记 hub 区域/引导全部完成（私服不模拟逐步解锁）；`enterHall` 回报实际监听端口（端口被占自动避让，仿转发器）。
- 用户实机日志佐证：`logs/server-20260816.log` 16:19:36 客户端登录本地网关 + 场景 hello 后无后续动作（卡在枢纽场景）。

### 25.2b 枢纽引导对话重复（GuideFlags 编码 bug，2026-08-16 第三轮）

**症状**：进入枢纽广场每次重复播放引导对话（`arkhub_main_terminal_auto`，ENTER 触发，条件 `terminal_guide==0 && arkhub_login==0`）。

**根因**：枢纽是独立 Arkvent 主题（`arkventDataMap.act1arkhub`），其 varSeq 状态（`terminal_guide`/`arkhub_login`/`capture_catch_guide_01/02`/`area_1_block` 等）**不由 playerdata 下发，而由网关 EnterSceneNotify 的 GuideFlags（f3）提供**（官服 27 份 playerdata 快照的 `arkodc.topics` 均无 `act1arkhub`）。本地网关原实现不下发 GuideFlags；第一轮修复（25.2）补发时**把 14 条 flag 全部包进同一个 field-1 载荷**（`fb(1, concat(entries))`），而正确形状是 **14 个重复的 field-1 条目**——客户端只解析到 1 条 → `terminal_guide/arkhub_login` 仍缺失 → 每次进图重放引导。

**修复**：GuideFlags 改为 `...entries.map(e => fb(1, e))`（重复字段），实测探测（`tmp/probe-gateway.mjs` 直连网关解码）14 条 flag 全部下发，且 `arkhub_login=1`、`terminal_guide=1` 使引导条件不再成立。PlayerBrief charId/skinId 经同一探测确认已生效（`char_1012_skadi2#1`）。回归测试 +1（GuideFlags 重复条目逐条断言）。

### 25.2c 枢纽第二步引导对话挂起（GuideFlags 取值 1 vs 2，2026-08-16 第四轮）

**症状**：入口引导不再重复，但进入广场后卡在**另一段对话**。

**根因**：GuideFlags 是**进度计数**而非纯布尔——官服完成态 `capture_catch_guide_01/02`、`arkdex_battle_guide` 取值 **2**（0=未开始 / 1=第二步引导播放中 / 2=完成）。上一轮全部取 1 反而**激活**了条件 `==1` 的 AUTO actor：
- `arkhub_capture1_mmkabi_01b [AUTO]`（cond `capture_catch_guide_02==1`）→ `ReceiveArkhubReward{reward_guide_01}`
- `arkhub_main_bryota_01c [AUTO]`（cond `arkdex_battle_guide==1`）→ `SubmitArkhubAVG`

枢纽的奖励/AVG 提交走网关帧，本地网关对未知帧只回空 ACK → 客户端收不到真实响应 → **对话挂起**（日志无 HTTP 错误，与实机现象吻合）。

**修复**：GuideFlags 取值改为官服完成态快照（进度类=2，布尔类=1）。修复后 14 条 flag 与官服逐一相等，`==1` 的 AUTO 引导不再触发，广场仅剩可交互 NPC。回归测试断言逐条取值；实机探测确认下发值与官服完成态完全一致。枢纽奖励/AVG 网关帧（ReceiveArkhubReward/SubmitArkhubAVG）的完整实现留待需要时补（当前"全部完成态"方案无需）。

## 26. 奇象巡展全链路审计与修复（2026-08-16，官服数据对照）

### 26.1 官服完成态快照比对

以 `tmp/capture/records/R-1786248128589.9783-0050`（官服完成账号全量 playerdata）为基准，与本服 2222/2223 逐项对照：

| 维度 | 官服完成态 | 本服现状 | 结论 |
|---|---|---|---|
| activity.TYPE_ACT53SIDE | actCoin=33, favorList 4 人 | actCoin 随掉落累计（修复前恒 0），favorList 一致 | **actCoin 缺跟踪（已修）** |
| activity.ARK_HUB | coin=1200, secretary, 4×squads | 形状一致 | ✓ |
| arkodc.topics.ark_odc_act53side | 34 varSeq + 10 rewards | 一致（修复后含 bool_end_guide_done） | ✓ |
| dungeon.stages act53side | 01-09/st01-03/sp01-02/ex01-08(+#f#) | 一致（33 关） | ✓ |
| status.flags act53side/arkhub | 19 条 | 19 条完全一致 | ✓ |
| ACTIVITY 任务 | 53sideActivity_1..39 + 1arkhubActivity_1..22 | 62 条已播种（state 2 可领） | ✓ 可领取 |

### 26.2 修复的三处功能缺口（全链路实测）

1. **actCoin 不累计（inventory.ts）**：官服 actCoin 随活动币（`constData.coinItemId` = act53side_token_photo）获取累计——关卡掉落活动币时同步 `activity.TYPE_ACT53SIDE[actId].actCoin`。原实现只入背包、事件页硬币计数恒 0。新增 `_trackAct53SideCoin`（items:get 监听内，coinItemId→actId 惰性映射）。实测 actCoin 0→3。
2. **关卡链首通断裂（battle.ts finish）**：解锁链前置 `playerStage.state == 1`——state=1 仅在失败（completeState==1）后置位，**首通（state 0→3）跳过解锁链** → 活动关卡链断裂（act53side_01 首通后 tr01 不解锁）。改为任意胜利（completeState 2/3）执行（幂等，已存在关卡不覆盖）。实测 act53side_02 首通解锁 act53side_03。
3. **battleFinish 响应缺 result（battle.ts finish）**：官服/CS 响应含 `result`，原返回缺失 → 客户端解析异常风险。补 `result: 0`（含练习分支）。

### 26.3 审计确认无缺口的链路

- 活动任务：confirmActivityMission 走 ActivityTable.missionData 兜底，53sideActivity_* 可正常领取（实测发放 randomMaterial_act53side 等）
- 商店：/templateShop getGoodList（参数 **shopId**，非 shopType）+ buyGood（扣活动币发物品 + 限购记录 + 开店自动补足购全店额度），shop_act53side 4 组商品实测可购
- ODC 任务链：/arkodc/triggerInteraction avgId 分支推进 varSeq（q001_prog 0→1 实测）
- 剧情：/story/finishStory + /quest/finishStoryStage（未播种关卡补条目修复于 §25.3）
- 战斗：act53side 关卡 battleStart/battleFinish 完整结算（掉落 act53side_token_photo/材料/金币 + 首通奖励）
- 单测：actCoin ×2、battle 首通解锁 + result ×1（共 1702 全绿）

### 26.4 新号注册修复（SQLite 感知，2026-08-16 第二轮）

**症状**：admin 创建新账号 → `reloadUser` ENOENT（`data/user/databases/{uid}.json` 不存在）——方案 A+C 下存档主体在 SQLite player_data 表（gzip BLOB），注册成功但玩家数据加载失败。

**根因**：`AdminService.reloadUser/backup/exportUser` 直读 JSON 文件，库内账号无文件。

**修复**：
- `AccountManager` 新增 `readPlayerData(uid)`（内存已加载优先，否则 SQLite/文件回退）与 `reloadPlayer(uid)`（先落盘卸载再从库重载）
- `AdminService.reloadUser/backup/exportUser` 改走 `readPlayerData`/`reloadPlayer`
- 实测：新账号 2227/2228 注册成功、播种完整

### 26.5 arkodc `topics["undefined"]` 残留（2026-08-16 第二轮）

**症状**：新账号 `arkodc.topics` 出现 `"undefined"` 主题（position null）——早期会话对 uid=1 调 `/arkodc/restart` 缺 topicId 时 `ensureArkOdcTopic(undefined)` 写入，SQLite 模板继承给所有新账号。

**修复（三层）**：
1. 路由防呆：`savePosition/triggerInteraction/restart` 校验 topicId 缺失/空串 → 返回业务错误，不再写脏数据
2. save-health 自愈：`arkodc.topics` 移除 `"undefined"`/空串键、position null 重置原点（幂等）
3. 实测：新账号 2228 仅含 `ark_odc_act53side`；存量账号重启加载时自动剥离

### 26.6 枢纽网关帧协议分析（ARKDUEL，留待完整实现）

官服网关抓包（2026-08-09）解码：枢纽战斗走 TCP 网关帧，body = `[4B seq][protobuf]`：
- 战斗开始：请求 sub=0xb7c267d7（f1 为 JSON：`{"squad":{...},"assistFriend":null}`）→ 响应 sub=0xb7c20f13（含奖励 id `act1arkhub_14` + 嵌套干员数据）
- 战斗结算：请求 sub=0xb7c204e8（f1=`uid:ts` battleId）→ 响应 sub=0xb7c2b07e（`{f1:100, f2:battleId}`）
- 结果帧：0xb7c26451 / 0xb7c2d119（干员状态/奖励明细）
- 其它：位置同步 0x38b32a34→0x38b36462、0x31d603b3→0x31d60cf6（32 字节 hex token 帧）
当前本地网关对未知帧回空 ACK（subID+1）——广场可正常进入/移动/交互，ARKDUEL 等深层玩法需按上述协议补齐（响应 subID 非 req+1，各类型映射不同；实现需更多抓包样本验证奖励/结算语义）。

### 26.7 枢纽切场景（传送门）+ 网关完整日志（2026-08-16 第三轮）

**症状**：无法传送至其他地图——枢纽传送门（ArkhubEnterScene → act1arkhub_capture_scene_1/2/3 捕抓区）走网关帧，本地网关不识别切场景请求 → 空 ACK → 客户端不加载新场景。

**协议（官服抓包解码）**：
- 切场景请求：`subID low32 = 0x38b3b60b`（高 32 位为会话/场景前缀，随场景变化），body = `{1:2, 2:<目标 map_id 有符号 varint>}`——**f2 即目标场景 map_id**（实测 CAPTURE1=-820616879）
- 响应序列：先 ACK `0x38b3a5a8 {1:9}`，再发新场景 `EnterSceneNotify 0x38b37d3d`（HallInfo.map_id = 目标）
- 场景 map_id（activity.sceneTypeMap）：TOWN=-1520665757，CAPTURE 1/2/3=-820616879/-820813487/-820747951

**修复**（`app/game/modules/activities/arkhub/session/server.ts`）：
- `buildEnterScene` 参数化 map_id；切场景请求按 low32 匹配、解析 f2 目标 map_id → 回 ACK + 新场景 EnterSceneNotify（TOWN/CAPTURE 双向均可）；场景状态按连接维护
- **完整帧日志**：全部收发帧记录 `[arkhub-gateway]`（方向/mainID/subID/长度/hex 预览）；心跳与位置同步为高频噪音 → DEBUG，其余（登录/场景/交互/战斗）→ INFO
- 回归测试：单连接全流程（登录→TOWN 场景→切场景→ACK+CAPTURE 场景），断言 TOWN/CAPTURE map_id varint 与官服一致

### 26.8 枢纽设施锁定（扫描仪/道具箱/数据库/交换站/画像册，2026-08-16 第四轮）

**症状**：捕抓区/广场的菜单设施（扫描仪=ARKDEX_CREATURE、道具箱=ARKDEX_ITEM、数据库=ARKDEX_ALBUM、交换站=ARKDEX_TRADE、画像册=ARKPIXEL，`activity.ARK_HUB.menuData`，`isPermanent:false`）全部锁定不可用。

**根因**：设施解锁不由 playerdata（官服全量快照无任何 func/arkdex 字段）也不由场景单位（EnterSceneNotify f5 仅为玩家位置条目）携带，而是**客户端本地执行场景操作** `UnlockArkhubFunc{funcId:7}`（唯一来源：`pixel_unlock [AUTO]`，条件 `capture_catch_guide_02==1 && pixel_unlock_system==0`）。本地网关此前下发 `capture_catch_guide_02=2`（完成态）→ 该 AUTO 永不触发 → 客户端永不执行解锁 → 设施锁定。官服账号经引导链自然执行过该操作故已解锁。

**修复**：GuideFlags 的 `capture_catch_guide_02` 改为 **1**（引导第二步进行态）→ `pixel_unlock [AUTO]` 触发 → 客户端执行 `UnlockArkhubFunc{funcId:7}` 解锁设施。代价：`arkhub_capture1_mmkabi_01b [AUTO]`（捕抓引导第二步 AVG+领奖，无 Submit 阻塞）会在进入捕抓区时播放一次；`arkdex_battle_guide` 保持 2（bryota_01c 的 SubmitArkhubAVG 会挂起，不触发）。若 mmkabi 领奖帧空 ACK 仍卡，需补 Reward 帧协议（当前抓包无样本）。

**备注**：设施解锁为客户端本地状态（可能经 ArkOdcLocalCache 持久）——升级后若仍锁定，先清客户端缓存再进。

### 26.9 传送出生点 + 引导对话完成 + 日志可读化（2026-08-16 第五轮）

1. **传送后出生点错误**：原 EnterSceneNotify 所有场景统一用广场坐标 (4.38, 0.0065, 8.2)。官服抓包验证各场景出生点（PlayerHallBrief.pos）：TOWN=(4.742,-0.008,6.079)、CAPTURE1=(1.945,0.513,-6.85)。新增 `spawnPointFor(mapId)`（CAPTURE 1/2/3 用捕抓区坐标，缺样本沿用 CAPTURE1），切场景后按目标场景出生。
2. **引导对话无法完成**：`capture_catch_guide_02=1` 后 mmkabi_01b 引导的 `ReceiveArkhubReward` 帧此前收空 ACK → 对话挂起。未知帧兜底改为回 **`{f1:100}` 业务成功码**（登录响应同款语义），奖励/交互帧可视为成功继续流程（`reward_guide_01`=arkdex_1_gold×50，见 activity.ARK_HUB rewardDataDict）。若仍卡需按日志抓实际领奖帧补精确响应。
3. **日志可读化**：帧日志加语义名（登录/场景hello/场景数据/切场景/ARKDUEL*/位置同步/交互帧等）+ protobuf 轻解析字段摘要（`f1=2 f2=-820616879`），未知帧回退 hex 预览；心跳/位置同步仍 DEBUG。

## 27. 小号首次进入枢纽的官服抓包分析（2026-08-16，source=official 实时抓包）

官服实时抓包（`tmp/capture/records/R-1786876928580-0077` ~ `R-1786877206214-0089`，小号首次进入枢纽全流程）对齐实现：

### 27.1 领取枢纽任务（confirmMultiGroupMissionList）

- **请求形状**：客户端传 **`missionIds`**（任务 ID 列表）而非 missionGroupIds——原实现只读 missionGroupIds → 批量领取空转。路由两个字段都处理。
- **confirmMission 兜底**：活动任务（ActivityTable.missionData，如 1arkhubActivity_*/53sideActivity_*）不在 MissionTable——原实现静默跳过。新增 `_confirmActivityTableMission`：发 missionData.rewards、置 state=3。
- **枢纽币同步（官服形状）**：领取奖励含 act1arkhub_token_seal 的任务后，同步累加 `activity.ARK_HUB.act1arkhub.coin` 与 `tshop.shop_act1arkhub.coin`（抓包：领 5 个任务 → token_seal ×500、ARK_HUB.coin=500）。activity.ts confirmActivityMission 同步同款。

### 27.2 syncInfo 返回枢纽进度

原实现空增量。官服返回 `{mission.missions.ACTIVITY(1arkhubActivity_* 进度), medal.medals(枢纽勋章), activity.ARK_HUB(状态)}`——用 forcePatch 强制推送（纯读请求无 Immer 补丁）。

### 27.3 模板商店对齐官服（templateShop）

- **getGoodList**：响应补 `allPriceDict`（[{startTime, maxPrice=购全店总额}]）；补足货币改写活动币（ARK_HUB.coin / actCoin）与 `tshop.{shopId}.coin`（原写库存物品，客户端商店币不读）。
- **buyGood**：改用官方 `playerdata.tshop.{shopId}.{coin, info:[{id,count}], progressInfo}`（原写自创 (draft).templateShop 字段客户端不读）；扣币走活动币引用（shop_act1arkhub→ARK_HUB.coin、shop_act53side→actCoin）+ tshop.coin；购买记录写 info；CHAR_SKIN 经 items:get 入 skin。
- **数据补全**：templateShop.json 缺 `shop_act1arkhub`（枢纽兑换处，23 商品）——已从官服抓包 R-1786877194008-0087 提取补入（34 家店）。

### 27.4 实机验证（2228 干净账号，全链路）

领任务（token_seal + ARK_HUB.coin=200）→ syncInfo（任务进度+勋章+状态）→ getGoodList（allPriceDict+补足 coin=1780）→ buyGood act1arkhub_1（skin 发放 + ARK_HUB.coin 1780→1280 + tshop.info 记录）→ 复查一致。单测：templateShop 全量重写（7 条）+ 新购/限购/枢纽店扣币断言。

## 28. 枢纽网关 TCP 帧协议补全（2026-08-16，官服抓包字节级对齐）

解码官服网关完整会话（2026-08-09，328 up / 1221 down 帧）的全部请求→响应帧对，在本地网关实现：

| 请求 subID | 语义 | 响应 subID | 响应结构（官服字节对齐） |
|---|---|---|---|
| 0x28f5ba6f | ARKDUEL 商店（道具价格表） | 0x28f5229c | `[seq] {1:100, 3:{1:ts, 2:[{1:序号,2:itemNumId,3:价格,4:库存}×7]}}`；道具 5004 标准诱引剂40/5005 专业60/5006 稀有250/5009 甜味60/5010 辣味60/5015 专业信息素60/5021 苦味60 |
| 0x31d603b3 | 令牌刷新（诱引剂/宠物实体） | 0x31d60cf6 | `[seq] {1:100, 2:{1:实体id, 2:<新32位hex令牌>, 3:ts}}`——签发随机新令牌 |
| 0xb7c267d7 | ARKDUEL 战斗开始（[4B seq]+squad JSON） | 0xb7c20f13 | `{1:[{2:19005,3:flag}×5], 2:"act1arkhub_14", 3:1}`（敌方单位+战斗标识，无 seq） |
| 0xb7c204e8 | ARKDUEL 战斗结算（battleId） | 0xb7c2b07e | `[seq=战斗开始seq] {1:100, 2:<battleId回显>}` |
| （服务端推送） | 战斗结果 | 0xb7c26451 / 0xb7c2d119 | `[seq] {1:{1:1,2:ts,3:单位×5}}` / `{1:[单位×5], 3:{1:19005,2:890,3:10}}` |

- 响应 subID 前缀复用请求前缀（切场景 ACK 固定 0x2c89b3 除外）
- 未知帧仍回 `{f1:100}`（0x38b3ab0c/0x38b39680/0x38b3c3c9 交互帧官服无响应，为 fire-and-forget）
- 单测 +4（商店/令牌/战斗开始/结算+结果推送，TCP 实连字节断言）；实机探测与官服响应结构逐字段一致

### 28.1 交互提交（0x38b3116d：{1:actorId, 2:operationId("get_reward")}）

**协议来源**：2026-08-14 用户网关抓包（`arkhub_main_daily_task_02a` + `get_reward`）+ 实机日志（`arkhub_capture1_mmkabi_01b`）。

**实现**：网关识别交互提交帧，按 actor 从奖励映射（activity.ARK_HUB.rewardDataDict）返回奖励（mmkabi_01b→reward_guide_01=arkdex_1_gold×50、daily_task_02a→reward_daily_task_01=×100），响应 `[seq]{1:100, 2:[奖励物品]}`（无官服样本，按战斗结算模式构造）。**mmkabi 捕抓引导领奖后 capture_catch_guide_02 1→2**（GuideFlags 改为按连接维护，下一次场景 hello 生效）——引导链完成、不再重放，设施解锁的 pixel_unlock 已在本会话触发。

**日志修复**：
- 心跳回显（main=2 sub=0）与位置同步降为 DEBUG（原误记为 INFO → "大量未知帧"刷屏）
- 帧名补全：场景hello（low32 0de29cdb）/交互提交/交互响应；字符串字段完整显示（actorId/operationId 可见）
- 单测 +1（交互提交：奖励响应 + 引导 02 推进断言）；实机探测：交互提交返回奖励、二次场景 hello 携带 02=2

### 28.2 交互提交响应无官服样本 → 回退完成态（2026-08-16 第六轮）

**症状**：mmkabi_01b 引导对话无法结束——客户端对 `0x38b3116d {1:actorId, 2:"get_reward"}` **每 9 秒超时重试**（seq 递增），响应（0x38b3116e 奖励载荷）未被认可。

**排查**：官服无该帧响应样本（08-14 抓包会话在响应前断开；08-09 会话未做引导领奖）；客户端 C# 无网关帧逻辑（Lua 热更）。响应 subID（0x38b3 家族非 +1 映射）与 body 均无法从现有数据确定。

**决策**：`capture_catch_guide_02` **回退完成态 2**——mmkabi_01b [AUTO]（条件 02==1）不再触发 → 重试循环与卡对话消失。设施解锁（pixel_unlock → UnlockArkhubFunc）已在 02=1 会话执行、客户端本地缓存保留（若重锁需清一次客户端缓存）。交互提交处理器保留（日常任务/其它 NPC 领奖仍可用）。位置 ACK（0x38b32a35）降 DEBUG。单测更新 02=2 期望，1710 全绿。

### 25.3 会话日志暴露的其它缺陷（顺带修复）

- **`/quest/finishStoryStage` 500（battle.ts 原 164 行）**：`draft.dungeon.stages[stageId].state` 对未播种关卡读 undefined 崩溃（08-15 日志 5 次）——现先补默认条目再置 state=3，并继续联动解锁。
- **delta.ts `structuredClone` 兜底**：08-16 12:36 出现 "null could not be cloned" 500（`player.delta` 构建时克隆补丁值）——`cloneData` 加 try/catch，structuredClone 失败回退 JSON 深拷贝。
- **`unlockActivity`/`activityDictKey` 防御性 `?.`**：excel ActivityTable 缺失时不再抛错（测试 mock 场景）。

### 25.4 ODC 教程 varSeq 校正（2026-08-16 复核）

复核官服 27 份含 `ark_odc_act53side` 主题的抓包：**完成态 varSeqs 为 34 键**（不含 `bool_end_guide_done`/`tre_*_got`），仅 1 份 40 键含之——`bool_end_guide_done` 是玩家实际完成末尾教程后由官服写入的**增量标记**，非必含字段；缺失时 `logic_game_end_p1`（q003_prog==4 && bool_end_guide_done==0 && q003_banner_showed==1，AUTO_ONCE → PlayArkodcTutorial）每次进图重放教程。25.1 的 finishStory 同步 + 播种回填仍为正确修复方向（与 40 键官服快照一致）。


## 29. 奇象巡展 Phase 1：勋章/任务/结算真实化（2026-08-17）

基于 PRTS 攻略差距分析（`docs/奇象巡展-差距分析.md`），Phase 1 实现 P0 缺口（不改数据文件、不破坏官方 playerdata 形状）：

### 29.1 事件层（app/game/kernel/events/）
新增 11 个事件，事件名 = ActivityTable.missionData.template / medal_table.template：
- 任务 8 类：`ArkhubMissionCompleted / ArkhubDailyMissionCompleted / ArkhubCreatureCollection / ArkhubCreatureCaptured / ArkhubCreatureExchange / ArkhubPassDexBattle / ArkhubPublishPixelArt / ArkhubCollectPixelArt`
- 勋章 3 类：`ActivityArkhubPixelCollect / ActivityArkhubCreatureCollect / ActivityArkhubAlterCollect`
参数与各模板 param 语义对齐（param[0]=参数类型位、param[1]=activityId）。

### 29.2 任务进度真实化（app/game/manager/mission.ts + unlockActivity.ts）
- **MissionProgress.init ACTIVITY 分支**：原实现直接 return（无监听器、进度全假）。现从 `ActivityTable.missionData` 按 id 查 template/param，走与 DAILY/WEEKLY 相同的模板注册机制（事件驱动真实进度）。
- **MissionTemplates 增加 8 类 Arkhub 模板**：引导=flag 匹配 +1；每日=窗口门控（param[2..3] 日期区间，**getTime() 毫秒需 /1000 对齐 userTimestamp() 秒**）取 max；收集/对战/发布/收集画像=按 collectionKey 过滤取 max；信息素扫描/交换=每次 +1。
- **播种（unlockActivity）**：8 类模板按 param 解析真实 target（value:0/target:N）；引导任务（ArkhubMissionCompleted）因本服引导为完成态播种即完成（state:2 + value==target，保持可领体验）；param 日期起点在未来的任务（8/18 更新后每日 7/8）播种 state:0 锁定；非 arkhub 模板保持原"全可领"行为；已播种条目不覆盖（存量存档不动）。
- **reloadActivity()**：MissionManager.init 先于播种执行（播种任务无实例），播种后重建 ACTIVITY 任务监听器。
- **syncInfo（activity.ts）**：去掉强制 `progress=[{1,1}]`，仅防御性保证 progress 为数组。

### 29.3 勋章三模板（app/game/manager/medal.ts）
- `ActivityArkhubPixelCollect`（unlockParam=[act1arkhub,0,4] → target=param[2]）
- `ActivityArkhubCreatureCollect`（[act1arkhub,arkhubMissionCollection1,10] → target=param[2]）
- `ActivityArkhubAlterCollect`（[act1arkhub,arkhubMissionCollection1,10,1] → 镀层双条件：alterCount>=param[3] 才积累 count，10+1 达标）
- **播种**：unlockActivity 把 `ungroupedMedalIds`（01/02，不含 025 镀层）写入 `medal.medals`（val=[[0,target]], fts:0, rts:-1）。MedalManager.init 先于播种 → 本会话内存 map 不含新勋章，进度监听自下次加载生效。

### 29.4 玩法事件入口（app/game/manager/activity/arkhub.ts，新增）
统一承载 ARK_HUB 计数更新 + 事件发射（幂等可重复调用）：
- `arkhubOnDuelSettle`：duelCount +1 → 发 15 券（token_seal + ARK_HUB.coin/tshop.coin 同步，对齐 §27.1）→ emit ArkhubPassDexBattle。**胜负字段未确认，暂按胜利发 15 券**（官方：胜 15/负 7 + 概率道具）。
- `arkhubOnDailySupply`：每日限 1 次（自然日标记 dailySupplyLastDay）→ dailySupplyDays +1 → 发 100 券 → emit ArkhubDailyMissionCompleted。
- `arkhubCreatureCollected / Captured / Exchange / PixelPublished / PixelCollected`：落状态 + 发任务/勋章事件（Phase 2/3 玩法接入点）。
- ARK_HUB 私有扩展字段（官服快照无、客户端不读）：`duelCount / dailySupplyDays / creatureCollected / activeCreatureCollected / alterCollected / pixelCollected / pixelPublished`。

### 29.5 网关回调（arkhub-gateway-local.ts + index.ts）
- 新增选项 `onDuelSettle(uid)` / `onDailySupplyClaimed(uid)`：战斗结算帧与 daily_task 交互领奖后触发。
- index.ts 私服模式注入 → `arkhubOnDuelSettle / arkhubOnDailySupply`（accountManager.data[uid] 空守卫）。

### 29.6 生物数据表（data/arkhub/creatures.json + excel.ts）
- 字段形状逆向自官方反编译 `reference/.../Torappu/ArkdexCreatureData.cs`（creatureNumId/enemyId/rarity/specialRarity/alterNumId/upWeightTagIsShow/advantageType/abilities/六维 hp·atk·def·mag·moveSpeed·atkSpeed 等）。
- **实际数值本地缺失**（ArknightsGameData 仓库不含该活动），当前为空表占位 + schema 注释，Phase 2 ARKDEX 前需官服网关抓包/客户端 AssetBundle 解包补全。

### 29.7 测试与验证
- `tests/unit/manager/activity-arkhub.test.ts` 16 条：播种（真实 target/引导完成/8/18 锁定/勋章播种/存量不覆盖）、8 类任务模板（含 collectionKey 过滤、窗口门控、双事件）、3 枚勋章模板（含镀层双条件）、玩法事件入口（结算发券/每日限次/收录事件）。
- 修复要点：日期解析 ms/秒单位对齐（getTime()/1000）；MissionProgress ACTIVITY 分支需同时赋值 mission（否则后续 `if (mission)` 判空置 invalid）；EventBus 监听器收到的是参数元组 `[obj]` 需解构。
- tsc --noEmit 干净；全量 vitest 1729 通过。traffic-recorder/capture-manager/pack-mod 在并行全量跑偶发失败（共享 tmp/capture/index.db 跨运行累积 + 并行污染，单跑/清库即过，存量问题与本次无关）。

### 29.8 遗留（Phase 2/3）
- ARKDUEL 胜负字段（0xb7c204e8 结算帧）未确认 → 暂按胜发 15 券。
- ARKDEX 生物数据值未落地；寻迹/道具/保护区/交换站、像素持久化、勋章 025 入档均待 Phase 2/3。

## 30. 奇象巡展 Phase 2：ARKDEX 寻迹状态层（2026-08-17）

### 30.1 ARK_HUB 状态扩展（unlockActivity.ts defaultArkhubState）
新增 Phase 2 私服扩展字段（官服快照无、客户端不读）：
- `dex`：生物数据库 `{ [creatureNumId]: { numId, isAlter, alterOf?, active? } }`——首次/亚种收录，`active` 标记"活动频繁"（任务 12-14）
- `scanBag`：扫描仪个体列表（上限 400）`[{ id, numId, isAlter, alterOf?, fav, sourceUid }]` + `scanSeq` 自增
- `props`：巡展道具箱 `{ [itemNumId]: { count, uses } }`（count=持有、uses=剩余生效次数）
- `propSoldToday`：道具每日售出记录（跨日重置，`{ date, sold: { [itemNumId]: n } }`）
- `trade`：交换站需求 `{ wantSpecies, offerNumIds }`（同时 1 条）
- `unlockedAreas`：保护区解锁 `{ [areaId]: 1 }`（守门人拟合胜利解锁）

### 30.2 ARKDEX 玩法模块（app/game/manager/activity/arkdex.ts，新增）
- **巡展道具表** `ARKDEX_PROPS`：7 种（5004 标准诱引剂40 / 5005 专业60 / 5006 稀有250 库存2 / 5009 甜味60 / 5010 辣味60 / 5015 专业信息素60 / 5021 苦味信息素60，价格与库存逆向自 ARKDUEL 商店价格表 §28），类型 lure/pheromone。
- **属性克制**：`ARKDEX_ADVANTAGE_TYPES`（奇术/本能/百变）、`ARKDEX_ADVANTAGE_COUNTER`（奇术→本能→百变→奇术）、`arkdexDamageScale`（克 1.3 / 被克 0.7 / 同级 1.0）——攻略明文 + `ArkdexAdvantageTypeData.damageScaleMap`/`advantageCounterMap` 结构确认。
- **六维换算** `arkdexSixStatsToCombat`：进攻×20≈攻击、守备×2≈防御、耐久×100≈HP、法抗×0.5、攻速=间隔倒数×10、移速基准 1.1（攻略明文）。
- **玩法函数**（全部幂等、可单测）：
  - `arkhubScanSucceed`：扫描成功 → 发 15 券（token_seal+coin/tshop 同步）→ dex 收录（亚种/活动频繁标记）→ scanBag 入袋（400 上限）→ `arkhubDexRecount` 重算计数并发射 `ArkhubCreatureCollection`/勋章事件；空列表 = 扫描失败无奖励。
  - `arkhubBuyProp`：扣 coin → 道具箱 +生效次数；每日库存限购（`propSoldToday` 跨日重置）；券/库存不足返回 false。
  - `arkhubUseProp`：消耗 1 次生效次数（离开会场不清除）。
  - `arkhubPheromoneScan`：信息素扫描 → `ArkhubCreatureCaptured`（任务 15；私服单机简化：调用即视为完成一次）。
  - `arkhubSetTrade` / `arkhubDoTrade`：交换需求设置（1 条/可清除）+ `ArkhubCreatureExchange`（任务 16）。
  - `arkhubUnlockArea`：保护区解锁标记。

### 30.3 测试
`tests/unit/manager/activity-arkdex.test.ts` 12 条全绿（克制/换算/扫描成功失败/内存上限/购买限购与跨日重置/使用次数/交换/保护区/道具表完整性）。连同 Phase 1，全量 vitest 1742 通过（traffic-recorder 2 条为共享 tmp/capture 累积的存量失败）。

### 30.4 遗留：需要官服抓包的帧协议（Phase 2 主体）
ARKDEX 状态层不依赖生物数值，但**客户端实际游玩**仍缺以下帧协议（本地无官服样本，不能硬写假 subID——§26.8 教训）：
1. **生物数据模块帧**：官服网关下发的 `ArkdexModuleData`（creatureData/advantageTypeData/npcInfoData/npcDuelStrategyData/itemEffectData/traitData 等）——客户端据此渲染图鉴/配置界面，**无此数据 ARKDEX/ARKDUEL 配置界面为空**。
2. **遭遇/捕获帧**：栖息地遭遇生物（可能走位置同步/场景实体交互）、扫描开始/结束。
3. **道具购买帧**：ARKDUEL 商店价格表已回（0x28f5ba6f），购买请求帧 subID 未知（服务器函数 `arkhubBuyProp` 已就绪）。
4. **交换站帧**：需求设置/请求/确认。
5. **守门人 NPC 对决**：`npcDuelStrategyData`（生物列表+权重）依赖生物数据。

**抓包指引**：`pnpm run start:capture` 启动官服转发 → 官服账号进捕抓区，依次执行：走草丛遭遇生物→扫描→使用诱引剂/信息素→开拟合配置界面→NPC 对决→交换站操作；抓包落 `tmp/capture/records/{rid}/`（gateway-bidi），`pnpm exec tsx scripts/parse-arkhub-gateway.ts [rid]` 解析，重点观察 down 流"连续 protobuf/自定义封装"变体（§17.5 提到的未解变体，疑似即模块数据帧）。抓到后按 §28 模式补帧即可完成 Phase 2。

## 31. 奇象巡展 Phase 3：巡展像素（ARKPIXEL）持久化（2026-08-17）

### 31.1 官服链路（抓包 R-1786876787370-0074 / R-1786680304215-0147）
- **savePixelArt**（multipart/form-data）：json part `{"brief":{"activityId":"act1arkhub","token":"<32hex>"}}` + pixelData part（1728B RGB）→ 响应 `{"pixelArtId":<10位数字>}`（pixelArtId 由**服务端**分配；token 关联自网关令牌帧 0x31d603b3 的实体 id）
- **getPixelArt**（JSON `{activityId, pixelArtIds:[...]}`）→ `{"pixelArts":{<id>:{"url":"<OSS .dat 链接>","isBanned":false}}}`
- 像素格式：24×24×3 RGB 1728B，空白 (255,255,255) 透明，调色板 40 色（§17.5 备注）

### 31.2 私服实现
- **存储层**（`app/game/manager/activity/arkpixel.ts`，新增）：
  - `savePixel(uid, data)`：validatePixelData（长度）+ **调色板白名单校验**（官方语义"invalid pixel color"）→ 分配全局唯一 10 位 pixelArtId → 落盘 `data/arkhub/pixels/<id>.bin` + `index.json`（uid/ts/md5/banned）
  - `loadPixelBytes` / `pixelMeta` / `buildPixelArtResp`（url = `<config.Host>/activity/arkhub/pixel/<id>.dat`）
  - `computeNewCollects(uid, ids, collectedIds)`：收集去重（非本人发布且未收集）
  - `parseMultipartForm`：极简 multipart 解析（json + pixelData 两 part）
  - `setPixelsDirForTest`：测试注入临时目录
- **路由**（activity.ts）：
  - `POST /activity/arkhub/savePixelArt`：优先取 capture 模式 rawBody，否则路由内收集原始流（express.json 不解析 multipart）→ 解析 brief/pixelData → **发布上限 50 次**（攻略）→ 落盘 → `arkhubPixelPublished` 计数（任务 20-21）
  - `GET /activity/arkhub/pixel/:id.dat`：像素下载端点（getPixelArt 返回的 url）
  - `POST /activity/arkhub/getPixelArt`：返回本服 url 列表；拉取他人画像 → `computeNewCollects` 去重 → `pixelCollectedIds` 记录 + `arkhubPixelCollected` 计数（任务 22-23、勋章 01）
- **计数**：发布/收集复用 arkhub.ts 的 `arkhubPixelPublished/arkhubPixelCollected`（写 ARK_HUB 私有字段 + 事件驱动任务/勋章模板）

### 31.3 测试
`tests/unit/manager/activity-arkpixel.test.ts` 8 条全绿（保存/读取/url/收集去重/multipart 解析/调色板校验/40 色板）。连同 Phase 1/2，全量 vitest 1748 通过（traffic-recorder 3 条为共享 tmp/capture 累积的存量失败，单跑即过）。

### 31.4 遗留
- 画像"审核"流程：官服 savePixelArt 响应无审核字段（isBanned 仅封禁标记），私服保存即公开，未模拟审核（可加 isBanned 管理端开关）。
- 图纸分享专题网页/摊位（4 人）为网页功能，私服不适用。
- 草稿保存为客户端本地行为，不经过服务端（savePixelArt 即发布）。

## 32. 奇象巡展数据实锤：arkdexModule 全表在服务器 excel 里（2026-08-17 复核）

### 32.1 结论（修正 §30.4 的"需官服抓包"判断）
用户指出"这些应该都遇到过啊"——复核确认：**完整 ARKDEX 数据一直在 `data/excel/activity_table.json` 里**，
只是此前只检索了 basicInfo/活动名，未检查 `activity.arkHub.act1arkhub.moduleData.arkdexModule` 深层：
- `creatureData`：**37 种生物**（19001-19037+，含 名称/珍奇度 rarity 1-3★/specialRarity 闪框/属性 advantageType/六维 hp·atk·def·mag·moveSpeed·atkSpeed/能力 abilities/获取途径/亚种关联 alterNumId/**活动频繁 upWeightTagIsShow**/enemyId·trapId·worldEntityId）
- `advantageTypeData` + `advantageCounterMap`：3 属性（arkdex_advantage_A 奇术 / B 本能 / C 百变），damageScaleMap **克 1.3 / 被克 0.7**（与 Phase 2 实现一致）
- `modeData`：10 种对决模式（singleRound 快速 2人1轮 / BO3 常规 2人3轮 / 4Player 多人 4人1轮，Solo/Match/Room 变体）
- `itemEffectData`：**16 种道具**（5004/5005/5006 珍奇度诱引剂、5007-5011 味道诱引剂、5014-5016 珍奇度信息素、5017-5021 味道信息素）
- `traitData`：9 特质（traitMask 位标记 + buff 黑板）
- `npcInfoData`：10 NPC（1 苍苔 = 守门人/对决专员）、`npcDuelStrategyData`：13 策略组（真实敌队，如 strategy_group_intro = 19005×2+19003）、`npcBattleParamData`：10
- `captureAreaData`：12 捕获区、`npcPixelData`：4、`sceneTypeMap`：4、`dexConstData`：25 常量（bag 400 / teamSize 3 / maxTeamRarityCount 7 / operatorTeamSize 4）

### 32.2 落地
- **导出** `data/arkhub/arkdex.json`（完整模块数据 + 来源标注）；`excel.ArkhubCreatureTable` 懒加载改读此文件（原空表 creatures.json 删除）
- **arkdex.ts 升级**：道具表扩至 16 种（价格 §28 确认 7 种 + 同类推断 9 种标注）；新增
  `arkdexCreature(s)/arkdexCreatures()`、`arkdexAdvantageName()`（属性 id→中文名）、
  `arkdexDamageScaleById()`（读 damageScaleMap 真实倍率）、`arkdexModeRules()`（模式规则）、
  `arkdexEnemySquad()`（策略组敌队）、`arkdexConst()`（常量）
- **解码怪癖**：npcDuelStrategyData 每条被 FlatBuffers→JSON 包装为 `{ groupId: {真数据}, 伪键: null }`，
  arkdexEnemySquad 需先取嵌套同名键（类似 missionData 伪键防御）
- 测试 +5（生物/克制 id/模式规则/敌队/常量），连同既有 41 条全绿

### 32.3 意义与剩余
- 服务器侧已有全部生物数据 → 扫描遭遇可随机真实生物、ARKDUEL 敌队可用策略组真实数据、数据库收录可校验种类
- 客户端 ArkdexModuleData 由客户端热更资源自行持有（同版本客户端），服务器无需下发
- 剩余未确认：网关捕获/购买/交换帧 subID（客户端行为帧）；ARKDUEL 敌方响应 f3 状态位语义（保持官服字节对齐现状）

## 33. capture 模式无法进广场修复：enterHall 本地化（2026-08-18）

### 33.1 症状与根因
- 症状：capture 模式（转发官服）下客户端无法进入 arkhub 广场；转发器日志显示
  `up.bin 105B（登录帧）→ down.bin 0B`，连接 15 秒后断开（latencyMs ~15000）。
- 排查链路（2026-08-18 17:12-17:16 抓包）：
  1. HTTP 转发层完全正常：/account/login 200（官服账号 230847132/100566259）、syncInfo 200——
     **客户端用的是官服账号与官服 secret**；
  2. enterHall 响应改写正常：`{"result":0,"endpoint":"127.0.0.1","port":30001}`；
  3. 客户端 TCP 连上转发器并发出 105B 登录帧（与 08-09 成功会话**字节级一致**，仅 secret 不同）；
  4. **官服网关 0 字节响应**——实测直连 `arkhub-gateway.hypergryph.com:30000` 发送 08-09 完整
     成功 up 流（11211B）同样 0 响应 → **官服网关 2026-08-18 起不再响应登录帧**
     （TCP 可连、握手成功，但无任何下行字节——官方侧变化，非私服代码 bug）。

### 33.2 修复：capture 模式 enterHall 本地化 + 本地网关应答器
- `official-forward.ts`：`/activity/arkhub/enterHall` 加入 `LOCAL_ONLY_PREFIXES`——
  capture 模式下 enterHall 不再转发官服（官服网关无响应，转发必然失败），走本地 activity.ts 路由；
  其余 `/activity/arkhub/*`（syncInfo/setSecretary 等）仍转发官服抓真实响应。
- `index.ts` capture 分支：同时启动**本地网关应答器**（startArkhubLocalGateway，与私服分支同款
  resolvePlayerProfile 回调）——enterHall 本地路由按 `isArkhubLocalGatewayActive()` 返回
  `config.Host + 本地网关实际端口`（转发器占 gatewayPort 时本地网关自动避让 +1），客户端经
  本地网关进广场。转发器（startArkhubGatewayProxy）保留——官服网关恢复后，把 enterHall 从
  LOCAL_ONLY 移除并重启即可切回真实网关抓包。
- 测试：official-forward.test.ts 两个 enterHall 用例改为断言"不转发、走 next"（syncInfo 仍转发），
  45 条 proxy 测试全绿。

### 33.3 注意
- capture 模式客户端为官服账号：本地网关 `resolvePlayerProfile` 对不在本地存档的官服 uid 回退
  默认值（昵称"博士<uid>"、无秘书干员）——仅广场模型外观差异，不影响进入。
- 网关登录帧带官服 secret 也能进本地网关（本地网关任意凭据 code=100）。
- 全量 vitest 1776 通过（tsc 干净）。

### 33.4 根因修正：官服网关切到 canary 灰度域名（2026-08-18 18:00 复核）
§33.1/33.2 的"官服网关 0 响应"结论**根因是域名切换而非网关维护**：
- 直接请求官服 gs `POST /activity/arkhub/enterHall`（用客户端真实官服凭据）→ 响应
  `{"result":0,"endpoint":"arkhub-gateway-canary.hypergryph.com","port":30000}`——
  **官服把 arkhub 网关切到 canary 灰度子域名**（端口仍 30000）；
- 实测 `arkhub-gateway-canary.hypergryph.com:30000` 对今天的登录帧**响应 205B**（老域名 0 响应）；
- 端到端验证：转发器 → canary 透传登录帧收到响应 ✓。

**方案修订（替代 §33.2 的 enterHall 本地化）**：
- `app/game/modules/activities/arkhub/capture/proxy.ts`：转发目标**动态化**——`updateGatewayTarget(host, port)` + `getGatewayTarget()`，
  初始缺省 `arkhub-gateway-canary.hypergryph.com:30000`（`OFFICIAL_ARKHUB_GATEWAY_CANARY_HOST`），
  handleConnection 每连接实时读取目标；
- `official-forward.ts`：enterHall 响应处理时**先 updateGatewayTarget 跟随官服 endpoint**（域名再变
  也自动跟随），再改写为代理地址；LOCAL_ONLY_PREFIXES 移除 enterHall（恢复转发官服）；
- `index.ts`：capture 分支移除 §33.2 的本地网关启动（恢复纯转发，真实网关流量可抓）。
- 测试：official-forward 2 个 enterHall 用例恢复"转发+改写+更新目标"断言；proxy 38 条全绿；
  全量 vitest 通过。

## 34. 奇象巡展活动细节补全（2026-08-18）

### 34.1 数据复核结论
- `pnpm run update` 实测：官方最新热更 26-08-17（8/18 无新增 excel）——本地数据即最新。
- `upWeightTagIsShow`（活动频繁）37 种生物全 false——该标记由**官服网关服务端下发**（ArkdexModuleData
  creatureData），本地 excel 仅默认值；任务 12-14（arkhubMissionCollection2）按 `dex[].active` 计数。
- syncInfo 官服真实响应（18:06 canary 抓包）= `{"playerDataDelta":{"modified":{},"deleted":{}}}`——与本地一致。
- 完整细节文档：`docs/奇象巡展-活动细节.md`（37 生物全表/16 道具/9+1 特质/10 模式/13 策略组/常量/奖励）。

### 34.2 arkdex.ts 数据访问补全
- **ARKDEX_PROPS 16 种加定向字段**：`targetRarity`（5004-5006/5014-5016 珍奇度 1/2/3）+
  `targetTraitMask`（5007-5011/5017-5021 特质位掩码）+ `activeDesc`（itemEffectData 原文）。
- **trait_mask 位掩码实锤**（道具 blackboard，与 traitData 序号不同）：
  `3=焦虑不安|坚韧不屈、12=时常应激|小心谨慎、48=天生幸运|活力满满、192=暴躁易怒|难以捉摸、
  768=分外记仇|狠毒异常`；位 0=焦虑不安（trait_1 在 traitData 缺失）。
- 新增 `arkdexTraits()`（9 特质）/ `arkdexTraitNames(mask)`（位掩码→特质名）/ 
  `arkdexCreaturesByHabitat(habitat)`（obtainApproach 前缀匹配，形如"生息于密林外沿"）/
  `arkdexCreaturesByRarity(rarity)` / `ARKDEX_HABITATS`（3 区）。
- **arkdexEnemySquad 深度查找**：修复策略池组解码（strategy_group_1-5/pve/npc7 为
  `{gid:{strategyId:{真数据},…},伪键:null}` 多层嵌套）——`findCreatureDataDeep` 深度优先取首个
  creatureData 数组。
- 栖息地数据是"生息于X"前缀（obtainApproach），匹配需 includes；3★ 生物分布在所有区域
  （普通区域遭遇限制 1-2★ 是玩法规则非数据分组）。

### 34.3 测试
activity-arkdex.test.ts 22 条全绿（+5：特质位掩码/栖息地分组/深层策略组/NPC 策略/野外模式）。
全量 vitest 通过（基线环境失败除外）。

## 35. 建议落地补充（2026-08-26）

### 35.1 支付调试分支（建议 10）
`config.pay.mode` 双模式即调试分支（对齐 OBS api_alipay_debug_trade）：
- "fake"（默认）：createOrder 返回占位参数，confirmOrderAlipay/Wechat 直接标 paid，
  私服免支付全流程可用；
- "real"：真实支付渠道（config.pay.alipay/wechat 配置），异步回调 /pay/notify +
  CLI `pay order <id> confirm` 手动确认。

### 35.2 域日志（建议 8）
`@utils/logger` 提供 `domainLogger(domain)` 工厂：固定域标签的 debug/info/warn/error，
与统一日志服务（subscribeLog）联动；新代码建议使用，域标签用类名/模块名。

### 35.3 统一物品管道（建议 4）
`player.gainItem.setTarget(id, type, count, instId?).use()/.handle()`：
物品增减统一入队执行（等价 items:use/items:get 直发），见 inventory-pipeline.ts。

### 35.4 寻访策略显式化与保底纯函数（建议 5）
`domain/gacha.ts#resolveGachaRank` 为保底稀有度解析纯函数（可注入随机源）；
gachaRuleType 未知时显式报错（不再静默按 NORMAL 回退）。

### 35.5 战斗后置流程清单（建议 6）
`BattleManager.finish` 头部 JSDoc 为 10 步后置流程概要；关卡结算与胜利事件补发
分别收敛到 `_settleStageState` / `_emitBattleWinEvents`。

### 35.6 Buff 模板类体系（建议 3）
`domain/building/buff-tpl.ts`（BaseBuffTpl）+ `buffs/` 模板注册表（control-global /
room-speed / dorm-recovery / mood-cost）：声明式扩展点，value 与既有引擎一致
（buff-parse.ts 纯解析，一致性由 buff-tpl.test.ts 全量差分守护）。

### 35.7 批量状态同步并发规范（建议 14）
对齐 Python 参考实现的 TaskGroupService 并发批处理：
- 读 IO 批查询（如社交助战列表 getPlayerFriendInfo）用 Promise.all 并行，保持结果顺序；
- 状态变更循环（物品获取/保底计数/任务 init 等有顺序依赖或共享状态）必须串行，禁止并发；
- 事件总线分发（events.ts before/emit/after）保持顺序语义，不得并发。

### 35.8 battleFinish 官方规格对齐审计（建议 17）
对照 OBS battleFinish 后置框架 17 项逐项审计（2026-08-26，battle.ts finish JSDoc）：
- 已对齐（11 项）：基础数据收集/trace 留存/isCheat 逆向/completeState 地图更新/测试局判定/
  干员信赖/解锁链+任务事件/理智消耗/战前预扣/syncData 刷新/后处理（mainLine+unlockHideStage）
- 占位（1 项）：好友建议 suggestFriend 恒 false（响应结构对齐，逻辑未实现）
- 缺失（3 项）：barCard 处理 / 公招槽位解锁 / 主线 buff 检查（无数据源，不虚构实现）

### 35.9 域内实体 Instance 类模式（建议 12）
对照 Python 参考实现的 sandbox 实例类（stageinstance/baseInstance/statusInstance/troopInstance）：
- rlv2 五子模块已采用实例类模式：RoguelikeStatusManager/TroopManager/InventoryManager/MapManager/
  BuffManager 每类状态一个 Manager 类（构造持 doc，init/continue/create/toJSON + 状态迁移方法），
  业务编排在 controller/composition；battle.ts 等零散落直操（current.<sub> 直接改字段为 0 处）
- 新玩法子模块按此组织：每类实体一个实例类；状态迁移/持久化/事件触发收敛到类方法；
  编排层（manager/composition）只做流程组织，不直接操作兄弟实体状态。

## 36. 虚拟时钟（DoctoratePy `server.virtualtime` 移植，2026-09-13）

### 36.1 定位
`config.virtualtime` 是全局业务时间基准：`@utils/time` 的 `now()`（= `virtualNow()`，见
`app/core/utils/time.ts`）读取之，游戏/账号/基建/活动逻辑与客户端可见 serverTime
（`/general/v1/server_time`、config gate、syncData）统一生效；典型用途是开启旧卡池/旧活动。
未启用时行为与历史版本完全一致。`realNow()` 是显式的真实时钟出口（基础设施/校验基准用）。

### 36.2 取值语义
| 取值 | 行为 |
| --- | --- |
| 缺省 / ≤ 0 / 非有限数 | 未启用（真实时间）；**0 亦按未启用**——odpy 原语义返回 1970，基建等按流逝时间结算的系统会得到数十年时长而溢出，属防呆收敛 |
| 数值 > 0 | 冻结到该秒级时间戳（允许未来值——可用于推进到后续卡池；odpy 警示勿随意调小，大幅回退会让按流逝时间结算的系统出现异常时长） |
| 字符串 | 纯数字串视同数值；或 `YYYY/MM/DD HH:mm:ss`、`DDMMYYYY HH:mm:ss`、`DD-MM-YYYY HH:mm:ss`、`YYYY-MM-DD HH:mm:ss`、`YYYYMMDD HH:mm:ss`（本地时区，月/日/时/分/秒 1~2 位可，空白归一）；解析失败回退真实时间 |
| 其他（布尔/null 等） | 回退真实时间（手工改坏 config 不抛错） |

解析实现为 `parseVirtualTime()` 纯函数（正则 + 本地时区构造 + 字段范围/日期回卷校验，
不接受 JS Date 的宽松回卷如 `2024-02-31`），五种格式按 odpy 声明顺序逐个尝试。

### 36.3 与 `developer.timestamp` 的关系
`userTimestamp()` 优先 `developer.timestamp`（admin 活动切换：仅允许过去时间，按**真实**时钟
校验，未来值回退），未设置时跟随虚拟时钟。故 admin `switchActivity` 的未来校验基准改用
`realNow()`——虚拟时钟冻结在过去时，若仍用 `now()` 会把「真实时间的过去」误判为未来而拒绝。

### 36.4 注意
冻结是**常量时钟**：`checkNew` 日/周/月刷新、基建产能/心情、AP 与信赖恢复等依赖时间流逝的
结算在冻结期间不推进；启动时若启用会打印 WARN 提示。config 于启动读入内存，修改后需重启；
测试请用 `vi.mock("@utils/time")` 或临时改写 `config.virtualtime`（`afterEach` 复原）。
