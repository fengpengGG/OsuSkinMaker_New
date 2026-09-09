// skin.ini 表单编辑器（与 Python 版 Form / ManiaEditor 逻辑一致）。
// 子标签页：General / Colours / Fonts / Mania；字段变化实时写入 state.ini 并触发预览刷新。

import { state, emit, on, rescanSkin, loadIni } from "./state.js";
import { invoke, assetUrl, backendAvailable } from "./api.js";
import {
  GENERAL_COMMANDS, COLOUR_COMMANDS, FONT_COMMANDS,
  MANIA_COMMANDS, MANIA_COLUMN_COMMANDS, NOTE_LAYOUT,
  findManiaSection, Section,
} from "./skin_ini.js";
import { strip_hd } from "./manager.js";
import { confirmDialog, toast } from "./components.js";

// 数字字体后缀（copy 模式复制同组字体用）
const FONT_SUFFIXES = new Set([
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "comma", "dot", "percent", "x",
]);

const _t = {
  tabs: {}, // tabName -> 子标签按钮
  fields: {}, // tabName -> [Field]
  keysVar: "4", // Mania 当前键数
  maniaFields: [], // Mania 标量 + 列字段
  animHighlight: null,
};

// ---------------------------------------------------------------------------
// 渲染入口
// ---------------------------------------------------------------------------

export function renderIniTab() {
  const host = document.getElementById("ini-tab");
  host.innerHTML = "";
  host.className = "tab-body hidden";

  const nav = document.createElement("div");
  nav.className = "tabs sub-tabs";
  const bodyWrap = document.createElement("div");
  bodyWrap.className = "ini-tab-bodies";

  for (const name of ["general", "colours", "fonts", "mania"]) {
    const b = document.createElement("button");
    b.className = "tab" + (name === "general" ? " active" : "");
    b.dataset.subtab = name;
    b.textContent = { general: "General", colours: "Colours", fonts: "Fonts", mania: "Mania" }[name];
    b.addEventListener("click", () => _switchSubTab(name));
    nav.appendChild(b);

    const body = document.createElement("div");
    body.className = "ini-tab-body" + (name === "general" ? " active" : "");
    body.id = "ini-sub-" + name;
    bodyWrap.appendChild(body);
  }

  host.appendChild(nav);
  host.appendChild(bodyWrap);

  _buildGeneral();
  _buildColours();
  _buildFonts();
  _buildMania();
  reloadAll();

  // 元素管理双击缺失元素 → 跳到对应字段
  on("jump-to-ini", jumpToField);
  // 皮肤打开/重新扫描后，skin.ini 内容可能更新，重新载入全部字段
  on("skin:reloaded", reloadAll);
  // 仅"打开皮肤"才重置键数为 4K（对齐原项目硬约束）；"重新扫描 skin.ini" 应保留当前键数
  on("skin:opened", () => {
    _t.keysVar = "4";
    reloadAll();
  });
}

export function refreshIni() {
  reloadAll();
}

function _switchSubTab(name) {
  document.querySelectorAll('#ini-tab .sub-tabs .tab').forEach((b) => {
    b.classList.toggle("active", b.dataset.subtab === name);
  });
  document.querySelectorAll("#ini-tab .ini-tab-body").forEach((body) => {
    body.classList.toggle("active", body.id === "ini-sub-" + name);
  });
}

// ---------------------------------------------------------------------------
// 字段控件构建
// ---------------------------------------------------------------------------

