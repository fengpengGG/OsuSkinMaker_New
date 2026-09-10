// 应用入口：全局初始化、工具栏、标签页、主题与事件接线。

import { invoke, backendAvailable, destroyWindow, onWindowCloseRequested } from "./api.js";
import {
  state, on, emit, loadSettings, persistSettings,
  openSkinFolder, saveIni, createNewSkin,
} from "./state.js";
import { openSettings, toast, promptText, confirmDialog, makeSplitter } from "./components.js";

// 元素管理 / skin.ini 编辑 / 游玩预览 各自的渲染模块
import { renderPanel, refreshPanel } from "./panel.js";
import { renderIniTab, refreshIni, saveAllToIni, syncOriginals } from "./ini_tab.js";
import { renderPreview, refreshPreview, mountPreviewActions } from "./preview.js";

// ---------------------------------------------------------------------------
// 主题
// ---------------------------------------------------------------------------

export function applyTheme(name) {
  const dark = name === "dark";
  // 始终二选一：缺失主题类会导致 --panel-solid 等变量未定义，弹窗/面板变透明
  document.body.classList.toggle("dark", dark);
  document.body.classList.toggle("light", !dark);
}

// 对整个界面做 zoom 缩放（WebView2/Chromium 支持），实现"UI 大小"调节。
// 只更新 CSS 变量：html 由 --ui-scale 缩放，弹窗/toast 由 --ui-inv 反向抵消，
// 保证在任意 UI 大小下弹窗与 toast 都完整留在视口内可操作。
export function applyUiScale(scale) {
  const v = Math.min(1.5, Math.max(0.7, Number(scale) || 1));
  const r = document.documentElement.style;
  r.setProperty("--ui-scale", String(v));
  r.setProperty("--ui-inv", String(1 / v));
}

// ---------------------------------------------------------------------------
// 工具栏动作
// ---------------------------------------------------------------------------

async function cmdOpenSkin() {
  let folder = null;
  try {
    folder = await invoke("pick_folder");
  } catch (e) {
    return toast("当前为非 Tauri 环境，无法选择文件夹", "error");
  }
  if (folder) {
    await openSkinFolder(folder);
    refreshPreview();
    refreshPanel();
    toast("已打开皮肤");
  }
}

async function cmdNewSkin() {
  let parent = null;
  try {
    parent = await invoke("pick_folder");
  } catch (e) {
    return toast("当前为非 Tauri 环境，无法选择文件夹", "error");
  }
  if (!parent) return;
  const name = await promptText({
    title: "新建皮肤",
    label: "皮肤名称",
    initial: "My Skin",
  });
  if (!name) return;
  const ok = await confirmDialog({
    title: "确认新建",
    text: `将在以下目录创建皮肤：\n${parent}\\${name}`,
    okText: "创建",
  });
  if (!ok) return;
  try {
    const folder = await createNewSkin(parent, name);
    await openSkinFolder(folder);
    refreshPreview();
    refreshPanel();
    toast("皮肤已创建并打开");
  } catch (e) {
    toast("创建失败：" + e.message, "error");
  }
}

async function cmdSave() {
  if (!state.skinFolder) return toast("请先打开一个皮肤文件夹", "error");
  try {
    saveAllToIni(); // 表单值实时已同步，这里确保 Mania section 与 Keys
    await saveIni();
    syncOriginals(); // ↺ 重置的原始值同步为保存后的值
    toast("skin.ini 已保存");
  } catch (e) {
    toast("保存失败：" + e.message, "error");
  }
}

async function cmdOpenFolder() {
  if (!state.skinFolder) return toast("请先打开一个皮肤文件夹", "error");
  try {
    await invoke("open_in_explorer", { path: state.skinFolder });
  } catch (e) {
    toast("无法打开文件夹：" + e.message, "error");
  }
}

async function cmdOpenIni() {
  if (!state.skinFolder) return toast("请先打开一个皮肤文件夹", "error");
  const iniPath = state.skinFolder + "\\skin.ini";
  try {
    await invoke("read_text", { path: iniPath }); // 探测文件存在
  } catch (e) {
    return toast("未找到 skin.ini 文件", "error");
  }
  try {
    await invoke("open_with_default_app", { path: iniPath }); // 用默认编辑器打开
  } catch (e) {
    toast("无法打开 skin.ini：" + e.message, "error");
  }
}

// ---------------------------------------------------------------------------
// 标签页切换（元素管理 / skin.ini 编辑）
// ---------------------------------------------------------------------------

function switchTab(name) {
  document.querySelectorAll("#side-tabs .tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  for (const body of document.querySelectorAll("#panel-tab, #ini-tab")) {
    const isActive = body.id === name;
    body.classList.toggle("active", isActive);
    body.classList.toggle("hidden", !isActive);
  }
}

// ---------------------------------------------------------------------------
// 路径卡片
// ---------------------------------------------------------------------------

function updatePathCard() {
  const card = document.getElementById("path-card");
  card.textContent = state.skinFolder || "（未打开皮肤）";
  card.title = state.skinFolder || "";
}

// ---------------------------------------------------------------------------
// 窗口状态：由 Rust 侧（window_state.rs）负责恢复与持久化，
// 前端只在关闭前兜底保存一次非窗口设置。
// ---------------------------------------------------------------------------

let _closing = false;

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function init() {
  applyTheme(state.settings.theme || "dark");
  applyUiScale(state.settings.ui_scale);
  on("settings:loaded", (s) => {
    applyTheme(s.theme);
    applyUiScale(s.ui_scale);
  });
  on("theme:changed", () => {
    applyTheme(state.settings.theme);
    persistSettings();
  });
  on("skin:opened", () => updatePathCard());
  on("skin:saved", () => updatePathCard());

  // 工具栏
  document.getElementById("btn-open").addEventListener("click", cmdOpenSkin);
  document.getElementById("btn-new").addEventListener("click", cmdNewSkin);
  document.getElementById("btn-save").addEventListener("click", cmdSave);
  document.getElementById("btn-folder").addEventListener("click", cmdOpenFolder);
  document.getElementById("btn-ini").addEventListener("click", cmdOpenIni);
  document.getElementById("btn-settings").addEventListener("click", () => openSettings());

  // 标签页
  document.querySelectorAll("#side-tabs .tab").forEach((b) => {
    b.addEventListener("click", () => switchTab(b.dataset.tab));
  });

  // 加载设置并恢复上次皮肤
  await loadSettings();
  updatePathCard();

  // 关闭前兜底保存设置（窗口状态由 Rust 侧保存）
  onWindowCloseRequested(async (event) => {
    if (_closing) return;
    _closing = true;
    event.preventDefault();
    try {
      await persistSettings();
    } catch (e) {
      console.warn("关闭前保存设置失败", e);
    }
    await destroyWindow();
  });

  // 首屏渲染（三个面板占位）
  renderPreview();
  renderPanel();
  renderIniTab();

  // 主区分割：游玩预览 | 右侧面板 之间加可拖拽分隔条（比例存 settings.json）
  const main = document.getElementById("main");
  makeSplitter(
    main,
    document.getElementById("preview-pane"),
    document.getElementById("side-pane"),
    { minLeft: 320, minRight: 360, ratioKey: "main_sash_ratio" },
  );

  const last = state.settings.last_skin;
  if (last) {
    try {
      await openSkinFolder(last);
      refreshPreview();
      refreshPanel();
    } catch (e) {
      console.warn("恢复上次皮肤失败", e);
    }
  }

  console.log("[OsuSkinMaker] backend:", backendAvailable() ? "tauri" : "browser");
}

init();