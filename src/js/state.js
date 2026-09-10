// 全局应用状态与事件总线（与 Python 版 App 实例状态对应）。

import { invoke } from "./api.js";
import { SkinIni, Section } from "./skin_ini.js";
import { SkinManager } from "./manager.js";

// 简单事件总线：panel/preview/ini 模块注册监听，工具栏等引发动作。
const _listeners = new Map();

export function on(event, fn) {
  if (!_listeners.has(event)) _listeners.set(event, []);
  _listeners.get(event).push(fn);
}

export function emit(event, payload) {
  for (const fn of _listeners.get(event) || []) {
    try {
      fn(payload);
    } catch (e) {
      console.error(`[state:${event}]`, e);
    }
  }
}

// 设置项的合法值（读写自 settings.json，与 Python 版一致）
const VALID = {
  theme: ["light", "dark"],
  hd_default: ["hd", "normal", "ask"],
  ini_import_mode: ["path", "copy"],
};

const DEFAULT_SETTINGS = {
  theme: "dark",
  hd_default: "ask",
  show_default: true,
  click_select: false,
  enable_category: true,
  ini_import_mode: "path",
  ini_import_folder: "mania",
  // UI 缩放比例 (0.7 ~ 1.5)：对整个界面做 zoom 缩放
  ui_scale: 1,
  // 预览选中图层高亮框：是否显示 + 颜色（rgba 字符串）
  hitbox_show: true,
  hitbox_color: "rgba(64, 200, 255, 0.9)",
  // 窗口状态（与原项目字段一致）：无记录时默认最大化
  window_state: "zoomed",  // "zoomed" | "normal"
  window_geometry: null,   // { width, height, x, y } 物理像素
  // 分割条左侧占比 (0,1)，随窗口宽度自适应
  main_sash_ratio: null,
  element_sash_ratio: null,
};

export const state = {
  settings: { ...DEFAULT_SETTINGS },

  // 当前皮肤
  skinFolder: null,
  manager: null, // SkinManager
  ini: new SkinIni(), // 当前 skin.ini（编辑中的内存对象）
  iniEncoding: "utf-8-sig",
  dirty: false,

  // 预览状态（持久化，与 Python 版 preview_* 字段对应）
  preview: {
    page: "游玩界面",
    bg: true,
    cb: true,
    warning: true,
    skip: true,
    aspect: "16:9",
    score: "12345678",
    acc: "98.76%",
    combo: "1234",
    hit: "300",
  },

  // 已展开的元素分类树状态 { modeGroup: { category: bool } }
  expanded: {},
};

// -- 设置持久化 ------------------------------------------------------------

function _sanitize(settings) {
  const out = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  // 兼容旧字段 missing_block → show_default
  if (typeof out.show_default !== "boolean") {
    out.show_default = Boolean(out.missing_block ?? true);
  }
  const _scale = Number(out.ui_scale);
  out.ui_scale = Number.isFinite(_scale) ? Math.min(1.5, Math.max(0.7, _scale)) : 1;
  for (const key of ["hd_default", "ini_import_mode", "theme"]) {
    const list = VALID[key];
    if (list && !list.includes(out[key])) out[key] = { ...DEFAULT_SETTINGS }[key];
  }
  for (const key of ["show_default", "click_select", "enable_category", "hitbox_show"]) {
    out[key] = Boolean(out[key]);
  }
  if (typeof out.hitbox_color !== "string" || !out.hitbox_color) {
    out.hitbox_color = DEFAULT_SETTINGS.hitbox_color;
  }
  if (typeof out.preview !== "object" || !out.preview) out.preview = { ...state.preview };
  else out.preview = { ...state.preview, ...out.preview };
  if (typeof out.expanded !== "object" || !out.expanded) out.expanded = {};
  // 窗口状态：合法值 zoomed/normal，否则默认 zoomed（原项目默认最大化）
  if (out.window_state !== "normal") out.window_state = "zoomed";
  const _g = out.window_geometry;
  if (_g && typeof _g === "object"
      && Number.isFinite(_g.width) && Number.isFinite(_g.height)) {
    out.window_geometry = {
      width: _g.width,
      height: _g.height,
      x: Number.isFinite(_g.x) ? _g.x : null,
      y: Number.isFinite(_g.y) ? _g.y : null,
    };
  } else {
    out.window_geometry = null;
  }
  for (const _key of ["main_sash_ratio", "element_sash_ratio"]) {
    const _r = out[_key];
    if (!(typeof _r === "number" && _r > 0 && _r < 1)) out[_key] = null;
  }
  return out;
}

