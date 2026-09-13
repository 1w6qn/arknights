# FBO schema 缺陷修复报告（2026-09-12）

承接 [`docs/fbs-crosscheck-2026-09-12.md`](fbs-crosscheck-2026-09-12.md)（交叉校验发现的 P0/P1 清单），
本轮把问题**修在链路里**而不是补数据：生成器（`scripts/cs2schema.ts`）、解码器（`scripts/vendor/fbo.ts`）
各修一处根因，并补了两个可复跑的判定工具与两组回归守卫。

## 一、根因

| # | 根因 | 后果 |
| --- | --- | --- |
| R1 | `cs2schema --write` **只重写已存在的表键**，从不新增 `clz_` 表 | 新版活动的数据类、`UnityEngine.Vector2/3` 这类非 Torappu 结构永远补不进来；引用它们的字段被 `fbo#tableToJson` 解成 `{}`，无任何报错 |
| R2 | 生成器**不做继承展开**（只取类体自身字段） | 基类字段整片解不出（实测 `FifthAnnivExploreMissionData` 线上 20 字段、本地只解 1 个） |
| R3 | 生成器把 CS 运行时模型字段**一律当作线上字段** | 运行时专有字段（`GetPercent`/`CannotGetPercent`/`SnapshotBank.targetFxBank`）挤占中间 slot，**其后字段整体位移**：实测 `ActivityBossRushData_DisplayDetailRewards.DropCount` 恒为 4（真实值 10/25/100） |
| R4 | 解码器把 `Byte/Int16` 一律按 i32 读 | 越读相邻 2–3 字节（实测 `BuildingData.ObstaclePoint.edgeWalkableMask`） |
| R5 | 解码器不认 `hg__internal__*` 前缀 | 该表被当作未知类型 → 返回 `null`（gacha `DynMeta`/`LinkageParam`/`LimitParam`、activity `DynActs` 全空） |
| R6 | 泛型实例（`RoomBean<T>`、`Undefinable<T>`）无法展开 | 这些表被判成「会丢字段」而永久冻结，客户端升级后不再更新 |
| R7 | 旧 vendored schema 残留表（类已改名/废弃）无人清理 | FBS 对照噪声；且这些表名仍被历史字段引用，容易误判 |

## 二、修复内容

**`scripts/cs2schema.ts`（生成器）**

1. **引用闭包补齐**：从 root + 全部字段引用出发，递归补齐缺失的表（CS 类 → 生成；`hg__internal__*` → 合成表）。这是 R1 的解。
2. **继承展开**：`wireFields()` = 自身字段 + 基类链字段（自身在前，同名保首次），泛型基类按实例展开
   （`RoomBean<ShopPhase>` → `clz_Torappu_BuildingData_RoomBean_1_Torappu_BuildingData_ShopPhase_`，
   命名与旧 vendored schema 一致，可直接复用既有定义）。
3. **非线格式字段剔除**（R3）：
   - `NON_WIRE_FIELDS`：逐类登记实测不在报文里的字段（两处 DisplayDetailRewards 的计算字段、音频 Bank 族）；
   - `NON_WIRE_TYPES`：`System.Object`、`LevelData.ActionID/RuntimeData`、`ObscuredRect` 等运行时类型直接剔字段；
   - `*AsNumpy` 历史合成字段不再参与「丢字段」判定，也不再阻止重生成。
4. **改名判定放宽到线格式种类**（`wireKind`）：同槽位 + 同为 i32/f32/offset… 即视为改名，
   避免 `vec:clz_A → vec:clz_B` 这类重构把整表冻结（实测 `GachaData.LinkageTenGachaTkt` 族）。
5. **不可达表清理**：从 root 走引用闭包，未被引用的表直接删除（R7）；字段名仅大小写/`m_` 前缀差异时保留旧写法，减少下游改名冲击。
6. **窄整型映射**：`System.Byte→ubyte`、`SByte→sbyte`、`Int16→short`、`UInt16→ushort`（R4 的 schema 侧）。

**`scripts/vendor/fbo.ts`（解码器）**

7. 新增 `ubyte`/`sbyte`/`short`/`ushort` 的字段与向量读取（步长 1/1/2/2），`defaultValue` 同步（R4）。
8. `hg__internal__*` 与 `clz_`/`dict__`/`kvp__` 同等对待为子表引用（R5）。
9. 新增**可选审计钩子** `FBO.observer`（默认 null，零开销），供 `schema:audit` 读取报文 vtable 真值。