// 渲染一个命令字段，返回 { key, row, getter, set, save, focus, original }
function _buildField(container, cmd, getter, setter) {
  const row = document.createElement("div");
  row.className = "field-row";
  row.dataset.key = cmd.key;
  container.appendChild(row); // 挂到父容器，否则字段控件永远不显示

  const label = document.createElement("span");
  label.className = "field-label";
  label.textContent = cmd.label;
  label.title = cmd.help || "";
  row.appendChild(label);

  const ctrl = document.createElement("div");
  ctrl.className = "field-ctrl";
  row.appendChild(ctrl);

  const reset = document.createElement("button");
  reset.className = "btn btn-tool reset-btn";
  reset.textContent = "↺";
  reset.title = "恢复为该字段加载时的原始值";
  row.appendChild(reset);

  const field = { key: cmd.key, row, getter, original: null };
  let scale = null; // int 字段的拉条（值需与文本框/字段值双向同步）

  const onChanged = () => {
    if (_loading) return;
    state.dirty = true;
    emit("ini:changed");
  };
  const commit = (v) => {
    const val = _valueFor(cmd, v);
    // setter 内部处理空值→删除该行（osu 对空值行报 Value is empty）
    setter(cmd.key, val);
    onChanged();
  };

  // 复原到"修改前/已保存"的原值。单字段 ↺ 与"重置所有"共用。
  // 注意：不复用 loadFields（那会重读当前值覆盖 original），才能保留复原基准。
  field._commit = commit;
  field.reset = () => {
    if (field.original != null) {
      field.set(field.original);
      field._commit(field.original);
    }
  };

  if (cmd.type === "bool") {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    ctrl.appendChild(cb);
    field.set = (v) => { cb.checked = ["1", "true", "yes"].includes(String(v)); };
    field.setValue = field.set;
    field.focus = () => cb.focus();
    cb.addEventListener("change", () => commit(cb.checked ? "1" : "0"));
    reset.addEventListener("click", field.reset);
    return field;
  }

  if (cmd.type === "choice") {
    const sel = document.createElement("select");
    sel.className = "text-input field-select";
    for (const c of cmd.choices) {
      const o = document.createElement("option");
      o.value = c.split("=", 1)[0].trim();
      o.textContent = c;
      sel.appendChild(o);
    }
    ctrl.appendChild(sel);
    field.set = (v) => { sel.value = String(v == null ? "" : v).split("=", 1)[0].trim(); };
    field.setValue = field.set;
    field.focus = () => sel.focus();
    sel.addEventListener("change", () => commit(sel.value));
    reset.addEventListener("click", field.reset);
    return field;
  }

  const input = document.createElement("input");
  input.type = "text";
  input.className = "text-input field-input";

  // 颜色预览色块：函数级作用域，供 rgb/rgba 分支与 field.set 共用
  let swatch = null;      // 棋盘格底
  let swatchColor = null; // 半透明色层（alpha 可视化）
  let pickerEl = null;    // 透明覆盖在色块上的 color-picker（点击色块直接调色）
  let alphaScale = null;  // rgba 的 alpha 滑条
  const applySwatch = (v) => {
    const m = String(v).match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(\d+))?/);
    if (swatchColor) {
      // 棋盘格底 + rgba 半透明色层：直观体现 alpha
      const a = m && m[4] != null ? Math.max(0, Math.min(255, parseInt(m[4], 10))) / 255 : 1;
      swatchColor.style.background = m ? `rgba(${m[1]},${m[2]},${m[3]},${a})` : "transparent";
    }
    if (pickerEl) {
      if (m) {
        const toHex = (n) => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, "0");
        pickerEl.value = `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`;
      } else {
        pickerEl.value = "#000000";
      }
    }
  };

  if (cmd.type === "rgb" || cmd.type === "rgba") {
    input.className += " field-color-input";
    swatch = document.createElement("span");
    swatch.className = "swatch";
    swatchColor = document.createElement("span");
    swatchColor.className = "swatch-color";
    // 色块容器：swatch 上覆盖透明 color-picker，点击色块直接进入系统调色板（rgb 与 rgba 一致）
    const wrap = document.createElement("span");
    wrap.className = "swatch-wrap";
    pickerEl = document.createElement("input");
    pickerEl.type = "color";
    pickerEl.className = "color-picker";
    pickerEl.addEventListener("input", () => {
      const h = pickerEl.value.replace("#", "");
      const rgb = `${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)}`;
      if (cmd.type === "rgba") {
        // 调色只改 RGB，保留第 4 位 alpha（若存在）
        const parts = String(input.value).split(",").map((s) => s.trim());
        const a = parts.length >= 4 ? parts[3] : "255";
        input.value = `${rgb},${a}`;
        if (alphaScale) {
          const na = parseInt(a, 10);
          if (!Number.isNaN(na)) alphaScale.value = Math.max(0, Math.min(255, na));
        }
      } else {
        input.value = rgb;
      }
      applySwatch(input.value);
      commit(input.value);
    });
    if (cmd.type === "rgba") {
      // alpha 滑条：拖动中（input）只实时同步文本+色块；松手（change）才 commit 写 ini，
      // 避免拖动中频繁触发 ini:changed → 预览重绘打断 range 拖动（端点处会"卡住"）
      alphaScale = document.createElement("input");
      alphaScale.type = "range";
      alphaScale.min = 0; alphaScale.max = 255;
      alphaScale.className = "field-alpha";
      alphaScale.title = "透明度 (0-255)";
      const syncAlpha = () => {
        const parts = String(input.value).split(",").map((s) => s.trim());
        while (parts.length < 3) parts.push("0");
        parts[3] = alphaScale.value;
        input.value = parts.join(",");
        applySwatch(input.value);
      };
      alphaScale.addEventListener("input", syncAlpha);
      alphaScale.addEventListener("change", () => {
        syncAlpha();
        commit(input.value);
      });
    }
    wrap.appendChild(swatch);
    swatch.appendChild(swatchColor);
    wrap.appendChild(pickerEl);
    input.addEventListener("input", () => applySwatch(input.value));
    applySwatch(getter(cmd.key));
    ctrl.appendChild(input);
    ctrl.appendChild(wrap);
    if (alphaScale) ctrl.appendChild(alphaScale);
  } else if (cmd.type === "int" || cmd.type === "number") {
    input.className += " field-num-input";
    scale = document.createElement("input");
    scale.type = "range";
    scale.min = 0; scale.max = 1000;
    scale.className = "field-scale";
    input.addEventListener("input", () => {
      const v = parseFloat(input.value);
      if (!Number.isNaN(v)) scale.value = Math.max(0, Math.min(1000, v));
    });
    scale.addEventListener("input", () => {
      input.value = String(scale.value);
      commit(input.value);
    });
    ctrl.appendChild(input);
    ctrl.appendChild(scale);
  } else {
    ctrl.appendChild(input);
  }

  // 图片 / 字体前缀字段：浏览按钮（皮肤未打开时点击会提示）
  if (cmd.type === "image" || cmd.type === "fontprefix") {
    const browse = document.createElement("button");
    browse.className = "btn btn-tool field-btn";
    browse.textContent = "浏览";
    browse.addEventListener("click", () => _browseFile(cmd, input));
    ctrl.appendChild(browse);
  }

  field.set = (v) => {
    input.value = v == null ? "" : String(v);
    // 颜色字段：同步色块（皮肤加载 / ↺ 重置 / 重置所有 / 还原外部值均需色块跟随）
    if (cmd.type === "rgb" || cmd.type === "rgba") {
      applySwatch(input.value);
      if (alphaScale) {
        const parts = String(v).split(",").map((s) => s.trim());
        const a = parseInt(parts[3], 10);
        if (!Number.isNaN(a)) alphaScale.value = Math.max(0, Math.min(255, a));
      }
    }
    // 同步拉条位置（加载 / ↺ 重置 / 重置所有 / 还原外部值均需拉条跟随字段值）
    if (scale) {
      const n = parseFloat(v);
      if (!Number.isNaN(n)) {
        scale.value = Math.max(scale.min, Math.min(scale.max, n));
      }
    }
  };
  field.setValue = field.set;
  field.focus = () => input.focus();
  input.addEventListener("input", () => {
    state.dirty = true;
    emit("ini:changed");
    commit(input.value); // 实时写入 ini（同 Python 版 var.trace）
  });
  reset.addEventListener("click", field.reset);
  return field;
}

