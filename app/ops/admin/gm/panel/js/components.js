"use strict";
/**
 * DoctorateTs GM 面板 · 组件层
 *
 * SearchSelect（可搜索下拉）/ ResponseBox（响应查看器）/ ChipList（附件 chips）/
 * Stats（状态卡网格）。全部为原生 DOM，无第三方依赖。
 */
(function () {
  const GM = window.GM;
  const MAX_ITEMS = 200;

  /**
   * 可搜索下拉选择器
   * @param {HTMLElement} host - 宿主元素（内部清空后挂载）
   * @param {{items?:Array,placeholder?:string,limit?:number,getLabel:Function,getSub?:Function,
   *          getValue?:Function,getSearch?:Function,onSelect?:Function}} options
   * @returns {{setItems:Function,getSelected:Function,setValue:Function,clear:Function,focus:Function}}
   */
  function SearchSelect(host, options) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ss__input";
    input.placeholder = options.placeholder || "搜索…";
    input.autocomplete = "off";
    input.spellcheck = false;
    const menu = document.createElement("div");
    menu.className = "ss__menu";
    menu.hidden = true;
    host.classList.add("ss");
    host.innerHTML = "";
    host.append(input, menu);

    const valueOf = options.getValue || ((item) => item.id);
    const labelOf = options.getLabel || ((item) => String(item.id));
    const searchOf = options.getSearch || ((item) => `${labelOf(item)} ${valueOf(item)}`.toLowerCase());
    let items = options.items || [];
    let filtered = items.slice(0, options.limit || MAX_ITEMS);
    let active = -1;
    let selected = null;

    const close = () => {
      menu.hidden = true;
      active = -1;
    };

    const highlight = () => {
      GM.qsa(".ss__item", menu).forEach((el, index) => el.classList.toggle("is-active", index === active));
      const el = menu.children[active];
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
    };

    const select = (item, silent) => {
      selected = item || null;
      input.value = item ? labelOf(item) : "";
      close();
      if (!silent && options.onSelect) options.onSelect(selected);
    };

    const render = () => {
      if (!filtered.length) {
        menu.innerHTML = `<div class="ss__empty">无匹配项</div>`;
        menu.hidden = false;
        return;
      }
      menu.innerHTML = filtered
        .map((item, index) => {
          const sub = options.getSub ? options.getSub(item) : "";
          return `<div class="ss__item${index === active ? " is-active" : ""}" data-index="${index}">
            <span class="ss__label">${GM.util.escapeHtml(labelOf(item))}</span>
            ${sub ? `<span class="ss__sub">${GM.util.escapeHtml(sub)}</span>` : ""}
          </div>`;
        })
        .join("");
      menu.hidden = false;
    };

    const applyFilter = () => {
      const keyword = input.value.trim().toLowerCase();
      if (!keyword) {
        filtered = items.slice(0, options.limit || MAX_ITEMS);
      } else {
        const hits = [];
        for (const item of items) {
          if (searchOf(item).includes(keyword)) hits.push(item);
          if (hits.length >= (options.limit || MAX_ITEMS)) break;
        }
        filtered = hits;
      }
      active = -1;
      render();
    };

    input.addEventListener("focus", () => {
      filtered = items.slice(0, options.limit || MAX_ITEMS);
      render();
    });
    input.addEventListener("input", () => {
      selected = null;
      applyFilter();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (menu.hidden) render();
        active = Math.max(0, Math.min(filtered.length - 1, active + (event.key === "ArrowDown" ? 1 : -1)));
        highlight();
      } else if (event.key === "Enter") {
        if (!menu.hidden && filtered[active >= 0 ? active : 0]) {
          event.preventDefault();
          select(filtered[active >= 0 ? active : 0]);
        }
      } else if (event.key === "Escape") {
        close();
      }
    });
    menu.addEventListener("mousedown", (event) => {
      const item = event.target.closest(".ss__item");
      if (!item) return;
      event.preventDefault();
      select(filtered[Number(item.dataset.index)]);
    });
    document.addEventListener("click", (event) => {
      if (!host.contains(event.target)) close();
    });

    return {
      setItems(next) {
        items = next || [];
        selected = null;
        input.value = "";
        close();
      },
      getSelected: () => selected,
      setValue(id, silent) {
        const found = items.find((item) => String(valueOf(item)) === String(id));
        if (found) select(found, silent);
        return found || null;
      },
      clear: () => select(null, true),
      focus: () => input.focus(),
    };
  }

  /** 响应查看器：状态着色 + JSON 美化 */
  const ResponseBox = {
    /** 请求中占位 */
    pending(id) {
      const el = GM.$(id);
      if (!el) return;
      el.className = "resp";
      el.textContent = "请求中…";
    },
    /** 展示 POST 结果 */
    show(id, result) {
      const el = GM.$(id);
      if (!el) return;
      el.className = `resp ${result.ok ? "is-ok" : "is-err"}`;
      const head = `HTTP ${result.status} ${result.statusText || ""}`.trim();
      const body = result.json ? JSON.stringify(result.json, null, 2) : result.text;
      el.textContent = `${head}\n${body || "(空响应)"}`;
    },
    /** 展示错误 */
    error(id, message) {
      const el = GM.$(id);
      if (!el) return;
      el.className = "resp is-err";
      el.textContent = String(message);
    },
  };

  /** 附件 / 标签 chips */
  const ChipList = {
    /**
     * @param {string} id - 容器 id
     * @param {Array<{id:string,count?:number,label?:string}>} items
     * @param {Function} [onRemove] - 点击删除回调（传下标）
     * @param {string} [emptyText]
     */
    render(id, items, onRemove, emptyText) {
      const host = GM.$(id);
      if (!host) return;
      if (!items.length) {
        host.innerHTML = `<span class="chips__empty">${GM.util.escapeHtml(emptyText || "无")}</span>`;
        return;
      }
      host.innerHTML = items
        .map(
          (item, index) => `<span class="chip">${GM.util.escapeHtml(item.label || item.id)}${
            item.count !== undefined ? ` ×${item.count}` : ""
          }${onRemove ? `<button class="chip__x" data-index="${index}" title="移除">✕</button>` : ""}</span>`,
        )
        .join("");
      if (onRemove) {
        host.onclick = (event) => {
          const btn = event.target.closest(".chip__x");
          if (btn) onRemove(Number(btn.dataset.index));
        };
      } else {
        host.onclick = null;
      }
    },
  };

  /** 状态卡网格 */
  const Stats = {
    /**
     * @param {string} id - 容器 id
     * @param {Array<{label:string,value:string|number,tone?:string}>} entries
     */
    render(id, entries) {
      const host = GM.$(id);
      if (!host) return;
      host.hidden = false;
      host.innerHTML = entries
        .map(
          (entry) => `<div class="stat${entry.tone ? ` stat--${entry.tone}` : ""}">
            <span class="stat__label">${GM.util.escapeHtml(entry.label)}</span>
            <span class="stat__value">${GM.util.escapeHtml(String(entry.value))}</span>
          </div>`,
        )
        .join("");
    },
    clear(id) {
      const host = GM.$(id);
      if (!host) return;
      host.innerHTML = "";
      host.hidden = true;
    },
  };

  GM.components = { SearchSelect, ResponseBox, ChipList, Stats };
})();