**工具与守卫**

10. `pnpm run schema:audit`（`scripts/schema-audit.ts`）：解码官方 bundle，比对**报文 vtable 声明字段数**与 schema 字段数，
    并列出「从未命中」的字段。这是唯一不依赖外部参考（FBS/CS）的判定口径。
11. `pnpm run schema:crosscheck`（上一轮新增）：与 OpenArknightsFBS 参考交叉校验。
12. `tests/unit/scripts/fbs-schema-invariants.test.ts`：4 条不变量（slot 自洽 / 无悬空引用 / 无 `unknown` / root 存在）+ 负样本自证。
13. `tests/unit/vendor/fbo.test.ts`：手工构造 FlatBuffers 缓冲，覆盖窄整型、`vec:ubyte` 步长、`hg__internal__*` 子表读取，并含「按 int 读 ubyte 会越读」的负样本。

## 三、验证证据

判定口径有三条，全部可复跑：

| 口径 | 命令 | 修复前 | 修复后 |
| --- | --- | --- | --- |
| 报文真值（vtable） | `pnpm run schema:audit` | **1 张表本地缺字段**（FifthAnniv 1/20 等） | **0 张本地缺字段**；不一致仅剩 68 张「本地多字段」且全部为尾部残留（多出字段在样本中从未命中，无位移风险） |
| FBS 参考 | `pnpm run schema:crosscheck` | FBS 独有表 35、本地悬空引用 41、缺字段 5 表 | FBS 独有表 2、**悬空引用 0**、缺字段 4 表（均为参考副本落后于 2.7.71 的版本差） |
| 真实数据复解码 | 同一批 bundle 用新旧 schema 各解一遍后逐路径比对 | — | 新增有值 16164 处、结构变深 2413 处；无「有值→空」的真丢失 |

逐条对应原报告的 P0/P1（数据为实测值）：

- **Vector2/3（P0-1）**：`ArkventDataMap/.../bench_b_p1/ActorPosition` 由 `{}` → `{X: 20.50149, Y: -0.99375, Z: 0.5078473}`。
- **Act54SideData（P0-2）**：`Activity/TypeAct54SideData/act54side` 解开完整塔罗牌数据（`CardId/Name/DescUpright/...`）。
- **gacha JObject（P0-3）**：`DynMeta` 有值记录 0 → **104** 条（`{Base64: "..."}`）。
- **FifthAnnivExploreMissionData（P1-5）**：27 条记录由 1 字段 → **20 字段**，与报文 vtable 一致。
- **DropCount 位移（新发现，R3）**：`act6bossrush_01/2/DisplayDetailRewards[1]/DropCount` 由恒定的 4 → **100**（真实值）。
- **edgeWalkableMask（P1-4）**：由 i32 越读 → 1 字节读取（值随之变化，见复解码 `CHANGED` 93 处）。

未做/不建议做的两件事（记录备查）：

- **`data/excel/*.json` 未在本轮重生成**：schema 内容已变，`*.json.meta.json` 的 `schemaMtime` 指纹会使
  `isUpToDate` 判定失效，下一次 `pnpm run update`（或 `--background-update` 启动）会自动重解并回填正确数据。
- **仍冻结的 11 个类**（`wireFields` 与旧定义不一致时保留旧表，避免丢字段/错位）：
  - 会丢字段 9 个：`SharedCharData`（`SkinId/Skills/CurrentEquip`）、`BuffData`（`PriorityBbkeys`）、
    `LevelData.WaveData.FragmentData.ActionData`（`ExtraMeta/ActionId`，线上无此二者）、
    `RL01/RL03/RL04/RL05/RL06EndingText`（`Summary*` 系列）、`CharSkinData`（`DynIllustId/AvatarId/...`）。
    这些旧定义与报文实测一致（字段都在线上且能命中），冻结是**保护**而非缺陷：
    RL0x 的字段顺序已用数据反证——CS 声明序 ≠ 线上序（按 CS 声明序解出的 `SummaryActor` 是「您遭遇了幻觉…」，正确值应是角色名）。
  - 类型无法映射 2 个：`System.Int16[,]`（二维数组）与 `Torappu.IGlobalBuffSource`（接口字段），
    保留旧表即可（报文审计显示这两张表没有缺字段）。

## 四、复跑方式