function _valueFor(cmd, text) {
  const v = String(text == null ? "" : text).trim();
  if (cmd.type === "choice") return v.split("=", 1)[0].trim();
  return v;
}

// 渲染一组命令到容器，返回字段列表
function _buildForm(container, cmds, getter, setter, isMania = false) {
  const fields = [];
  for (const cmd of cmds) {
    const f = _buildField(container, cmd, getter, setter, isMania);
    fields.push(f);
  }
  return fields;
}

// ---------------------------------------------------------------------------
// 各子标签页
// ---------------------------------------------------------------------------

let _loading = false;

function _getterOf(sectionName) {
  return (k) => state.ini.get(sectionName, k);
}
function _setterOf(sectionName) {
  // 空值保存=删除该行：osu 对"键存在但值为空"的行报 "Value is empty"。
  // 对 text 字段（如 Name）留空也统一走删行——回退到无该字段，同样是"清空成功"。
  return (k, v) => {
    if (String(v) === "") state.ini.del(sectionName, k);
    else state.ini.set(sectionName, k, v);
  };
}

// 获取（不存在则创建）指定键数的 Mania section。Mania setter 与 saveAll 复用，避免重复逻辑。
function _ensureMania(keys) {
  let sec = findManiaSection(state.ini, keys);
  if (!sec) {
    sec = new Section("Mania");
    sec.set("Keys", String(keys));
    state.ini.sections.push(sec);
  }
  return sec;
}