export async function loadSettings() {
  let saved = {};
  try {
    saved = await invoke("load_settings");
  } catch (e) {
    // 非 Tauri 环境，用默认设置
    console.warn("设置读取失败（可能为非 Tauri 环境）", e);
  }
  state.settings = _sanitize(saved);
  state.preview = state.settings.preview;
  state.expanded = state.settings.expanded || {};
  emit("settings:loaded", state.settings);
  return state.settings;
}

export async function persistSettings() {
  const s = { ...state.settings };
  // 窗口状态由 Rust 侧（window_state.rs）读写，前端不保存这两个字段，避免相互覆盖
  delete s.window_state;
  delete s.window_geometry;
  s.preview = { ...state.preview };
  s.expanded = state.expanded;
  try {
    await invoke("save_settings", { data: s });
  } catch (e) {
    console.warn("设置保存失败", e);
  }
}

// -- 皮肤加载 --------------------------------------------------------------

export async function openSkinFolder(folder) {
  state.skinFolder = folder;
  state.manager = new SkinManager(folder);
  state.settings.last_skin = folder;
  await loadIni(); // 仅解析 ini
  state.images = await scanImages(); // 扫描素材图片并建立索引
  emit("skin:reloaded");
  emit("skin:opened", folder);
  persistSettings();
}

/** 从磁盘重新读取 skin.ini 并覆盖当前编辑内容（用于"重新扫描 skin.ini"）。
 * 只负责解析，不扫描图片、不广播事件——由调用方决定何时 emit。
 * 会丢弃未保存的编辑。 */
export async function loadIni() {
  const path = folderIniPath();
  let text = null;
  let encoding = "utf-8-sig";
  try {
    const res = await invoke("read_text", { path });
    text = res.text;
    encoding = res.encoding;
  } catch (e) {
    // 无 skin.ini 或读取失败：当作空白皮肤
    text = null;
  }
  state.iniEncoding = encoding;
  state.ini = text != null ? SkinIni.parse(text) : new SkinIni();
  state.dirty = false;
}

async function scanImages() {
  if (!state.skinFolder) return [];
  try {
    const paths = await invoke("list_images", { folder: state.skinFolder });
    state.manager.scan(paths);
    return paths;
  } catch (e) {
    console.warn("图片扫描失败", e);
    return [];
  }
}

/** 重新扫描皮肤文件夹（识别外部新增/删除/覆盖的素材），并通知各模块刷新。
 * 与打开皮肤不同：不重读 skin.ini，仅更新图片清单与素材存在状态。 */
export async function rescanSkin() {
  if (!state.skinFolder || !state.manager) return false;
  try {
    const paths = await invoke("list_images", { folder: state.skinFolder });
    state.images = paths;
    state.manager.scan(paths);
    emit("skin:reloaded");
    return true;
  } catch (e) {
    console.warn("重新扫描失败", e);
    return false;
  }
}

function folderIniPath() {
  return state.skinFolder ? state.skinFolder.replace(/[\\/]+$/, "") + "/skin.ini" : "";
}

// -- 工具栏动作 ------------------------------------------------------------

export async function saveIni() {
  if (!state.skinFolder) throw new Error("请先打开一个皮肤文件夹");
  // Forms/Editors 会在各自 save 时同步进 state.ini；这里直接序列化。
  const text = state.ini.serialize();
  // 无 BOM 的 UTF-8 / latin-1 升级为带 BOM（与 Python 版一致，后端也做了兜底）
  const enc = state.iniEncoding;
  await invoke("write_text_atomic", { path: folderIniPath(), text, encoding: enc });
  state.dirty = false;
  emit("skin:saved");
}

function sheetForNewSkin(name) {
  const ini = new SkinIni();
  ini.set("General", "Name", name);
  ini.set("General", "Version", "latest");
  ini.set("General", "Author", "");
  const sec = new Section("Mania");
  sec.set("Keys", "4");
  ini.sections.push(sec);
  return ini;
}

export async function createNewSkin(parent, name) {
  const folder = (parent.replace(/[\\/]+$/, "") + "/" + name).replace(/\/+/g, "/");
  await invoke("create_folder", { path: folder });
  const ini = sheetForNewSkin(name);
  await invoke("write_text_atomic", {
    path: folder + "/skin.ini",
    text: ini.serialize(),
    encoding: "utf-8-sig",
  });
  return folder;
}