```bash
pnpm run schema:audit                      # 报文真值：应输出「本地缺字段 0 张」
pnpm run schema:crosscheck                 # FBS 参考：悬空引用应为 0
pnpm exec vitest run tests/unit/scripts/fbs-schema-invariants.test.ts tests/unit/vendor/fbo.test.ts
```

客户端更新后：`pnpm run decompile` → `pnpm run schema:write` → `pnpm run schema:audit`（三条口径互为交叉验证；
`schema:check` 仍作为 slot 位移的入口门禁）。

## 五、obs 历史 FBS 基线（2.0.01 → 2.7.61）

2026-09-13 加入。参考包 `reference/obs/OpenBachelorM-master.zip` 内 `fbs/<版本>/*.fbs` 保留了
**38 个历史版本、1816 个 `.fbs`**（与 `reference/OpenArknightsFBS-main` 同一上游 OpenArknightsFBS），
可当「某个字段/结构在哪个版本出现」的历史真值源。

**取数命令**（`--fbs-zip` / `--fbs-version` 为本轮给 `schema:crosscheck` 新增的选项，会现抽到 gitignore 的 `tmp/obs-fbs/<版本>/`）：

```bash
pnpm run schema:crosscheck -- --fbs-zip reference/obs/OpenBachelorM-master.zip --fbs-version 2.7.61
```

**2.7.61 基线实测**（与本地 schema 比对；本地对应 2.7.71 CS 签名）：

```
比对 61 组 schema（FBS 2940 表 / 本地 2953 表）
表集合: FBS 独有 3（另有 11 张 list_ 向量包装表，本地内联为 vec:，非缺口） / 本地独有 29
表内字段: 本地缺字段 3 表；同槽位改名 41 表；本地多字段 22 表；序不一致 0 表；类型宽度不一致 8 表
悬空引用: 本地 0 处 / FBS 0 处
本地未解析类型 token(unknown): 5 处
slot 自洽性异常: 0 处；root 不一致: 0 处
```

即：**2.7.61 与本地没有任何「序不一致」或 slot 异常**，版本差只体现为参考副本落后（FBS 独有表 / 本地多字段），
与本项目「schema 由 2.7.71 CS 签名生成」的定位一致。可作后续漂移对比的固定基线。

**`clz_Torappu_ItemData` 中部插入活样本**（R3 那类「中间插入 → 其后 slot 全体位移」的真实版本样本）：

| 版本 | hideInItemGet | 其后字段（顺序） |
| --- | --- | --- |
| obs 2.7.61（基线） | 有 | `classifyType → itemType → stageDropList → buildingProductList → voucherRelateList → shopRelateInfoList` |
| CS 2.7.71 / 本地 schema | 有（slot 24） | `reslockStatus(26) → canReslock(28) → classifyType(30) → itemType(32) → …`（全部后移 2 槽） |

即 `reslockStatus`/`canReslock` 是在 2.7.71 插在 `hideInItemGet` 与 `classifyType` **之间**；
用 2.7.71 schema 解 2.7.61 报文（或反之）会从 `classifyType` 起整体错位——这正是 `schema:check` 门禁要拦的形态。

**字段引入归因**（新增工具 `pnpm run schema:timeline`，逐版本打印字段数与相对上一版的增删）：

```bash
pnpm run schema:timeline -- --table item_table --struct clz_Torappu_ItemData
pnpm run schema:timeline -- --table stage_table            # 省略 --struct 时读 fbs 的 root_type
```

实测数据点（`+` 为该版本新增字段）：

| 表.结构 | 2.0.40 | 2.1.01 | 2.5.04 | 2.5.80 | 2.6.61 | 2.7.01 | 2.7.61 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `item_table.clz_Torappu_ItemData` | 15 | 16（+voucherRelateList） | 16 | 17（+shopRelateInfoList） | 17 | 17 | 17 |
| `stage_table.clz_Torappu_StageTable`（root） | 17 | 18 | 27 | 27 | 28（+conditionalDropInfo） | 31（+cgGalleryDisplays/Groups/Cgs） | 31 |

（`item_table.fbs` 最早出现在 2.0.40；2.0.01/2.0.11 无此文件。`stage_table.fbs` 38 版齐全。）

**边界**：obs 最高只到 **2.7.61**，**不含 2.7.71**，不能替代 CS 反编译签名链路（`pnpm run decompile` → `schema:check/write`），
只能作历史真值源与回归数据源。