// 顶层工具条：每个子标签顶部放置"重置所有" + "重新扫描 skin.ini"（与 Mania 区域一致）。
// 行为：重置所有=把本区所有字段复原到"修改前/已保存"的原值（undo，不复读文件）。
//       重新扫描=从磁盘重读 skin.ini，覆盖当前编辑并刷新所有字段。
// 两者本质不同：前者撤销本次编辑，后者让程序与磁盘文件重新一致。
// 复原一组字段到各自的 original（单字段 ↺ 的批量版）。
function _resetAll(fields) {
  for (const f of fields || []) {
    if (f && typeof f.reset === "function") f.reset();
  }
}
function _appendSectionTop(host, fields) {
  const bar = document.createElement("div");
  bar.className = "section-top";
  const reset = document.createElement("button");
  reset.className = "btn btn-tool";
  reset.textContent = "重置所有";
  reset.title = "撤销本区所有修改，复原为修改前/已保存的值";
  reset.addEventListener("click", () => _resetAll(fields));
  const rescanIni = document.createElement("button");
  rescanIni.className = "btn btn-tool btn-scan";
  rescanIni.textContent = "重新扫描 skin.ini";
  rescanIni.title = "从磁盘重新读取 skin.ini，覆盖当前编辑并刷新所有字段（避免手动修改后程序识别不出来）";
  rescanIni.addEventListener("click", () => {
    // loadIni 只解析；补发 skin:reloaded 让字段/预览/面板按新 ini 值刷新
    loadIni()
      .then(() => emit("skin:reloaded"))
      .catch((e) => toast("重新扫描失败：" + e.message, "error"));
  });
  bar.append(reset, rescanIni);
  host.insertBefore(bar, host.firstChild);
}

function _buildGeneral() {
  const host = document.getElementById("ini-sub-general");
  const grid = document.createElement("div");
  grid.className = "form-grid";
  host.appendChild(grid);
  _t.fields.general = _buildForm(grid, GENERAL_COMMANDS, _getterOf("General"), _setterOf("General"));
  _appendSectionTop(host, _t.fields.general);
}

function _buildColours() {
  const host = document.getElementById("ini-sub-colours");
  const grid = document.createElement("div");
  grid.className = "form-grid";
  host.appendChild(grid);
  _t.fields.colours = _buildForm(grid, COLOUR_COMMANDS, _getterOf("Colours"), _setterOf("Colours"));
  _appendSectionTop(host, _t.fields.colours);
}

function _buildFonts() {
  const host = document.getElementById("ini-sub-fonts");
  const grid = document.createElement("div");
  grid.className = "form-grid";
  host.appendChild(grid);
  _t.fields.fonts = _buildForm(grid, FONT_COMMANDS, _getterOf("Fonts"), _setterOf("Fonts"));
  _appendSectionTop(host, _t.fields.fonts);
}

