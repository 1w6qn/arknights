"use strict";
/**
 * DoctorateTs GM 面板 · 核心层
 *
 * 提供：全局状态、localStorage 持久化、HTTP 客户端（/gm/* 引导 + /admin/<op> 操作）、
 * Toast / 确认弹窗 / 教程弹窗 / 顶部进度条等通用 UI 原语。
 * 契约与归档服务端 GM 面板一致：引导走 GET /gm/*，操作走 POST /admin/<op>（X-Admin-Token）。
 */
(function () {
  const GM = (window.GM = window.GM || {});
  const $ = (id) => document.getElementById(id);

  GM.$ = $;
  GM.qs = (selector, root) => (root || document).querySelector(selector);
  GM.qsa = (selector, root) => Array.from((root || document).querySelectorAll(selector));

  /** 全局状态 */
  GM.state = {
    /** 管理令牌 */
    token: "",
    /** `/gm/data` 引导数据 */
    data: null,
    /** 全部账号 uid */
    players: [],
    /** 当前选中的玩家 uid */
    player: "",
    /** 邮件附件（{id,count}） */
    attachments: [],
    /** 当前页 */
    page: "char",
    /** 卫戍协议是否已解锁 */
    unlocked: false,
    /** 战局状态自动刷新定时器 */
    acTimer: null,
  };

  /** localStorage 持久化（隐私模式下静默失败） */
  GM.storage = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(`doctorate-gm:${key}`);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (error) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(`doctorate-gm:${key}`, JSON.stringify(value));
      } catch (error) {
        /* 隐私模式/配额：忽略 */
      }
    },
  };

  /** 通用工具 */
  GM.util = {
    escapeHtml(text) {
      return String(text == null ? "" : text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    },
    num(id) {
      const raw = String($(id) ? $(id).value : "").trim();
      if (!raw) return undefined;
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    },
    text(id) {
      return String($(id) ? $(id).value : "").trim();
    },
    fmt(value) {
      return new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
    },
    prettyJson(text) {
      try {
        return JSON.stringify(JSON.parse(text), null, 2);
      } catch (error) {
        return String(text);
      }
    },
    async copy(text) {
      try {
        await navigator.clipboard.writeText(String(text));
        GM.ui.toast("已复制到剪贴板");
      } catch (error) {
        GM.ui.toast(`复制失败：${error.message || error}`, "error");
      }
    },
  };

  /** 从响应文本中挑出可读错误（detail / message / error） */
  function pickDetail(text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        return String(parsed.detail || parsed.message || parsed.error || "");
      }
    } catch (error) {
      /* 非 JSON */
    }
    return "";
  }

  /** HTTP 客户端 */
  GM.api = {
    /** GET /gm/*（带令牌头，便于开启 admin.allowRemote 后远程使用） */
    async getJson(path) {
      const res = await fetch(path, {
        headers: GM.state.token ? { "X-Admin-Token": GM.state.token } : {},
      });
      const text = await res.text();
      if (!res.ok) throw new Error(pickDetail(text) || `HTTP ${res.status}`);
      return text ? JSON.parse(text) : {};
    },

    /**
     * POST /admin/<op>
     * @returns {{ok:boolean,status:number,statusText:string,text:string,json:object|null,detail:string}}
     */
    async post(op, body) {
      const res = await fetch(`/admin/${op}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Token": GM.state.token },
        body: body === undefined ? null : JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (error) {
        json = null;
      }
      const detail = (json && (json.detail || json.message)) || pickDetail(text) || "";
      return { ok: res.ok, status: res.status, statusText: res.statusText, text, json, detail };
    },
  };

  /* ------------------------------ UI 原语 ------------------------------ */

  GM.ui = {
    /** 顶部进度条 */
    progress(on) {
      const bar = $("progress");
      if (bar) bar.hidden = !on;
    },

    /** 连接状态 */
    online(ok, text) {
      const conn = $("conn");
      if (!conn) return;
      conn.classList.toggle("is-online", Boolean(ok));
      conn.classList.toggle("is-offline", !ok);
      $("connText").textContent = text;
    },

    /** Toast（可堆叠，3.2s 自动消失） */
    toast(message, kind) {
      const wrap = $("toastWrap");
      if (!wrap) return;
      const el = document.createElement("div");
      el.className = `toast toast--${kind || "info"}`;
      el.innerHTML = `<b>${kind === "error" ? "失败" : kind === "success" ? "成功" : "提示"}</b><span>${GM.util.escapeHtml(message)}</span>`;
      wrap.appendChild(el);
      requestAnimationFrame(() => el.classList.add("is-show"));
      setTimeout(() => {
        el.classList.remove("is-show");
        setTimeout(() => el.remove(), 250);
      }, 3200);
    },

    /**
     * 确认弹窗
     * @param {{title?:string,body:string,danger?:boolean,confirmWord?:string,okText?:string}} options
     * @returns {Promise<boolean>}
     */
    confirm(options) {
      const modal = $("modal");
      const okBtn = $("modalOk");
      const wordField = $("modalWordField");
      const wordInput = $("modalWord");
      return new Promise((resolve) => {
        $("modalTitle").textContent = options.title || "确认操作";
        $("modalBody").textContent = options.body || "";
        okBtn.textContent = options.okText || "确认执行";
        okBtn.classList.toggle("btn--danger", Boolean(options.danger));
        okBtn.classList.toggle("btn--primary", !options.danger);
        const needWord = Boolean(options.confirmWord);
        wordField.hidden = !needWord;
        wordInput.value = "";
        okBtn.disabled = needWord;
        if (needWord) {
          $("modalWordLabel").textContent = `输入「${options.confirmWord}」以确认`;
          wordInput.oninput = () => {
            okBtn.disabled = wordInput.value.trim() !== options.confirmWord;
          };
        }
        modal.hidden = false;
        const done = (value) => {
          modal.hidden = true;
          okBtn.onclick = null;
          $("modalCancel").onclick = null;
          wordInput.oninput = null;
          GM.qsa("[data-close]", modal).forEach((el) => (el.onclick = null));
          document.removeEventListener("keydown", onKey);
          resolve(value);
        };
        const onKey = (event) => {
          if (event.key === "Escape") done(false);
          if (event.key === "Enter" && !okBtn.disabled) done(true);
        };
        okBtn.onclick = () => done(true);
        $("modalCancel").onclick = () => done(false);
        GM.qsa("[data-close]", modal).forEach((el) => (el.onclick = () => done(false)));
        document.addEventListener("keydown", onKey);
        if (needWord) wordInput.focus();
      });
    },

    /**
     * 教程弹窗（分步）
     * @param {{title:string,steps:string[],onDone?:Function}} options
     */
    tutorial(options) {
      const modal = $("tutorial");
      const steps = options.steps || [];
      let index = 0;
      const render = () => {
        $("tutTitle").textContent = options.title || "使用教程";
        $("tutBody").innerHTML = steps[index] || "";
        $("tutStep").textContent = `${index + 1} / ${steps.length}`;
        $("tutPrev").disabled = index === 0;
        $("tutNext").textContent = index === steps.length - 1 ? "我知道了" : "下一步";
      };
      const close = () => {
        modal.hidden = true;
        GM.qsa("[data-close]", modal).forEach((el) => (el.onclick = null));
        $("tutPrev").onclick = null;
        $("tutNext").onclick = null;
        if (options.onDone) options.onDone();
      };
      $("tutPrev").onclick = () => {
        index = Math.max(0, index - 1);
        render();
      };
      $("tutNext").onclick = () => {
        if (index === steps.length - 1) {
          close();
          return;
        }
        index += 1;
        render();
      };
      GM.qsa("[data-close]", modal).forEach((el) => (el.onclick = close));
      render();
      modal.hidden = false;
    },
  };
})();
