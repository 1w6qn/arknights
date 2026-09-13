/**
 * FBO schema 不变量守卫
 *
 * 这三条不变量是「解码静默丢数据」的直接防线（对应 2026-09-12 的 schema 修复）：
 *   I1 每个字段的 slot = 4 + 2×有效字段序 —— slot 错位会读到别的字段（曾使 DropCount 恒为 4）
 *   I2 字段引用的表必须在同一 schema 文件内定义 —— 悬空引用会被 fbo 解成 `{}`
 *      （曾使 27 个 Vector2/3 字段、3 个 gacha JObject 字段整片为空）
 *   I3 不得出现字面量 `unknown` 类型 —— 解码器对它返回 null
 *
 * 这些文件是由 `pnpm run schema:write` 生成的（`scripts/cs2schema.ts`），
 * 守卫失败时先跑 `pnpm run schema:audit`（报文真值）与 `pnpm run schema:crosscheck`（FBS 参考）定位。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SCHEMA_DIR = path.resolve(__dirname, "../../../scripts/vendor/fbs-schemas");

interface Field {
  name: string;
  type: string;
  slot: number;
}
interface Schema {
  root: string;
  tables: Record<string, Field[]>;
}

/** 历史合成字段：excel-convert 丢弃、解码器读作 null，不参与不变量判定 */
const isSynthetic = (f: Field): boolean => f.name.endsWith("AsNumpy");

/** 从类型 token 抽出引用的表名（含 vec:/list_ 包装与 dict__/kvp__ 结构） */
function refsOf(type: string): string[] {
  const out: string[] = [];
  const visit = (t: string): void => {
    let s = t.trim();
    if (s.startsWith("vec:")) s = s.slice(4);
    if (s.startsWith("list_")) s = s.slice(5);
    if (s.startsWith("dict__") || s.startsWith("kvp__") || s.startsWith("list_dict__")) {
      out.push(s);
      const rest = s.replace(/^(?:dict__|kvp__|list_dict__)/, "");
      // K 为原子（不含下划线对），V 可能是嵌套 KV
      const sep = rest.indexOf("__");
      if (sep > 0) {
        visit(rest.slice(0, sep));
        visit(rest.slice(sep + 2).replace(/^list_dict__/, "vec:dict__").replace(/^list_/, "vec:"));
      }
      return;
    }
    if (s.startsWith("clz_") || s.startsWith("hg__internal__")) out.push(s);
  };
  visit(type);
  return out;
}

const files = fs
  .readdirSync(SCHEMA_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ name: f, schema: JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, f), "utf-8")) as Schema }));

describe("FBO schema 不变量", () => {
  it("schema 目录非空（至少 60 张 excel 表）", () => {
    expect(files.length).toBeGreaterThanOrEqual(60);
  });

  it("I1 字段 slot 与有效字段序一致", () => {
    const bad: string[] = [];
    for (const { name, schema } of files) {
      for (const [table, fields] of Object.entries(schema.tables)) {
        let idx = 0;
        for (const f of fields) {
          if (isSynthetic(f)) continue;
          if (f.slot !== 4 + 2 * idx) bad.push(`${name} ${table}.${f.name} slot=${f.slot} 期望=${4 + 2 * idx}`);
          idx++;
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it("I2 字段引用的表在同一文件内已定义（无悬空引用）", () => {
    const bad: string[] = [];
    for (const { name, schema } of files) {
      // 只有「表名本身即该引用」才算定义（dict__string__clz_X 提到 X 不算）
      const defined = new Set(
        Object.keys(schema.tables).filter((t) => t.startsWith("clz_") || t.startsWith("hg__internal__")),
      );
      for (const [table, fields] of Object.entries(schema.tables)) {
        for (const f of fields) {
          if (isSynthetic(f)) continue;
          for (const r of refsOf(f.type)) {
            if (!schema.tables[r] && !defined.has(r)) bad.push(`${name} ${table}.${f.name} → ${r}`);
          }
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it("I3 无字面量 unknown 类型（解码器返回 null）", () => {
    const bad: string[] = [];
    for (const { name, schema } of files) {
      for (const [table, fields] of Object.entries(schema.tables)) {
        for (const f of fields) {
          if (isSynthetic(f)) continue;
          if (f.type.includes("unknown")) bad.push(`${name} ${table}.${f.name}: ${f.type}`);
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it("I4 root 表在同文件内定义", () => {
    const bad = files.filter(({ schema }) => !schema.tables[schema.root]).map((f) => f.name);
    expect(bad).toEqual([]);
  });

  it("I5 中部插入样本：ItemData 的 reslockStatus/canReslock 位于 hideInItemGet 与 classifyType 之间", () => {
    // obs 2.7.61 基线里这两个字段不存在，2.7.71 插在中部（其后 slot 全体 +2）。
    // 该顺序是 CS 声明序 = FBO vtable slot 序的活样本；若生成器丢字段/插错位，这里会红。
    // 详见 docs/fbs-schema-repair-2026-09-12.md「obs 历史 FBS 基线」一节。
    const item = files.find((f) => f.name === "item_table.json");
    expect(item).toBeDefined();
    const fields = item?.schema.tables["clz_Torappu_ItemData"];
    expect(fields).toBeDefined();
    const byName = new Map((fields ?? []).map((f) => [f.name, f]));
    const names = ["HideInItemGet", "ReslockStatus", "CanReslock", "ClassifyType", "ItemType"];
    const slots = names.map((n) => {
      const f = byName.get(n);
      expect(f, `ItemData 缺少字段 ${n}`).toBeDefined();
      return f?.slot ?? -1;
    });
    // 严格递增且步长为 2（相邻 slot），即插入未被挤到尾部
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i] - slots[i - 1]).toBe(2);
    }
  });

  it("负样本自证：悬空引用能被检出（守卫有效性）", () => {
    const fake: Schema = {
      root: "clz_Root",
      tables: {
        clz_Root: [{ name: "X", type: "vec:clz_Missing", slot: 4 }],
      },
    };
    const defined = new Set(Object.keys(fake.tables));
    const dangling = refsOf(fake.tables.clz_Root[0].type).filter((r) => !defined.has(r));
    expect(dangling).toEqual(["clz_Missing"]);
  });
});
