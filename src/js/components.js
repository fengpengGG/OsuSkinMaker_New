// 可复用 UI 组件：模态框、确认框、文本输入框、设置弹窗。

import { state, persistSettings, emit } from "./state.js";

// -- 可拖拽分隔条 ----------------------------------------------------------

/**
 * 在水平 flex 容器 parent 的 left/right 之间插入一个垂直分隔条，
 * 支持按住拖动调整两侧宽度。
 * 布局持久化：传入 ratioKey 时按「左侧占比」存入 settings.json
 * （与原项目 PanedWindow sash 相对比例一致），窗口尺寸变化时自动按比例伸缩。
 * @param {HTMLElement} parent  水平 flex 容器
 * @param {HTMLElement} left    左栏（拖动时将其固定为像素宽度，right 自适应）
 * @param {HTMLElement} right   右栏（占剩余空间）
 * @returns {{ setWidth: (px:number)=>void, bar: HTMLElement }}
 */
export function makeSplitter(parent, left, right, {
  minLeft = 160, minRight = 200, initial = null, persistKey = null, ratioKey = null,
} = {}) {
  const bar = document.createElement("div");
  bar.className = "splitter splitter-v";
  bar.title = "拖拽调整宽度";

  // 读取持久化比例（settings.json 优先，旧 localStorage 值兜底）
  let ratio = null;
  if (ratioKey) {
    const r = state.settings[ratioKey];
    if (typeof r === "number" && r > 0 && r < 1) ratio = r;
  }

  const apply = (px, save = false) => {
    if (!parent.clientWidth) return;
    const max = Math.max(minLeft + 1, parent.clientWidth - minRight);
    const w = Math.max(minLeft, Math.min(max, Math.round(px)));
    left.style.flex = `0 0 ${w}px`;
    left.style.width = w + "px";
    if (save) {
      if (persistKey) {
        try { localStorage.setItem(persistKey, String(w)); } catch (_e) { /* 忽略 */ }
      }
      if (ratioKey) {
        ratio = w / parent.clientWidth;
        state.settings[ratioKey] = Math.max(0.05, Math.min(0.95, ratio));
        persistSettings();
      }
    }
  };

  const applyRatio = () => {
    if (ratio && parent.clientWidth) apply(ratio * parent.clientWidth, false);
  };

  // 初始宽度：比例 > localStorage > 传入值 > 当前实际宽 > 默认（布局稳定后再定）
  const restore = () => {
    if (left.style.flex) return;
    if (ratio && parent.clientWidth) { applyRatio(); return; }
    let w = null;
    if (persistKey) { try { w = parseFloat(localStorage.getItem(persistKey)); } catch (_e) {} }
    if (!w && initial != null) w = initial;
    if (!w) w = left.getBoundingClientRect().width || Math.round(parent.clientWidth * 0.6);
    if (!w) w = 360;
    apply(w, false);
  };
  if (parent.clientWidth) restore();
  else requestAnimationFrame(() => { if (parent.clientWidth) restore(); });

  parent.insertBefore(bar, right);

  let dragging = false, startX = 0, startLeft = 0;
  const onMove = (e) => { if (dragging) apply(startLeft + (e.clientX - startX), false); };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing-col");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    // 拖拽结束：保存当前比例
    apply(left.getBoundingClientRect().width, true);
  };
  bar.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startLeft = left.getBoundingClientRect().width;
    document.body.classList.add("resizing-col");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
  // 双击分隔条回到初始均衡
  bar.addEventListener("dblclick", () => apply(initial != null ? initial : 0.6 * parent.clientWidth, true));

  // 容器尺寸变化（窗口缩放/右侧面板变宽）时按比例自适应，保证布局比例稳定
  if (ratioKey && ratio) {
    const ro = new ResizeObserver(() => {
      if (!dragging && parent.clientWidth) applyRatio();
    });
    ro.observe(parent);
  }

  return { setWidth: apply, bar };
}

// -- 通用模态框 ------------------------------------------------------------

export function modal({ title = "", bodyEl, width = 460, maxHeight = "90vh" }) {
  const root = document.getElementById("modal-root");
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";

  const box = document.createElement("div");
  box.className = "modal-box";
  box.style.width = width + "px";
  if (maxHeight) box.style.maxHeight = maxHeight;

  const head = document.createElement("div");
  head.className = "modal-head";
  const titleEl = document.createElement("div");
  titleEl.className = "modal-title";
  titleEl.textContent = title;
  head.appendChild(titleEl);

  const body = document.createElement("div");
  body.className = "modal-body";

  box.appendChild(head);
  box.appendChild(body);
  if (bodyEl) body.appendChild(bodyEl);
  overlay.appendChild(box);
  root.appendChild(overlay);

  let _resolvedClose = null;
  const close = () => {
    overlay.remove();
    if (_resolvedClose) _resolvedClose();
  };
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  return { el: box, body, close, onClosed: () => new Promise((r) => (_resolvedClose = r)) };
}

export function confirmDialog({ title = "确认", text = "", okText = "确定" }) {
  const wrap = document.createElement("div");
  wrap.className = "modal-scroll";
  const p = document.createElement("div");
  p.className = "modal-text";
  p.textContent = text;
  const row = document.createElement("div");
  row.className = "modal-actions";
  const cancel = document.createElement("button");
  cancel.className = "btn btn-tool";
  cancel.textContent = "取消";
  const ok = document.createElement("button");
  ok.className = "btn btn-accent";
  ok.textContent = okText;
  row.append(cancel, ok);
  wrap.append(p, row);

  const m = modal({ title, bodyEl: wrap, width: 400 });
  return new Promise((resolve) => {
    cancel.onclick = () => { m.close(); resolve(false); };
    ok.onclick = () => { m.close(); resolve(true); };
  });
}

