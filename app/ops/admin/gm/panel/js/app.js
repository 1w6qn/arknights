"use strict";
/**
 * DoctorateTs GM 面板 · 应用层
 *
 * 负责：启动引导（/gm/config → /gm/players → /gm/data）、页面切换、顶栏交互、
 * 卫戍协议页的连点解锁、快捷键、状态轻量刷新（/gm/state）。
 */
(function () {
  const GM = window.GM;
  const $ = GM.$;
  const st = GM.state;

  /** 卫戍协议解锁：1.5s 内连点导航 5 次（保留归档面板的彩蛋，同时提供显式解锁提示） */
  const GM_CLICK_WINDOW = 1500;
  const GM_CLICK_COUNT = 5;
  let gmClicks = [];

  const app = {
    /** 面板版本（/gm/config 回显） */
    version: "-",
    /** 启动幂等标记 */
    booted: false,

    /** 切换页面 */
    switchPage(page) {
      if (page === "autochess" && !st.unlocked) {
        GM.ui.toast("卫戍协议 GM 未解锁：连点导航项 5 次（或点击「解锁」提示）", "error");
        return;
      }
      st.page = page;
      GM.qsa(".nav__item").forEach((el) => el.classList.toggle("is-active", el.dataset.page === page));
      GM.qsa(".page").forEach((el) => el.classList.toggle("is-active", el.dataset.page === page));
      const controller = GM.pages[page];
      if (controller && controller.onEnter) controller.onEnter();
      if (page === "autochess") GM.pages.autochess.toggleAuto();
      else if (st.acTimer) {
        clearInterval(st.acTimer);
        st.acTimer = null;
      }
    },

    /** 玩家列表（顶栏 datalist + 默认值） */
    async loadPlayers() {
      const payload = await GM.api.getJson("/gm/players");
      st.players = Array.isArray(payload.players) ? payload.players : [];
      st.player = st.player && st.players.includes(st.player) ? st.player : payload.current || st.players[0] || "1";
      $("playerList").innerHTML = st.players.map((uid) => `<option value="${GM.util.escapeHtml(uid)}"></option>`).join("");
      if (!GM.util.text("playerId")) $("playerId").value = st.player;
      $("acUid").placeholder = `留空 = ${st.player}`;
      return payload;
    },

    /** 引导数据（面板各页的选择器数据源） */
    async loadData() {
      GM.ui.progress(true);
      try {
        st.data = await GM.api.getJson("/gm/data");
        for (const controller of Object.values(GM.pages)) {
          if (controller.onData) controller.onData(st.data);
        }
        GM.ui.online(true, "在线");
        return st.data;
      } finally {
        GM.ui.progress(false);
      }
    },

    /** 轻量状态刷新（不重取整份引导数据） */
    async refreshState() {
      try {
        const payload = await GM.api.getJson("/gm/state");
        st.players = Array.isArray(payload.players) ? payload.players : st.players;
        $("playerList").innerHTML = st.players.map((uid) => `<option value="${GM.util.escapeHtml(uid)}"></option>`).join("");
        GM.pages.season.applyState(payload.gm_state);
        return payload;
      } catch (error) {
        GM.ui.toast(`状态刷新失败：${error.message || error}`, "error");
        return null;
      }
    },

    /** 引导配置（令牌 + 版本） */
    async loadConfig() {
      const cfg = await GM.api.getJson("/gm/config");
      if (cfg.admin_token) {
        st.token = cfg.admin_token;
        $("token").value = cfg.admin_token;
        GM.storage.set("token", cfg.admin_token);
      } else if (st.token) {
        $("token").value = st.token;
      }
      this.version = cfg.panel_version || "-";
      $("panelVersion").textContent = this.version;
      if (cfg.panel_title) $("panelTitle").textContent = cfg.panel_title;
      GM.ui.online(true, "在线");
      return cfg;
    },

    /** 启动 */
    async boot() {
      if (this.booted) return;
      this.booted = true;
      /* 1. 本地偏好 */
      const savedToken = GM.storage.get("token", "");
      const savedPlayer = GM.storage.get("player", "");
      if (savedToken) {
        st.token = savedToken;
        $("token").value = savedToken;
      }
      if (savedPlayer) {
        st.player = savedPlayer;
        $("playerId").value = savedPlayer;
      }
      st.unlocked = GM.storage.get("autochess-unlocked", false) === true;
      this.applyLock();

      /* 2. 页面控制器挂载 */
      for (const controller of Object.values(GM.pages)) {
        if (controller.init) controller.init();
      }

      /* 3. 交互挂载 */
      this.wire();

      /* 4. 引导（失败也要让用户能手动输入令牌后重试） */
      try {
        await this.loadConfig();
      } catch (error) {
        GM.ui.online(false, "离线");
        GM.ui.toast(`引导失败：${error.message || error}（可在顶栏手动填写令牌后点「重新加载引导数据」）`, "error");
        return;
      }
      try {
        await this.loadPlayers();
        await this.loadData();
      } catch (error) {
        GM.ui.online(false, "离线");
        GM.ui.toast(`数据加载失败：${error.message || error}`, "error");
      }
    },

    /** 顶栏 / 导航 / 快捷键 / 复制按钮 */
    wire() {
      $("nav").addEventListener("click", (event) => {
        const item = event.target.closest(".nav__item");
        if (!item) return;
        const page = item.dataset.page;
        if (page === "autochess") {
          this.registerGmClick();
          if (!st.unlocked) return;
        }
        this.switchPage(page);
      });

      $("playerId").addEventListener("change", () => {
        st.player = GM.util.text("playerId");
        GM.storage.set("player", st.player);
      });
      $("token").addEventListener("change", () => {
        st.token = GM.util.text("token");
        GM.storage.set("token", st.token);
        void this.loadData().catch((error) => GM.ui.toast(`重新加载失败：${error.message || error}`, "error"));
      });
      $("btnTokenReveal").addEventListener("click", () => {
        const input = $("token");
        input.type = input.type === "password" ? "text" : "password";
      });
      $("btnReloadAll").addEventListener("click", () => {
        st.token = GM.util.text("token");
        GM.ui.progress(true);
        Promise.all([this.loadPlayers(), this.loadData()])
          .then(() => GM.ui.toast("引导数据已刷新", "success"))
          .catch((error) => GM.ui.toast(`刷新失败：${error.message || error}`, "error"))
          .finally(() => GM.ui.progress(false));
      });
      $("btnPlayerRefresh").addEventListener("click", () => {
        void this.loadPlayers()
          .then(() => GM.ui.toast("账号列表已刷新", "success"))
          .catch((error) => GM.ui.toast(`刷新失败：${error.message || error}`, "error"));
      });

      document.addEventListener("click", (event) => {
        const trigger = event.target.closest("[data-copy]");
        if (!trigger) return;
        const source = GM.$(trigger.dataset.copy);
        if (source) void GM.util.copy(source.textContent);
      });

      document.addEventListener("keydown", (event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        const index = Number(event.key);
        if (!index || index < 1 || index > 8) return;
        const pages = Object.keys(GM.pages);
        const page = pages[index - 1];
        if (page === "autochess" && !st.unlocked) return;
        event.preventDefault();
        this.switchPage(page);
      });
    },

    /** 连点计数（归档面板彩蛋：1.5s 内 5 次解锁） */
    registerGmClick() {
      const now = Date.now();
      gmClicks = gmClicks.filter((ts) => now - ts < GM_CLICK_WINDOW);
      gmClicks.push(now);
      if (gmClicks.length >= GM_CLICK_COUNT) {
        gmClicks = [];
        st.unlocked = true;
        GM.storage.set("autochess-unlocked", true);
        this.applyLock();
        GM.ui.toast("卫戍协议 GM 已解锁", "success");
        this.switchPage("autochess");
        return;
      }
      const left = GM_CLICK_COUNT - gmClicks.length;
      if (!st.unlocked && left <= 3) GM.ui.toast(`再点 ${left} 次解锁卫戍协议 GM`, "info");
    },

    /** 锁定态 UI（导航项样式 + 提示文案） */
    applyLock() {
      const item = GM.qs('.nav__item[data-page="autochess"]');
      const hint = $("acLockHint");
      if (item) {
        item.classList.toggle("is-locked", !st.unlocked);
        item.dataset.locked = st.unlocked ? "0" : "1";
      }
      if (hint) hint.textContent = st.unlocked ? "" : "（连点 5 次解锁）";
    },
  };

  GM.app = app;
  window.app = app;
  window.addEventListener("DOMContentLoaded", () => void app.boot());
  if (document.readyState !== "loading") void app.boot();
})();