// Mania：键数选择 + 标量 + 每列
function _buildMania() {
  const host = document.getElementById("ini-sub-mania");
  host.innerHTML = "";

  const top = document.createElement("div");
  top.className = "mania-top";
  const lab = document.createElement("span");
  lab.className = "field-label";
  lab.textContent = "键数:";
  const keysSel = document.createElement("select");
  keysSel.className = "text-input field-select mania-keys";
  for (const k of Object.keys(NOTE_LAYOUT)) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = k;
    keysSel.appendChild(o);
  }
  keysSel.value = _t.keysVar;
  keysSel.addEventListener("change", () => {
    _t.keysVar = keysSel.value;
    _rebuildManiaBody();
    emit("ini:changed"); // 通知游玩预览按新键数重绘（与原项目 keys_var 切换 reload 一致）
  });
  const resetAll = document.createElement("button");
  resetAll.className = "btn btn-tool";
  resetAll.textContent = "重置所有";
  resetAll.title = "撤销 Mania 区所有修改，复原为修改前/已保存的值";
  resetAll.addEventListener("click", () => _resetAll(_t.maniaFields));
  const rescanIni = document.createElement("button");
  rescanIni.className = "btn btn-tool btn-scan";
  rescanIni.textContent = "重新扫描 skin.ini";
  rescanIni.title = "从磁盘重新读取 skin.ini，覆盖当前编辑并刷新所有字段（避免手动修改后程序识别不出来）";
  rescanIni.addEventListener("click", () => {
    loadIni()
      .then(() => emit("skin:reloaded"))
      .catch((e) => toast("重新扫描失败：" + e.message, "error"));
  });
  top.append(lab, keysSel, resetAll, rescanIni);
  host.appendChild(top);

  const body = document.createElement("div");
  body.className = "mania-body";
  body.id = "mania-body";
  host.appendChild(body);
  _rebuildManiaBody();
}

function _rebuildManiaBody() {
  const body = document.getElementById("mania-body");
  if (!body) return;
  body.innerHTML = "";
  _t.maniaFields = [];

  const keys = parseInt(_t.keysVar, 10);
  const getterSec = findManiaSection(state.ini, keys);
  const getter = (k) => (getterSec ? getterSec.get(k) : null);
  const setter = (k, v) => {
    const sec = _ensureMania(keys);
    if (String(v) === "") sec.del(k); // 空值删行，避免 osu 报 Value is empty
    else sec.set(k, v);
  };

  // 布局与外观
  const title1 = document.createElement("div");
  title1.className = "section-title";
  title1.textContent = "布局与外观";
  body.appendChild(title1);

  const scalarCmds = MANIA_COMMANDS.filter((c) => c.key !== "Keys");
  const grid = document.createElement("div");
  grid.className = "form-grid";
  body.appendChild(grid);
  _t.maniaFields.push(..._buildForm(grid, scalarCmds, getter, setter, true));

  // 每列设置
  const title2 = document.createElement("div");
  title2.className = "section-title";
  title2.textContent = "每列设置";
  body.appendChild(title2);

  const layout = NOTE_LAYOUT[keys] || Array(keys).fill("1");
  for (let n0 = 0; n0 < keys; n0++) {
    const n1 = n0 + 1;
    const note = layout[n0];
    const lf = document.createElement("div");
    lf.className = "column-card";
    const lfTitle = document.createElement("div");
    lfTitle.className = "column-card-title";
    lfTitle.textContent = `第 ${n1} 列（默认音符 note${note}）`;
    lf.appendChild(lfTitle);
    const cgrid = document.createElement("div");
    cgrid.className = "form-grid";
    lf.appendChild(cgrid);
    body.appendChild(lf);

    const concrete = MANIA_COLUMN_COMMANDS.map((c) => ({
      key: c.key.replace(/\{n0\}/g, n0).replace(/\{n1\}/g, n1),
      type: c.type,
      label: c.label.replace(/\{n0\}/g, n0).replace(/\{n1\}/g, n1),
      default: c.default,
      help: c.help,
    }));
    _t.maniaFields.push(..._buildForm(cgrid, concrete, getter, setter, true));
  }

  // 还原当前键数值
  document.querySelectorAll(".mania-keys option").forEach((o) => {
    o.selected = o.value === String(keys);
  });
  loadFields(_t.maniaFields);
}

