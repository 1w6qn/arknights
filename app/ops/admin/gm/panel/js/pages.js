"use strict";
/**
 * DoctorateTs GM 面板 · 页面层
 *
 * 8 个分区的控制器：干员调整 / 养成工具 / 物品发放 / 集成战略 / 沙盒管理 /
 * 赛季与活动 / 数据重置 / 卫戍协议。每个页面暴露 init()（一次性挂载）、
 * onData(data)（引导数据到位后填充）、onEnter()（切入页面）。
 * 所有操作参数名严格对齐归档服务端 GM 面板（snake_case）。
 */
(function () {
  const GM = window.GM;
  const $ = GM.$;
  const { SearchSelect, ResponseBox, ChipList, Stats } = GM.components;

  /** 职业 / 星级的中文展示（非契约字段，仅 UI） */
  const PROFESSION_NAMES = {
    PIONEER: "先锋", WARRIOR: "近卫", TANK: "重装", SNIPER: "狙击",
    CASTER: "术师", MEDIC: "医疗", SUPPORT: "辅助", SPECIAL: "特种",
  };
  const rarityLabel = (rarity) => {
    const match = /TIER_(\d+)/.exec(String(rarity || ""));
    return match ? `${match[1]}★` : String(rarity || "");
  };
  const professionName = (profession) => PROFESSION_NAMES[profession] || String(profession || "");
  const fmt = (value) => GM.util.fmt(value);

  /** 当前玩家 uid（顶栏优先，回退单账号） */
  function playerId() {
    return GM.util.text("playerId") || GM.state.player || "1";
  }

  /** 干员棋 uid（卫戍协议页可单独指定，留空 = 当前玩家） */
  function autochessUid() {
    return GM.util.text("acUid") || playerId();
  }

  /**
   * 统一操作执行：进度条 + 响应框 + Toast + 成功回调
   * @param {string} op - 操作名（/admin/<op>）
   * @param {object|null} body - 请求体（null = 无 body）
   * @param {string} respId - 响应框元素 id
   * @param {Function} [onOk] - 成功回调
   */
  async function run(op, body, respId, onOk) {
    ResponseBox.pending(respId);
    GM.ui.progress(true);
    try {
      const result = await GM.api.post(op, body);
      ResponseBox.show(respId, result);
      if (result.ok) {
        GM.ui.toast((result.json && result.json.detail) || "执行成功", "success");
        if (onOk) await onOk(result);
      } else {
        GM.ui.toast(result.detail || `执行失败（HTTP ${result.status}）`, "error");
      }
      return result;
    } catch (error) {
      ResponseBox.error(respId, error.message || error);
      GM.ui.toast(`请求失败：${error.message || error}`, "error");
      return { ok: false };
    } finally {
      GM.ui.progress(false);
    }
  }

  /* ============================== 干员调整 ============================== */

  const char = {
    /** SearchSelect 实例 */
    select: null,
    /** 当前选中的干员（/gm/data.chars 条目） */
    current: null,
    /** 当前干员的选项（/gm/char 响应） */
    options: null,

    init() {
      this.select = new SearchSelect($("charSearch"), {
        placeholder: "搜索干员名 / char_id / 职业…",
        limit: 120,
        getLabel: (c) => `${c.name} · ${c.id}`,
        getSub: (c) => `${rarityLabel(c.rarity)} · ${professionName(c.profession)}`,
        getSearch: (c) => `${c.name} ${c.id} ${c.profession}`.toLowerCase(),
        onSelect: (c) => {
          if (!c) return this.clear();
          void this.load(c.id);
        },
      });
      GM.qsa("input,select", $("charLevel").closest(".card")).forEach((el) => {
        el.addEventListener("input", () => this.preview());
        el.addEventListener("change", () => this.preview());
      });
      $("btnCharApply").addEventListener("click", () => this.apply());
      $("btnCharMax").addEventListener("click", () => this.max());
      $("btnCharReset").addEventListener("click", () => this.clear(true));
    },

    onData(data) {
      $("charTotal").textContent = fmt(data.chars.length);
      this.select.setItems(data.chars);
    },

    /** 载入干员可选参数并填充下拉 */
    async load(charId) {
      try {
        this.options = await GM.api.getJson(`/gm/char?id=${encodeURIComponent(charId)}`);
      } catch (error) {
        GM.ui.toast(`读取干员参数失败：${error.message || error}`, "error");
        return;
      }
      this.current = this.options;
      Stats.render("charInfo", [
        { label: "干员", value: `${this.options.name} · ${this.options.id}` },
        { label: "星级 / 职业", value: `${rarityLabel(this.options.rarity)} · ${professionName(this.options.profession)}` },
        { label: "技能槽", value: String(this.options.skills.length) },
        { label: "可用模组", value: String(this.options.equips.length) },
      ]);
      const evolve = $("charEvolve");
      evolve.innerHTML = `<option value="">不改</option>` +
        this.options.phases.map((p) => `<option value="${p.phase}">${p.phase}（上限 ${p.maxLevel}）</option>`).join("");
      const skillIdx = $("charSkillIdx");
      skillIdx.innerHTML = `<option value="">不改</option>` +
        this.options.skills.map((s) => `<option value="${s.index}">${s.index} · ${GM.util.escapeHtml(s.skillId)}</option>`).join("");
      const equip = $("charEquip");
      equip.innerHTML = `<option value="">不改</option>` +
        this.options.equips
          .map((e) => `<option value="${GM.util.escapeHtml(e.id)}">${GM.util.escapeHtml(e.name)}（${GM.util.escapeHtml(e.typeName)}）</option>`)
          .join("");
      this.preview();
    },

    clear(silent) {
      this.current = null;
      this.options = null;
      Stats.clear("charInfo");
      $("charEvolve").innerHTML = `<option value="">不改</option>`;
      $("charSkillIdx").innerHTML = `<option value="">不改</option>`;
      $("charEquip").innerHTML = `<option value="">不改</option>`;
      ["charLevel", "charPotential", "charSkill", "charFavor", "charEquipLevel", "charTmpl"].forEach((id) => ($(id).value = ""));
      $("charSpec").value = "";
      if (this.select) this.select.clear();
      if (!silent) this.preview();
      else this.preview();
    },

    /** 组装面板请求体（仅包含已填字段，snake_case 契约） */
    body() {
      if (!this.current) return null;
      const body = { player_id: playerId(), char_id: this.current.id };
      const level = GM.util.num("charLevel");
      const evolve = GM.util.num("charEvolve");
      const potential = GM.util.num("charPotential");
      const skill = GM.util.num("charSkill");
      const skillIdx = GM.util.num("charSkillIdx");
      const spec = GM.util.num("charSpec");
      const favor = GM.util.num("charFavor");
      const equip = GM.util.text("charEquip");
      const equipLevel = GM.util.num("charEquipLevel");
      const tmpl = GM.util.text("charTmpl");
      if (level !== undefined) body.level = level;
      if (evolve !== undefined) body.evolve_phase = evolve;
      if (potential !== undefined) body.potential_rank = potential;
      if (skill !== undefined) body.main_skill_lvl = skill;
      if (skillIdx !== undefined) body.skill_idx_lst = [skillIdx];
      if (spec !== undefined) body.specialize_level = spec;
      if (favor !== undefined) body.favor_point = favor;
      if (equip) body.equip_id_lst = [equip];
      if (equipLevel !== undefined) body.equip_level = equipLevel;
      if (tmpl) body.tmpl_id = tmpl;
      return body;
    },

    /** 命令预览（等价 CLI 形态，便于复制到终端） */
    preview() {
      const body = this.body();
      if (!body) {
        $("charPreview").textContent = "选择干员并填写参数后生成…";
        return;
      }
      const flags = [];
      const push = (name, value) => {
        if (value !== undefined) flags.push(`${name} ${value}`);
      };
      push("--level", body.level);
      push("--evolve", body.evolve_phase);
      push("--potential", body.potential_rank);
      push("--skill", body.main_skill_lvl);
      push("--skill-idx", body.skill_idx_lst && body.skill_idx_lst[0]);
      push("--spec", body.specialize_level);
      push("--favor", body.favor_point);
      push("--equip", body.equip_id_lst && body.equip_id_lst[0]);
      push("--equip-level", body.equip_level);
      push("--tmpl", body.tmpl_id);
      $("charPreview").textContent =
        `POST /admin/char\n${JSON.stringify(body, null, 2)}\n\n# CLI 等价：\n# pnpm run admin -- users char ${body.player_id} --char ${body.char_id} ${flags.join(" ")}`;
    },

    apply() {
      const body = this.body();
      if (!body) {
        GM.ui.toast("请先选择目标干员", "error");
        return;
      }
      if (Object.keys(body).length <= 2) {
        GM.ui.toast("请至少填写一项要修改的参数", "error");
        return;
      }
      void run("char", body, "respChar", async () => {
        await this.load(body.char_id);
      });
    },

    max() {
      if (!this.current) {
        GM.ui.toast("请先选择目标干员", "error");
        return;
      }
      const body = { player_id: playerId(), char_id: this.current.id };
      GM.ui
        .confirm({ title: "满养成确认", body: `确认把 ${this.current.name}（${this.current.id}）拉满（精二满级/满潜/满技能/专三/满信赖/满模组）？`, okText: "拉满" })
        .then((ok) => {
          if (ok) void run("char_max", body, "respChar", async () => this.load(body.char_id));
        });
    },
  };

  /* ============================== 养成工具 ============================== */

  const growth = {
    init() {
      const sync = (value) => {
        const level = Math.min(120, Math.max(1, Math.trunc(Number(value) || 1)));
        $("doctorLevel").value = String(level);
        $("doctorLevelRange").value = String(level);
        $("doctorLevelVal").textContent = String(level);
      };
      $("doctorLevel").addEventListener("input", () => sync($("doctorLevel").value));
      $("doctorLevelRange").addEventListener("input", () => sync($("doctorLevelRange").value));
      $("btnDoctorLevel").addEventListener("click", () => {
        const level = GM.util.num("doctorLevel");
        void run("doctor_level", { player_id: playerId(), level }, "respGrowth");
      });

      const batches = [
        ["btnStageUnlockAll", "stage_unlock_all", "解锁全部关卡", "将遍历关卡表把所有关卡标记为已通关。"],
        ["btnCharGrantAll", "char_grant_all", "发放全部干员", "将发放全部可获取干员（已拥有跳过），数量较多，耗时较长。"],
        ["btnCharMaxAll", "char_max_all", "全员满养成", "将把当前已拥有的全部干员拉满。"],
        ["btnSkinGrantAll", "skin_grant_all", "发放全部皮肤", "将发放皮肤表内全部皮肤（数量约 2000+，会显著增大存档）。"],
        ["btnFurniGrantAll", "furni_grant_all", "发放全部家具", "将把家具表内全部家具设为 99 件（覆盖现有数量）。"],
        ["btnShopCurrency", "shop_currency_grant", "发放商店货币", "将把龙门币/凭证等商店货币补到上限。"],
      ];
      for (const [id, op, label, warning] of batches) {
        $(id).addEventListener("click", () => {
          GM.ui
            .confirm({ title: `${label}确认`, body: `${warning}\n目标玩家：${playerId()}`, danger: true, okText: label })
            .then((ok) => {
              if (ok) void run(op, { player_id: playerId() }, "respGrowth");
            });
        });
      }
    },
    onData() {},
  };

  /* ============================== 物品发放 ============================== */

  const item = {
    /** 全部物品（/gm/data.items） */
    all: [],
    /** 当前分类下的物品 */
    filtered: [],
    select: null,

    init() {
      this.select = new SearchSelect($("itemSearch"), {
        placeholder: "搜索物品名 / ID / 类型…（最多显示 200 条）",
        getLabel: (i) => `${i.name} · ${i.id}`,
        getSub: (i) => `${i.itemType || i.category || ""}`,
        getSearch: (i) => `${i.name} ${i.id} ${i.itemType}`.toLowerCase(),
      });
      $("itemCategory").addEventListener("change", () => this.applyCategory());
      $("btnItemAdd").addEventListener("click", () => this.addAttachment());
      $("btnAttachClear").addEventListener("click", () => {
        GM.state.attachments = [];
        this.renderAttachments();
      });
      $("btnItemSend").addEventListener("click", () => this.send());
      $("btnItemClearOne").addEventListener("click", () => this.clearOne());
      $("btnItemClearAll").addEventListener("click", () => this.clearAll());
    },

    onData(data) {
      this.all = data.items || [];
      const categories = ["ALL", ...new Set(this.all.map((i) => i.category || "OTHER"))];
      $("itemCategory").innerHTML = categories.map((c) => `<option value="${GM.util.escapeHtml(c)}">${c === "ALL" ? "全部分类" : GM.util.escapeHtml(c)}</option>`).join("");
      this.applyCategory();
      this.renderAttachments();
    },

    applyCategory() {
      const category = $("itemCategory").value;
      this.filtered = category && category !== "ALL" ? this.all.filter((i) => i.category === category) : this.all;
      this.select.setItems(this.filtered);
    },

    renderAttachments() {
      ChipList.render(
        "attachList",
        GM.state.attachments,
        (index) => {
          GM.state.attachments.splice(index, 1);
          this.renderAttachments();
        },
        "附件：无",
      );
      $("attachCount").textContent = String(GM.state.attachments.length);
    },

    addAttachment() {
      const picked = this.select.getSelected();
      const count = GM.util.num("itemCount") || 1;
      if (!picked) {
        GM.ui.toast("请先选择物品", "error");
        return;
      }
      const existing = GM.state.attachments.find((a) => a.id === picked.id);
      if (existing) existing.count += count;
      else GM.state.attachments.push({ id: picked.id, count, label: `${picked.name}(${picked.id})` });
      this.renderAttachments();
      GM.ui.toast(`已添加 ${picked.name} ×${count}`, "success");
    },

    send() {
      if (!GM.state.attachments.length) {
        GM.ui.toast("附件为空：请先添加物品", "error");
        return;
      }
      const body = {
        player_id: playerId(),
        items: GM.state.attachments.map((a) => ({ id: a.id, count: a.count })),
        subject: GM.util.text("mailSubject"),
        content: GM.util.text("mailContent"),
      };
      void run("mail_grant", body, "respItem", () => {
        GM.state.attachments = [];
        this.renderAttachments();
      });
    },

    clearOne() {
      const picked = this.select.getSelected();
      if (!picked) {
        GM.ui.toast("请先选择物品", "error");
        return;
      }
      GM.ui
        .confirm({ title: "删除物品", body: `确认删除 ${picked.name}（${picked.id}）？`, danger: true, okText: "删除" })
        .then((ok) => {
          if (ok) void run("item_clear", { player_id: playerId(), item_id: picked.id }, "respItem");
        });
    },

    clearAll() {
      GM.ui
        .confirm({
          title: "清空仓库",
          body: `将把玩家 ${playerId()} 的背包全部清零（货币/凭证与家具不受影响）。`,
          danger: true,
          confirmWord: "CLEAR",
          okText: "清空仓库",
        })
        .then((ok) => {
          if (ok) void run("item_clear", { player_id: playerId() }, "respItem");
        });
    },
  };

  /* ============================== 集成战略 ============================== */

  const rlv2 = {
    mode: "difficulty",
    charSelect: null,

    init() {
      $("rlvTabs").addEventListener("click", (event) => {
        const tab = event.target.closest(".tab");
        if (!tab) return;
        this.mode = tab.dataset.rlv;
        GM.qsa(".tab", $("rlvTabs")).forEach((el) => el.classList.toggle("is-active", el === tab));
        GM.qsa(".tab-panel").forEach((el) => el.classList.toggle("is-active", el.dataset.rlv === this.mode));
      });
      this.charSelect = new SearchSelect($("rlvCharSearch"), {
        placeholder: "搜索对局内干员…",
        getLabel: (c) => `${c.name} · ${c.id}`,
        getSearch: (c) => `${c.name} ${c.id}`.toLowerCase(),
      });
      $("btnRlvApply").addEventListener("click", () => this.apply());
    },

    onData(data) {
      this.charSelect.setItems(data.chars || []);
      $("rlvRelicList").innerHTML = (data.rlv.relics || []).map((r) => `<option value="${GM.util.escapeHtml(r.id)}">${GM.util.escapeHtml(r.name)}</option>`).join("");
      $("rlvBuffList").innerHTML = (data.rlv.charBuffs || []).map((b) => `<option value="${GM.util.escapeHtml(b.id)}">${GM.util.escapeHtml(b.name)}</option>`).join("");
    },

    apply() {
      if (this.mode === "difficulty") {
        const n = GM.util.num("rlvDifficulty");
        if (n === undefined) {
          GM.ui.toast("请填写难度值", "error");
          return;
        }
        void run("rlv2/difficulty", { player_id: playerId(), n }, "respRlv2");
        return;
      }
      if (this.mode === "relic") {
        const relicId = GM.util.text("rlvRelic");
        if (!relicId) {
          GM.ui.toast("请填写藏品 ID", "error");
          return;
        }
        void run("rlv2/relic_layer", { player_id: playerId(), relic_id: relicId, layer: GM.util.num("rlvLayer") }, "respRlv2");
        return;
      }
      const picked = this.charSelect.getSelected();
      const buff = GM.util.text("rlvBuff");
      if (!picked || !buff) {
        GM.ui.toast("请选择干员并填写增益 ID", "error");
        return;
      }
      void run("rlv2/char_buff", { player_id: playerId(), char_id: picked.id, char_buff_id: buff }, "respRlv2");
    },
  };

  /* ============================== 沙盒管理 ============================== */

  const sandbox = {
    select: null,

    init() {
      this.select = new SearchSelect($("sandboxSearch"), {
        placeholder: "搜索沙盒主题…",
        getLabel: (t) => t.name,
        getSub: (t) => t.id,
        getSearch: (t) => `${t.name} ${t.id}`.toLowerCase(),
      });
      $("btnSandboxSeason").addEventListener("click", () => {
        const topic = this.select.getSelected();
        if (!topic) {
          GM.ui.toast("请先选择沙盒主题", "error");
          return;
        }
        void run(
          "sandbox/season",
          { player_id: playerId(), topic_id: topic.id, season_idx: GM.util.num("sandboxSeason") || 0 },
          "respSandbox",
        );
      });
      $("btnSandboxEnemy").addEventListener("click", () => {
        const topic = this.select.getSelected();
        const enemy = GM.util.text("sandboxEnemy");
        const node = GM.util.text("sandboxNode");
        if (!topic || !enemy || !node) {
          GM.ui.toast("需要主题 + 敌潮组 + 节点", "error");
          return;
        }
        void run(
          "sandbox/enemy_rush",
          { player_id: playerId(), topic_id: topic.id, enemy_id: enemy, node_id: node },
          "respSandbox",
        );
      });
    },

    onData(data) {
      this.select.setItems(data.sandbox || []);
    },
  };

  /* ============================== 赛季与活动 ============================== */

  const season = {
    clockSelect: null,
    switchSelect: null,

    init() {
      this.clockSelect = new SearchSelect($("clockActivitySearch"), {
        placeholder: "搜索活动（名称 / ID / 类型）…",
        getLabel: (a) => `${a.name} · ${a.id}`,
        getSub: (a) => a.type,
        getSearch: (a) => `${a.name} ${a.id} ${a.type}`.toLowerCase(),
      });
      this.switchSelect = new SearchSelect($("switchActivitySearch"), {
        placeholder: "搜索活动（名称 / ID / 类型）…",
        getLabel: (a) => `${a.name} · ${a.id}`,
        getSub: (a) => a.type,
        getSearch: (a) => `${a.name} ${a.id} ${a.type}`.toLowerCase(),
      });
      $("btnStateRefresh").addEventListener("click", () => GM.app.refreshState());

      $("btnActivityClock").addEventListener("click", () => {
        const activity = this.clockSelect.getSelected();
        if (!activity) {
          GM.ui.toast("请先选择目标活动", "error");
          return;
        }
        void run("activity_clock", { activity_id: activity.id }, "respSeason", () => GM.app.refreshState());
      });
      $("btnActivityClockReset").addEventListener("click", () =>
        void run("activity_clock", null, "respSeason", () => GM.app.refreshState()),
      );
      $("btnActivitySwitch").addEventListener("click", () => {
        const activity = this.switchSelect.getSelected();
        if (!activity) {
          GM.ui.toast("请先选择目标活动", "error");
          return;
        }
        void run("activity_switch", { activity_id: activity.id }, "respSeason", () => GM.app.refreshState());
      });
      $("btnActivitySwitchReset").addEventListener("click", () =>
        void run("activity_switch", null, "respSeason", () => GM.app.refreshState()),
      );
      $("btnCrisisSeason").addEventListener("click", () =>
        void run("crisis_season", { season_id: $("crisisSeason").value }, "respSeason", () => GM.app.refreshState()),
      );
      $("btnTowerSeason").addEventListener("click", () =>
        void run(
          "tower_season",
          { player_id: playerId(), season_id: $("towerSeason").value },
          "respSeason",
          () => GM.app.refreshState(),
        ),
      );
      $("btnAssetPatchOn").addEventListener("click", () => this.patch(true));
      $("btnAssetPatchOff").addEventListener("click", () => this.patch(false));
      $("btnAssetPatchGuide").addEventListener("click", () => this.guide());
    },

    onData(data) {
      this.clockSelect.setItems(data.full_activities || []);
      this.switchSelect.setItems(data.full_activities || []);
      $("crisisSeason").innerHTML = (data.crisis_seasons || [])
        .map((s) => `<option value="${GM.util.escapeHtml(s.id)}">${GM.util.escapeHtml(s.name)}</option>`)
        .join("");
      $("towerSeason").innerHTML = (data.tower_seasons || [])
        .map((s) => `<option value="${GM.util.escapeHtml(s.id)}">${GM.util.escapeHtml(s.name)}</option>`)
        .join("");
      this.applyState(data.gm_state);
      if (!GM.storage.get("guide-seen", false)) this.guide(true);
    },

    /** 渲染全服状态卡 + 强制开启 chips + 补丁徽章 */
    applyState(state) {
      if (!state) return;
      Stats.render("gmStateCard", [
        { label: "活动时钟", value: state.activity_clock ? `${state.activity_clock}` : "跟随真实时间", tone: state.activity_clock ? "warn" : "" },
        { label: "时钟时间戳", value: state.activity_clock_ts === -1 ? "—" : new Date(state.activity_clock_ts * 1000).toLocaleString("zh-CN") },
        { label: "危机合约 V1", value: state.crisis_v1_season },
        { label: "危机合约 V2", value: state.crisis_v2_season },
        { label: "强制开启", value: `${(state.activity_override || []).length} 个`, tone: (state.activity_override || []).length ? "warn" : "" },
      ]);
      ChipList.render("overrideList", (state.activity_override || []).map((id) => ({ id })), null, "当前无强制开启活动");
      const badge = $("assetPatchBadge");
      badge.textContent = state.asset_patch ? "补丁：开" : "补丁：关";
      badge.className = `badge ${state.asset_patch ? "badge--on" : "badge--off"}`;
    },

    /** 资源补丁开关（写 data/config.json + 热重载） */
    patch(on) {
      GM.ui
        .confirm({
          title: on ? "开启资源补丁" : "关闭资源补丁",
          body: on
            ? "将把 data/config.json 的 assets.enableMods 置为 true 并立即热重载 mods 列表（免重启）。去玩官服前请务必关闭。"
            : "将把 assets.enableMods 置为 false 并立即卸载 mods 列表（恢复官服原生资源）。",
          okText: on ? "开启" : "关闭",
        })
        .then((ok) => {
          if (ok) void run("asset_patch", { state: on ? "on" : "off" }, "respSeason", () => GM.app.refreshState());
        });
    },

    /** 资源补丁使用教程（首访自动弹一次） */
    guide(auto) {
      GM.ui.tutorial({
        title: "资源补丁使用教程",
        onDone: () => GM.storage.set("guide-seen", true),
        steps: [
          "<b>这是什么？</b><br>全服级的资源补丁开关：开启后本服会向客户端下发 mods 目录里的替换资源，无需重启服务。",
          "<b>怎么用？</b><br>点「补丁全开」并确认 → 服务端立即热重载 → 客户端重新进入游戏/触发热更即可看到替换效果。",
          "<b>为什么要关？</b><br>去打官服前必须点「补丁全关」：补丁会让官服热更校验失败甚至无法登录。",
          auto ? "<b>提示</b><br>本教程只自动弹出一次，随时可点「? 使用教程」重看。" : "<b>完成</b><br>现在可以关闭本窗口继续操作。",
        ],
      });
    },
  };

  /* ============================== 数据重置 ============================== */

  const reset = {
    keys: [],

    init() {
      $("resetKey").addEventListener("change", () => this.renderHint());
      $("btnResetKey").addEventListener("click", () => {
        const key = $("resetKey").value;
        const def = this.keys.find((k) => k.id === key);
        if (!def) {
          GM.ui.toast("请选择要重置的分区", "error");
          return;
        }
        GM.ui
          .confirm({ title: "重置分区", body: `将把玩家 ${playerId()} 的「${def.label}」重置为新号状态。`, danger: true, okText: "重置" })
          .then((ok) => {
            if (ok) void run("reset_key", { player_id: playerId(), key }, "respReset");
          });
      });
      $("btnResetAll").addEventListener("click", () => {
        const uid = playerId();
        GM.ui
          .confirm({
            title: "恢复初始模板",
            body: `将把玩家 ${uid} 的整份存档重建为全新新号（不可恢复）。`,
            danger: true,
            confirmWord: uid,
            okText: "恢复初始模板",
          })
          .then((ok) => {
            if (ok) void run("reset_all", { player_id: uid }, "respReset");
          });
      });
      $("btnResetDb").addEventListener("click", () => {
        GM.ui
          .confirm({
            title: "清空全部玩家存档",
            body: "将把所有账号的存档重建为初始模板（账号与登录凭据保留）。该操作影响全部玩家，请谨慎执行。",
            danger: true,
            confirmWord: "CLEAR",
            okText: "清空全部存档",
          })
          .then((ok) => {
            if (ok) void run("reset_db", null, "respReset");
          });
      });
    },

    onData(data) {
      this.keys = data.reset_keys || [];
      $("resetKey").innerHTML = this.keys.map((k) => `<option value="${GM.util.escapeHtml(k.id)}">${GM.util.escapeHtml(k.label)}</option>`).join("");
      this.renderHint();
    },

    renderHint() {
      const def = this.keys.find((k) => k.id === $("resetKey").value);
      $("resetKeyHint").textContent = def ? `分区「${def.id}」：${def.label}` : "选择分区后显示说明";
    },
  };

  /* ============================== 卫戍协议 GM ============================== */

  const autochess = {
    charSelect: null,
    itemSelect: null,

    init() {
      this.charSelect = new SearchSelect($("acCharSearch"), {
        placeholder: "搜索干员棋（名字 / chess_char ID）…",
        getLabel: (c) => `${c.name} · ${c.id}`,
        getSub: (c) => `${c.cost} 费`,
        getSearch: (c) => `${c.name} ${c.id}`.toLowerCase(),
      });
      this.itemSelect = new SearchSelect($("acItemSearch"), {
        placeholder: "搜索道具棋（名字 / chess_item ID）…",
        getLabel: (i) => `${i.name} · ${i.id}`,
        getSub: (i) => `Lv${i.lv} ${i.type === "MAGIC" ? "法术" : "装备"}`,
        getSearch: (i) => `${i.name} ${i.id}`.toLowerCase(),
      });
      GM.qsa("[data-ac]").forEach((btn) => btn.addEventListener("click", () => this.exec(btn.dataset.ac)));
      $("btnAcStateRefresh").addEventListener("click", () => this.state());
      $("acAuto").addEventListener("change", () => this.toggleAuto());
    },

    onData(data) {
      this.charSelect.setItems(data.autochess.chars || []);
      this.itemSelect.setItems(data.autochess.items || []);
    },

    onEnter() {
      this.toggleAuto();
      void this.state();
    },

    /** 组装并发送 GM 指令 */
    exec(action) {
      const uid = autochessUid();
      const n = GM.util.num("acNum");
      let code = action;
      let params = [];
      if (action === "add_coin" || action === "set_hp" || action === "set_shop_lv") params = [n];
      else if (action === "grant_char") {
        const picked = this.charSelect.getSelected();
        if (!picked) {
          GM.ui.toast("请先选择干员棋", "error");
          return;
        }
        params = [picked.id];
      } else if (action === "grant_item") {
        const picked = this.itemSelect.getSelected();
        if (!picked) {
          GM.ui.toast("请先选择道具棋", "error");
          return;
        }
        params = [picked.id];
      } else if (action === "force_settle_win") {
        code = "force_settle";
        params = ["win"];
      } else if (action === "force_settle_lose") {
        code = "force_settle";
        params = ["lose"];
      }
      void run("autochess_gm", { uid, code, params }, "respAc", (result) => {
        if (code === "state" && result.json && result.json.data) this.renderState(result.json.data);
        else if (code !== "state") void this.state();
      });
    },

    state() {
      return run("autochess_gm", { uid: autochessUid(), code: "state", params: [] }, "respAc", (result) => {
        if (result.json && result.json.data) this.renderState(result.json.data);
      });
    },

    /** 渲染战局状态卡 */
    renderState(data) {
      if (!data || !data.active || !data.state) {
        Stats.render("acState", [{ label: "对局", value: "无进行中的对局", tone: "warn" }]);
        return;
      }
      const s = data.state;
      Stats.render("acState", [
        { label: "对局", value: s.battleId },
        { label: "场景 / 模式", value: `${s.sceneId} · ${s.modeId || "-"}` },
        { label: "回合", value: `${s.curRound} / ${s.maxRound}` },
        { label: "金币", value: fmt(s.coin) },
        { label: "生命", value: fmt(s.hp) },
        { label: "商店等级", value: String(s.shopLv) },
        { label: "Boss", value: s.bossId || "未抽取" },
        { label: "冻结", value: s.paused ? "是" : "否", tone: s.paused ? "warn" : "" },
        { label: "桌面", value: `干员 ${s.table.chars.length} · 道具 ${s.table.items.length}` },
      ]);
    },

    /** 自动刷新（仅本页可见时） */
    toggleAuto() {
      const want = $("acAuto").checked;
      if (GM.state.acTimer) {
        clearInterval(GM.state.acTimer);
        GM.state.acTimer = null;
      }
      if (want && GM.state.page === "autochess") {
        GM.state.acTimer = setInterval(() => {
          if (GM.state.page === "autochess" && !document.hidden) void this.state();
        }, 3000);
      }
    },
  };

  GM.pages = { char, growth, item, rlv2, sandbox, season, reset, autochess };
})();