export function promptText({ title = "输入", label = "", initial = "", placeholder = "" }) {
  const wrap = document.createElement("div");
  wrap.className = "modal-scroll";
  const lab = document.createElement("label");
  lab.className = "modal-label";
  lab.textContent = label;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "text-input";
  input.value = initial;
  input.placeholder = placeholder;
  const row = document.createElement("div");
  row.className = "modal-actions";
  const cancel = document.createElement("button");
  cancel.className = "btn btn-tool";
  cancel.textContent = "取消";
  const ok = document.createElement("button");
  ok.className = "btn btn-accent";
  ok.textContent = "确定";
  ok.disabled = !initial;
  input.addEventListener("input", () => {
    ok.disabled = !input.value.trim();
  });
  row.append(cancel, ok);
  wrap.append(lab, input, row);

  const m = modal({ title, bodyEl: wrap, width: 420 });
  input.focus();
  input.select();
  return new Promise((resolve) => {
    const done = (val) => { m.close(); resolve(val); };
    cancel.onclick = () => done(null);
    ok.onclick = () => done(input.value.trim());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) done(input.value.trim());
    });
  });
}

// 通用通知 toast（短提示，自动消失）
export function toast(text, kind = "success") {
  let host = document.getElementById("toast-root");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast-root";
    host.className = "toast-root";
    document.body.appendChild(host);
  }
  const t = document.createElement("div");
  t.className = "toast " + kind;
  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.textContent = kind === "error" ? "✕" : kind === "info" ? "ℹ" : "✓";
  const txt = document.createElement("span");
  txt.textContent = text;
  t.appendChild(icon);
  t.appendChild(txt);
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, 2600);
}

// -- 单选组 / 复选 辅助 ----------------------------------------------------

function radioGroup(name, options, value, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "opt-row";
  for (const [val, label] of options) {
    const lab = document.createElement("label");
    lab.className = "opt";
    const inp = document.createElement("input");
    inp.type = "radio";
    inp.name = name;
    inp.value = val;
    inp.checked = String(value) === String(val);
    inp.addEventListener("change", () => onChange(val));
    const span = document.createElement("span");
    span.textContent = label;
    lab.append(inp, span);
    wrap.appendChild(lab);
  }
  return wrap;
}

function checkBox(label, checked, onChange) {
  const lab = document.createElement("label");
  lab.className = "opt checkbox";
  const inp = document.createElement("input");
  inp.type = "checkbox";
  inp.checked = checked;
  inp.addEventListener("change", () => onChange(inp.checked));
  const span = document.createElement("span");
  span.textContent = label;
  lab.append(inp, span);
  return lab;
}

function card(title, desc, children) {
  const c = document.createElement("div");
  c.className = "settings-card";
  const t = document.createElement("div");
  t.className = "settings-card-title";
  t.textContent = title;
  const d = document.createElement("div");
  d.className = "settings-card-desc";
  d.textContent = desc;
  c.append(t, d);
  for (const ch of children) c.appendChild(ch);
  return c;
}

// -- 设置弹窗 --------------------------------------------------------------

export function openSettings() {
  const s = state.settings;
  const scroll = document.createElement("div");
  scroll.className = "modal-scroll";

  const markChange = async () => {
    await persistSettings();
    emit("settings:changed");
  };

  // 主题
  scroll.appendChild(card("主题", "界面配色方案",
    [radioGroup("theme", [["light", "浅色"], ["dark", "深色"]], s.theme, async (v) => {
      state.settings.theme = v;
      emit("theme:changed", v);
      await markChange();
    })]));

  // 编辑 skin.ini 的方式
  const folderRow = document.createElement("div");
  folderRow.className = "settings-card-desc";
  const folderInput = document.createElement("input");
  folderInput.type = "text";
  folderInput.className = "text-input inline";
  folderInput.value = s.ini_import_folder;
  folderInput.addEventListener("change", async () => {
    state.settings.ini_import_folder = folderInput.value.trim() || "mania";
    folderInput.value = state.settings.ini_import_folder;
    await markChange();
  });
  folderRow.append("复制到 skin 根目录下的此文件夹：", folderInput);
  scroll.appendChild(card("编辑方式", "点击“浏览”选择素材后的处理方式", [
    radioGroup("ini_import_mode",
      [["path", "直接导入路径"], ["copy", "复制到文件夹"]],
      s.ini_import_mode,
      async (v) => { state.settings.ini_import_mode = v; await markChange(); }),
    folderRow,
  ]));

  // 导入素材 @2x 策略
  scroll.appendChild(card("导入素材", "添加/替换组件时默认如何处理 @2x", [
    radioGroup("hd_default",
      [["hd", "@2x"], ["normal", "原图"], ["ask", "自行确认"]],
      s.hd_default,
      async (v) => { state.settings.hd_default = v; await markChange(); }),
  ]));

  // 预览显示
  scroll.appendChild(card("预览显示", "游玩预览中缺失组件的显示与交互方式", [
    checkBox("缺失的组件显示默认组件", s.show_default, async (v) => {
      state.settings.show_default = v; await markChange();
    }),
    checkBox("点击预览中的组件联动选中元素管理中的对应元素", s.click_select, async (v) => {
      state.settings.click_select = v; await markChange();
    }),
    checkBox("元素管理按当前预览界面分类显示", s.enable_category, async (v) => {
      state.settings.enable_category = v; await markChange();
    }),
  ]));

  const m = modal({ title: "设置", bodyEl: scroll, width: 620 });
  return m;
}