// ---------------------------------------------------------------------------
// load / save
// ---------------------------------------------------------------------------

// 载入字段（从 state.ini 取值，schema 默认值兜底）。
// 仅当 captureOriginal=true（真正的加载/重读场景）才把 original 更新为当前值，
// 作为 ↺ 重置的"复原基准"。重置/重扫等不该覆盖 original 的地方传 false。
function loadFields(fields, captureOriginal = true) {
  _loading = true;
  try {
    for (const f of fields) {
      const cmd = _cmdOf(f.key);
      const val = f.getter ? f.getter(f.key) : null;
      const v = val == null ? (cmd ? cmd.default : "") : val;
      const text = String(v);
      if (f.set) f.set(text);
      if (captureOriginal) f.original = text;
    }
  } finally {
    _loading = false;
  }
}

function reloadAll() {
  // 注意：此处不再重置 _t.keysVar——键数仅在"打开皮肤"(skin:opened)时重置为 4K，
  // "重新扫描 skin.ini" 等重载应保留用户当前选择的键数。
  for (const tab of ["general", "colours", "fonts"]) {
    loadFields(_t.fields[tab] || []);
  }
  // Mania 需按当前键数重建（键数变化或 ini 重建后）
  _rebuildManiaBody();
}

// 字段 → 所属区块名
const _SECTION_BY_KEY = new Map();
function _sectionOf(key) {
  if (!_SECTION_BY_KEY.has(key)) {
    if (GENERAL_COMMANDS.some((c) => c.key === key)) _SECTION_BY_KEY.set(key, "General");
    else if (COLOUR_COMMANDS.some((c) => c.key === key)) _SECTION_BY_KEY.set(key, "Colours");
    else if (FONT_COMMANDS.some((c) => c.key === key)) _SECTION_BY_KEY.set(key, "Fonts");
    else _SECTION_BY_KEY.set(key, "Mania");
  }
  return _SECTION_BY_KEY.get(key);
}

const _CMD_BY_KEY = new Map();
function _cmdOf(key) {
  if (!_CMD_BY_KEY.has(key)) {
    const all = [...GENERAL_COMMANDS, ...COLOUR_COMMANDS, ...FONT_COMMANDS, ...MANIA_COMMANDS];
    _CMD_BY_KEY.set(key, all.find((c) => c.key === key) || null);
  }
  return _CMD_BY_KEY.get(key);
}

// 保存：所有字段已通过 input/change 事件实时写入 state.ini；
// 此处只需确保 Mania section 存在并记录 Keys（供序列化）。
export function saveAllToIni() {
  _ensureMania(parseInt(_t.keysVar, 10));
}

// 保存成功后调用：把每个字段 ↺ 的"原始值"同步为当前值，
// 使重置恢复到保存时的状态（而不是第一次加载进去的值）。
export function syncOriginals() {
  const all = [...Object.keys(_t.fields).flatMap((k) => _t.fields[k]), ..._t.maniaFields];
  for (const f of all) {
    const cmd = _cmdOf(f.key);
    const val = f.getter ? f.getter(f.key) : null;
    f.original = val == null ? (cmd ? cmd.default : "") : String(val);
  }
}

// ---------------------------------------------------------------------------
// 浏览素材（path / copy 模式，与 Python 版一致）
// ---------------------------------------------------------------------------

async function _browseFile(cmd, input) {
  if (!backendAvailable()) return toast("非 Tauri 环境无法选择文件", "error");
  const folder = state.skinFolder;
  if (!folder) return;

  let path = null;
  try {
    const paths = await invoke("pick_files");
    path = paths[0];
  } catch (e) {
    return toast("选择文件失败：" + e.message, "error");
  }
  if (!path) return;

  const mode = state.settings.ini_import_mode;
  const copyFolderName = (state.settings.ini_import_folder || "mania").replace(/^[\\/]+|[\\/]+$/g, "") || "mania";

  let rel;
  if (mode === "copy") {
    // 复制到皮肤子目录（同组字体一并复制 + 覆盖确认 + 复制后重扫）
    const srcDir = String(path).replace(/[\\/][^\\/]+$/, "");
    const srcs = [path, ...(await _gatherFontCopies(path, srcDir))];
    if (!(await _copyToSkin(srcs, folder, copyFolderName))) return;
    rel = copyFolderName + "/" + String(path).split(/[\\/]/).pop();
  } else {
    // path 模式：相对路径（须在皮肤文件夹内）
    const parsed = _relToFolder(path, folder);
    if (parsed === null) return;
    rel = parsed;
  }

  // 去扩展名、\→/、去 @2x/2x
  let stem = rel.replace(/\.[^.]+$/, "").replace(/\\/g, "/");
  stem = strip_hd(stem);

  // fontprefix 字段：写入前缀名（如 font/score-3@2x.png → font/score）
  if (cmd.type === "fontprefix") {
    const sep = stem.lastIndexOf("-");
    if (sep >= 0) {
      const suffix = stem.slice(sep + 1);
      if (FONT_SUFFIXES.has(suffix)) stem = stem.slice(0, sep);
    }
  }

  input.value = stem;
  const val = _valueFor(cmd, stem);
  if (val !== "") {
    const secName = _sectionOf(cmd.key);
    if (secName === "Mania") {
      _ensureMania(parseInt(_t.keysVar, 10)).set(cmd.key, val);
    } else {
      state.ini.set(secName, cmd.key, val);
    }
  }
  state.dirty = true;
  emit("ini:changed");
}

// 复制模式下，把同组字体后缀（0-9/comma/dot/percent/x）的文件一并纳入复制集合。
async function _gatherFontCopies(primaryPath, srcDir) {
  const baseName = String(primaryPath).split(/[\\/]/).pop();
  const bstem = strip_hd(baseName.replace(/\.[^.]+$/, ""));
  const sep = bstem.lastIndexOf("-");
  const prefix = sep >= 0 ? bstem.slice(0, sep) : "";
  const suffix = sep >= 0 ? bstem.slice(sep + 1) : "";
  const extras = [];
  if (!prefix || !FONT_SUFFIXES.has(suffix)) return extras;
  try {
    const names = await invoke("list_images", { folder: srcDir });
    for (const p of names) {
      const fn = String(p).split(/[\\/]/).pop();
      const fstem = strip_hd(fn.replace(/\.[^.]+$/, ""));
      const s2 = fstem.split("-").pop();
      if (fstem.startsWith(prefix + "-") && FONT_SUFFIXES.has(s2)) extras.push(p);
    }
  } catch (e) { /* 忽略 */ }
  return extras;
}

// 复制到皮肤子目录：跳过同目标、覆盖确认、执行复制、复制后重扫。返回 false 表示应中止后续写入。
async function _copyToSkin(srcs, folder, copyFolderName) {
  const destOf = (src) => `${folder}/${copyFolderName}/${String(src).split(/[\\/]/).pop()}`;
  const same = (src) => src.replace(/[\\/]/g, "/").toLowerCase() === destOf(src).replace(/[\\/]/g, "/").toLowerCase();
  const targets = srcs.filter((src) => !same(src)).map((src) => ({ src, dest: destOf(src) }));

  // 仅统计目标确实已存在的文件（这些才是真正会被覆盖的）
  const conflicting = [];
  for (const t of targets) {
    if (await invoke("path_exists", { path: t.dest })) conflicting.push(t);
  }

  // 覆盖询问：多文件统一确认一次；单文件单独确认
  let overwrite = false;
  if (srcs.length > 1 && conflicting.length) {
    overwrite = await confirmDialog({
      title: "覆盖确认",
      text: `${copyFolderName}/ 中已有 ${conflicting.length} 个同名文件（如 ${String(conflicting[0].dest).split(/[\\/]/).pop()}）。\n是否覆盖它们？选择"取消"将跳过这些文件。`,
      okText: "覆盖",
    });
  }

  const copied = [];
  for (const t of targets) {
    const isConflict = conflicting.some((c) => c.src === t.src);
    if (srcs.length === 1 && isConflict) {
      // 单文件且目标已存在：询问是否覆盖
      const destName = String(t.dest).split(/[\\/]/).pop();
      const ok2 = await confirmDialog({
        title: "覆盖确认",
        text: `${copyFolderName}/${destName} 已存在，是否覆盖？`,
        okText: "覆盖",
      });
      if (!ok2) return false;
    } else if (isConflict && !overwrite) {
      continue;
    }
    try {
      await invoke("copy_file", { src: t.src, dest: t.dest });
      copied.push(String(t.dest).split(/[\\/]/).pop());
    } catch (e) {
      if (srcs.length === 1) { toast("复制失败：" + e.message, "error"); return false; }
    }
  }
  if (srcs.length > 1) {
    toast("已把同组字体一并复制到 " + copyFolderName + "/：" + copied.sort().join("、"));
  }
  // 复制产生了新文件：重新扫描皮肤，让游玩预览 / 元素管理立即识别（免手动刷新）
  if (copied.length) {
    try { await rescanSkin(); } catch (e) { /* 重扫失败不阻断 */ }
  }
  return true;
}

// path 模式：限定素材在皮肤文件夹内，返回相对路径（越界则提示并返回 null）。
function _relToFolder(path, folder) {
  const folderNorm = folder.replace(/\\/g, "/").replace(/\/+$/, "");
  const pathNorm = path.replace(/\\/g, "/");
  if (!pathNorm.toLowerCase().startsWith(folderNorm.toLowerCase())) {
    toast("素材不在皮肤文件夹内，请选择皮肤内的文件", "error");
    return null;
  }
  return pathNorm.slice(folderNorm.length).replace(/^\//, "");
}

// ---------------------------------------------------------------------------
// 跳转到字段（元素管理双击缺失元素）
// ---------------------------------------------------------------------------

export function jumpToField(filename) {
  // 查找匹配的命令：image 命令的默认贴图名，或 fontprefix 命令的前缀
  let targetKey = null;
  let tab = "mania";
  const all = [
    ...MANIA_COMMANDS.map((c) => ({ c, tab: "mania" })),
    ...FONT_COMMANDS.map((c) => ({ c, tab: "fonts" })),
    ...GENERAL_COMMANDS.map((c) => ({ c, tab: "general" })),
  ];
  for (const { c, tab: t } of all) {
    if (c.type === "image") {
      // 从 help 中提取贴图名（如 "mania-stage-left.png"）或以 key 试
      const m = (c.help || "").match(/([a-zA-Z0-9_\/-]+\.png)/);
      const base = m ? m[1].replace(/\.png$/, "") : c.key.toLowerCase();
      if (filename === base || filename.startsWith(base)) {
        targetKey = c.key;
        tab = t;
        break;
      }
    } else if (c.type === "fontprefix") {
      const pfx = (c.default || c.key).replace(/Prefix$/, "").toLowerCase();
      if (filename.startsWith(pfx + "-") || filename === pfx) {
        targetKey = c.key;
        tab = t;
        break;
      }
    }
  }
  if (!targetKey) return;
  _switchSubTab(tab);
  // 等布局渲染后滚动并高亮
  requestAnimationFrame(() => _highlightField(targetKey));
}

function _highlightField(key) {
  const row = document.querySelector(`#ini-tab .field-row[data-key="${CSS.escape(key)}"]`);
  if (!row) return;
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  row.classList.add("flash");
  const input = row.querySelector("input, select");
  if (input && input.focus) input.focus();
  setTimeout(() => row.classList.remove("flash"), 1600);
}