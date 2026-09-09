// 元素管理面板（与 Python 版 ElementPanel 逻辑一致）。
// 树（模式分组→功能分类→元素）+ 筛选 + 预览（缩放/平移/动画）+ 增删替换素材。

import { state, emit, on, persistSettings, rescanSkin } from "./state.js";
import { invoke, loadImageSrc, backendAvailable } from "./api.js";
import { PAGE_SCREEN, by_name, by_group } from "./catalog.js";
import { SkinManager, parse_stem } from "./manager.js";
import { findManiaSection } from "./skin_ini.js";
import { confirmDialog, toast, makeSplitter } from "./components.js";

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

const _p = {
  filter: "all", // all | missing | hd | anim
  selected: null, // 当前选中元素 filename
  tree: null, // 树容器
  previewEl: null, // 图片容器
  infoEl: null, // 信息标签
  actionsEl: null, // 操作按钮区
  // 缩放/平移视图
  img: null, // 当前 img 元素
  imgW: 0, imgH: 0, // 逻辑尺寸（@2x 减半）
  zoom: 1, offX: 0, offY: 0, panStart: null,
  // 动画
  animFrames: [], // [{frame, path}]
  animTimer: null, animIdx: 0, animPlaying: false, animImg: null,
  cur: null, // 当前选中元素的 catalog 定义与状态 {e, st}
};

// ---------------------------------------------------------------------------
// 渲染入口
// ---------------------------------------------------------------------------

// 数字/标点元素的前缀来源：cn 目录里 combo-*/score-*/default-* 是固定名，
// 但真实皮肤的数字常按 [Fonts] 的 ScorePrefix/ComboPrefix/HitCirclePrefix 命名
// （默认值依官方：ComboPrefix="combo"、ScorePrefix="score"、HitCirclePrefix="default"）。
// 检测存在性时同时认字面名与前缀算出的名，与 preview 的 _digitPath 语义一致。
const FONT_PREFIX_SRC = {
  "combo-": ["ComboPrefix", "combo"],
  "score-": ["ScorePrefix", "score"],
  "default-": ["HitCirclePrefix", "default"],
};

// [Fonts] 数字前缀：字段不存在→默认值；存在但留空→null（数字不可用）。
// 与 preview.js 的 _fontPrefix 语义保持一致。
function _prefixVal(iniKey, def) {
  if (!state.ini) return def;
  const v = state.ini.get("Fonts", iniKey);
  if (v === null || v === undefined) return def;
  const s = String(v).trim().replace(/^"|"$/g, "");
  return s === "" ? null : s;
}

// 元素 filename → [Mania] 段字段（与 preview.js 的 _resolvePath 映射一致）。
// 当默认名在根目录缺失、但 skin.ini 指定了这些字段时，标记"存在(skin.ini)"。
const _MANIA_INI_FIELDS = {};
for (let i = 1; i <= 18; i++) {
  const idx = i - 1;
  _MANIA_INI_FIELDS[`mania-note${i}`] = [`NoteImage${idx}`];
  _MANIA_INI_FIELDS[`mania-note${i}H`] = [`NoteImage${idx}H`];
  _MANIA_INI_FIELDS[`mania-note${i}L`] = [`NoteImage${idx}L`];
  _MANIA_INI_FIELDS[`mania-note${i}T`] = [`NoteImage${idx}T`];
  _MANIA_INI_FIELDS[`mania-key${i}`] = [`KeyImage${idx}`];
  _MANIA_INI_FIELDS[`mania-key${i}D`] = [`KeyImage${idx}D`];
}
Object.assign(_MANIA_INI_FIELDS, {
  "mania-stage-left": ["StageLeft"],
  "mania-stage-right": ["StageRight"],
  "mania-stage-bottom": ["StageBottom"],
  "mania-stage-light": ["StageLight"],
  "mania-stage-hint": ["StageHint"],
  "mania-warningarrow": ["WarningArrow"],
  "lightingN": ["LightingN"],
  "lightingL": ["LightingL"],
  "mania-hit0": ["Hit0"],
  "mania-hit50": ["Hit50"],
  "mania-hit100": ["Hit100"],
  "mania-hit200": ["Hit200"],
  "mania-hit300": ["Hit300"],
  "mania-hit300g": ["Hit300g"],
});

function _stripImageExt(name) {
  return name.replace(/\.(png|gif|jpg|jpeg)$/i, "");
}

function _digitalCandidates(e) {
  const fn = e.filename;
  for (const key of Object.keys(FONT_PREFIX_SRC)) {
    if (fn.startsWith(key)) {
      const suffix = fn.slice(key.length);
      const [iniKey, def] = FONT_PREFIX_SRC[key];
      const pfx = _prefixVal(iniKey, def);
      const out = [fn];
      if (pfx && suffix) out.push(`${pfx}-${suffix}`);
      return out;
    }
  }
  return [fn];
}

// 返回元素在 skin.ini 中可能被指定的路径候选（[Fonts] 前缀 + [Mania] 字段），
// 用于"存在(skin.ini)"标注。不含默认名本身。
function _iniProbes(e) {
  const out = [];
  const fn = e.filename;
  // 1) [Fonts] 数字前缀（如 ComboPrefix: combo → combo-0）
  for (const key of Object.keys(FONT_PREFIX_SRC)) {
    if (fn.startsWith(key)) {
      const suffix = fn.slice(key.length);
      const [iniKey, def] = FONT_PREFIX_SRC[key];
      const pfx = _prefixVal(iniKey, def);
      if (pfx && suffix && `${pfx}-${suffix}` !== fn) out.push(`${pfx}-${suffix}`);
      break;
    }
  }
  // 2) [Mania] 指定路径（如 NoteImage0: mania/key）——与预览一致，按当前键数取段
  const fields = _MANIA_INI_FIELDS[fn];
  if (fields && state.ini) {
    const sec = findManiaSection(state.ini, _currentKeys());
    if (sec) {
      for (const f of fields) {
        const v = sec.get(f);
        if (v) out.push(_stripImageExt(String(v).trim().replace(/^"|"$/g, "")));
      }
    }
  }
  return out;
}

// 当前编辑器所选键数（与预览一致）
function _currentKeys() {
  const sel = document.querySelector(".mania-keys");
  if (sel) {
    const k = parseInt(sel.value, 10);
    if (Number.isFinite(k) && k >= 1 && k <= 18) return k;
  }
  return 4;
}

// 返回元素在「当前皮肤」下实际命中的文件名（优先字面名，其次前缀名，其次 skin.ini 指定路径）
function _effectiveFile(e) {
  const mgr = state.manager;
  if (!mgr) return e.filename;
  for (const f of _digitalCandidates(e)) if (mgr.hasBase(f)) return f;
  for (const probe of _iniProbes(e)) if (mgr.hasBase(probe)) return probe;
  return e.filename;
}

// 用实际文件名求状态（不影响 e.filename 的显示）
function _statusOf(mgr, e) {
  return mgr.status({ ...e, filename: _effectiveFile(e) });
}

// 元素存在来源：'root'（根目录默认名/字面名）| 'ini'（仅 skin.ini 指定路径存在）| null（缺失）
function _sourceOf(mgr, e) {
  if (!mgr) return null;
  if (mgr.hasBase(e.filename)) return "root";
  for (const probe of _iniProbes(e)) {
    if (mgr.hasBase(probe)) return "ini";
  }
  return null;
}

export function renderPanel() {
  const host = document.getElementById("panel-tab");
  host.innerHTML = "";
  host.className = "tab-body active";

  // 布局：整体元素面板（flex column）
  const pane = document.createElement("div");
  pane.className = "element-tree-pane";
  host.appendChild(pane);

  // 顶栏：摘要 + 筛选 + 重新扫描
  const top = document.createElement("div");
  top.className = "tree-toolbar";

  const summary = document.createElement("span");
  summary.className = "summary";
  summary.id = "ep-summary";
  summary.textContent = "未加载皮肤";
  top.appendChild(summary);

  const filterGroup = document.createElement("div");
  filterGroup.className = "filter-group";
  for (const [text, val] of [["全部", "all"], ["缺失", "missing"], ["@2x", "hd"], ["动画", "anim"]]) {
    const b = document.createElement("button");
    b.textContent = text;
    b.dataset.val = val;
    b.classList.toggle("active", _p.filter === val);
    b.addEventListener("click", () => {
      _p.filter = val;
      filterGroup.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      refreshPanel();
    });
    filterGroup.appendChild(b);
  }
  top.appendChild(filterGroup);

  const rescan = document.createElement("button");
  rescan.className = "btn btn-tool";
  rescan.textContent = "重新扫描";
  rescan.addEventListener("click", async () => {
    await rescanSkin(); // 真正重新扫描文件夹（识别外部增删/覆盖素材）
    refreshPanel();
  });
  top.appendChild(rescan);
  pane.appendChild(top);

  // 主区：树 + 预览（左右分栏）
  const split = document.createElement("div");
  split.className = "ep-split";
  pane.appendChild(split);

  // 左：树
  const treeWrap = document.createElement("div");
  treeWrap.className = "ep-tree-wrap";
  _p.tree = document.createElement("div");
  _p.tree.className = "element-tree";
  treeWrap.appendChild(_p.tree);
  split.appendChild(treeWrap);

  // 右：预览
  const prev = document.createElement("div");
  prev.className = "element-preview";
  const canvasWrap = document.createElement("div");
  canvasWrap.className = "preview-canvas-wrap";
  _p.previewEl = document.createElement("div");
  _p.previewEl.className = "preview-img-host";
  canvasWrap.appendChild(_p.previewEl);
  prev.appendChild(canvasWrap);

  _p.infoEl = document.createElement("div");
  _p.infoEl.className = "preview-info";
  prev.appendChild(_p.infoEl);

  _p.actionsEl = document.createElement("div");
  _p.actionsEl.className = "preview-actions";
  prev.appendChild(_p.actionsEl);
  split.appendChild(prev);

  // 元素树 | 元素预览 之间加可拖拽分隔条（比例存 settings.json）
  makeSplitter(split, treeWrap, prev, {
    minLeft: 180, minRight: 220, ratioKey: "element_sash_ratio",
  });

  // 绑定缩放/平移到预览容器
  canvasWrap.addEventListener("wheel", _onWheel, { passive: false });
  canvasWrap.addEventListener("mousedown", _onPanStart);
  window.addEventListener("mousemove", _onPanMove);
  window.addEventListener("mouseup", _onPanEnd);

  refreshPanel();

  // 外部联动：预览界面切换 / 点击预览组件选中时刷新
  on("preview:page-changed", refreshPanel);
  on("preview:element-selected", selectElement);
  // 重扫皮肤（含复制添加素材后的 rescanSkin）→ 自动刷新元素管理树，免手动刷新
  on("skin:reloaded", refreshPanel);
}

export function refreshPanel() {
  const tree = _p.tree;
  if (!tree) return;
  _saveOpenState();
  tree.innerHTML = "";

  const mgr = state.manager;
  const summary = document.getElementById("ep-summary");
  if (!mgr || !state.skinFolder) {
    if (summary) summary.textContent = "未加载皮肤";
    _clearPreview();
    return;
  }

  const s = mgr.summary();
  if (summary) summary.textContent = `共 ${s.total} 个元素 | 已有 ${s.present} | 缺失 ${s.missing}`;

  // 分类过滤（设置项 enable_category）：按当前预览界面筛选
  let screenMatch = null;
  if (state.settings.enable_category) {
    const pageName = state.preview.page;
    if (pageName === "游玩界面") {
      screenMatch = (e) => e.screens.includes("游玩") || e.screens.includes("通用");
    } else {
      const target = PAGE_SCREEN[pageName];
      if (target != null) screenMatch = (e) => e.screens.includes("通用") || e.screens.includes(target);
    }
  }

  const openState = state.expanded;
  const groups = by_group();
  for (const group of Object.keys(groups)) {
    const cats = groups[group];
    const groupHits = [];
    for (const cat of Object.keys(cats)) {
      const children = [];
      for (const e of cats[cat]) {
        if (screenMatch && !screenMatch(e)) continue;
        const st = _statusOf(mgr, e);
        if (_p.filter === "missing" && st.exists) continue;
        if (_p.filter === "hd" && (!st.exists || !st.hasHd)) continue;
        if (_p.filter === "anim" && (!st.exists || !st.frames)) continue;
        children.push({ e, st });
      }
      if (children.length) groupHits.push({ cat, children });
    }
    if (!groupHits.length) continue;

    const gKey = group;
    const gOpen = openState[gKey] !== false;
    const details = document.createElement("details");
    details.open = gOpen;
    details.dataset.key = gKey;
    // 直接监听本节点的 toggle（toggle 事件不冒泡，容器级监听收不到）
    details.addEventListener("toggle", () => _saveOpenState());
    const gSum = document.createElement("summary");
    gSum.className = "tree-group";
    gSum.textContent = group;
    details.appendChild(gSum);

    for (const { cat, children } of groupHits) {
      const cKey = `${group}/${cat}`;
      const cOpen = openState[cKey] !== false;
      const cDetails = document.createElement("details");
      cDetails.open = cOpen;
      cDetails.dataset.key = cKey;
      cDetails.addEventListener("toggle", () => _saveOpenState());
      const cSum = document.createElement("summary");
      cSum.className = "tree-cat";
      cSum.textContent = cat;
      cDetails.appendChild(cSum);

      for (const { e, st } of children) {
        cDetails.appendChild(_makeItem(e, st));
      }
      details.appendChild(cDetails);
    }
    tree.appendChild(details);
  }

  // 恢复选中（若元素仍可见）
  if (_p.selected) {
    const item = tree.querySelector(`[data-filename="${CSS.escape(_p.selected)}"]`);
    if (item) {
      item.classList.add("selected");
      item.scrollIntoView({ block: "nearest" });
    } else {
      _p.selected = null;
    }
  }
}

// ---------------------------------------------------------------------------
// 树节点
// ---------------------------------------------------------------------------

function _makeItem(e, st) {
  const row = document.createElement("div");
  row.className = "tree-item";
  row.dataset.filename = e.filename;
  row.title = e.description;

  const name = document.createElement("span");
  name.textContent = e.filename;
  row.appendChild(name);

  // 状态徽标
  let stateText, cls;
  const src = _sourceOf(state.manager, e);
  if (!st.exists) {
    stateText = "缺失";
    cls = "missing";
  } else if (src === "ini") {
    stateText = `存在(skin.ini)${st.hasHd ? "@2x" : ""}`;
    cls = "ini";
  } else if (st.hasHd) {
    stateText = "存在(@2x)";
    cls = "hd";
  } else {
    stateText = "存在";
    cls = "ok";
  }
  if (st.frames) {
    stateText += ` ·${st.frames}帧`;
  }
  const status = document.createElement("span");
  status.className = "status " + cls;
  status.textContent = stateText;
  row.appendChild(status);

  row.addEventListener("click", () => selectElement(e.filename));
  row.addEventListener("dblclick", () => _onDoubleClick(e, st));
  return row;
}

// ---------------------------------------------------------------------------
// 选中与预览
// ---------------------------------------------------------------------------

export function selectElement(filename) {
  _p.selected = filename;
  // 若当前不在列表中（被筛选/页面过滤）：重置筛选并刷新
  const tree = _p.tree;
  let item = tree ? tree.querySelector(`[data-filename="${CSS.escape(filename)}"]`) : null;
  if (tree && !item && _p.filter !== "all") {
    _p.filter = "all";
    document.querySelectorAll('#panel-tab .filter-group button').forEach((b) => {
      b.classList.toggle("active", b.dataset.val === "all");
    });
    refreshPanel();
    item = tree.querySelector(`[data-filename="${CSS.escape(filename)}"]`);
  }
  if (tree && item) {
    tree.querySelectorAll(".tree-item.selected").forEach((x) => x.classList.remove("selected"));
    item.classList.add("selected");
    item.scrollIntoView({ block: "nearest" });
  }
  _updatePreview(filename);
}

function _onDoubleClick(e, st) {
  const mgr = state.manager;
  const path = st.exists ? mgr.pathFor(_effectiveFile(e)) : null;
  if (path) {
    invoke("open_in_explorer", { path }).catch(() => {});
  } else {
    // 缺失元素：跳到 skin.ini 编辑器对应字段
    emit("jump-to-ini", e.filename);
  }
}

function _updatePreview(filename) {
  _stopAnimation();
  const e = by_name(filename);
  if (!e) return;
  const mgr = state.manager;
  const st = mgr ? _statusOf(mgr, e) : null;
  if (!st) return;
  _p.cur = { e, st };

  // 信息区（后续图片加载到实际尺寸后再刷新尺寸行）
  _renderInfo(null);

  // 操作按钮区
  _p.actionsEl.innerHTML = "";
  if (st.exists) {
    const del = document.createElement("button");
    del.className = "btn btn-tool";
    del.textContent = "删除素材";
    del.addEventListener("click", () => _deleteAsset(e.filename, st.files));
    _p.actionsEl.appendChild(del);

    const rep = document.createElement("button");
    rep.className = "btn btn-tool";
    rep.textContent = "替换素材";
    rep.addEventListener("click", () => _replaceAsset(e.filename, st.files));
    _p.actionsEl.appendChild(rep);

    if (st.frames > 0 && st.files.length) {
      _p.animFrames = _collectFrameFiles(st.files);
      const play = document.createElement("button");
      play.className = "btn btn-accent";
      play.textContent = "播放动画";
      play.dataset.role = "anim-btn";
      play.addEventListener("click", () => {
        if (_p.animPlaying) _stopAnimation();
        else _playAnimation();
      });
      _p.actionsEl.appendChild(play);
    }
    _showImage(mgr.pathFor(_effectiveFile(e)));
  } else if (st.exists === false) {
    const add = document.createElement("button");
    add.className = "btn btn-accent";
    add.textContent = "添加素材";
    add.addEventListener("click", () => _addAsset(_effectiveFile(e)));
    _p.actionsEl.appendChild(add);
    _clearPreviewImage();
  }
}

// ---------------------------------------------------------------
// 信息区渲染（组件预览下方）
// 规则：存在→显示实际尺寸；缺失→显示期望尺寸；期望尺寸为空→不显示尺寸行。
// actual 传入 "WxH" 字符串（存在组件加载成功后），否则为 null。
// ---------------------------------------------------------------
function _renderInfo(actual) {
  const el = _p.infoEl;
  if (!el) return;
  const { e, st } = _p.cur || {};
  if (!e) { el.innerHTML = ""; return; }
  el.innerHTML = "";

  const rows = [];
  const row = (label, val) => {
    const r = document.createElement("div");
    r.className = "preview-info-row";
    const lb = document.createElement("span");
    lb.className = "info-label";
    lb.textContent = label;
    const v = document.createElement("span");
    v.className = "info-val";
    v.textContent = val;
    r.appendChild(lb);
    r.appendChild(v);
    rows.push(r);
    el.appendChild(r);
  };

  // 尺寸：实际优先，其次期望；两者皆无则不显示
  if (st && st.exists && actual) {
    row("尺寸", actual);
  } else if (e.size) {
    row("尺寸", `${e.size}${st && st.exists && !actual ? " (期望)" : ""}`);
  }

  if (e.blend) row("混合", e.blend);
  if (e.origin) row("原点", e.origin);
  if (e.animatable) row("动画", "支持 -{n} 序列帧");

  // 悬浮小窗展示全部信息
  el.title = _fullInfoTxt(e, st, actual);
}

// 悬浮小窗里的完整信息
function _fullInfoTxt(e, st, actual) {
  const lines = [];
  lines.push(`名称: ${e.filename}`);
  lines.push(e.description ? `描述: ${e.description}` : "描述: -");
  if (st && st.exists && actual) {
    lines.push(`尺寸(实际): ${actual}`);
  } else if (e.size) {
    lines.push(`尺寸(期望): ${e.size}`);
  }
  if (e.blend) lines.push(`混合: ${e.blend}`);
  if (e.origin) lines.push(`原点: ${e.origin}`);
  if (e.animatable) lines.push("动画: 支持 -{n} 序列帧");
  if (e.category) lines.push(`分类: ${e.category}`);
  if (e.group) lines.push(`分组: ${e.group}`);
  if (st) {
    if (st.exists) {
      const srcTxt = _sourceOf(state.manager, e) === "ini" ? "（skin.ini）" : "";
      lines.push(`状态: 存在${srcTxt}${st.hasHd ? " (@2x)" : ""}${st.frames ? ` ·${st.frames}帧` : ""}`);
    } else {
      lines.push("状态: 缺失");
    }
  }
  return lines.join("  「  ");
}

// ---------------------------------------------------------------------------
// 图片预览（缩放/平移/动画）
// ---------------------------------------------------------------------------

function _clearPreviewImage() {
  _p.previewEl.innerHTML = "";
  _p.img = null;
  _p.animImg = null;
  // 不清 _p.animFrames：它由选中动画元素(line 452)填充，供播放按钮使用。
  // 此处原样清空会导致选中后点“播放动画”时 _playAnimation 因 length===0 直接返回，动画停摆。
  _p.zoom = 1; _p.offX = 0; _p.offY = 0;
}

function _showImage(path) {
  _clearPreviewImage();
  if (!path || !backendAvailable()) {
    _p.previewEl.textContent = "无法加载图片（非 Tauri 环境）";
    return;
  }
  const img = document.createElement("img");
  img.className = "preview-img";
  img.dataset.path = path;
  img.style.opacity = "0";
  img.addEventListener("load", () => {
    const isHd = SkinManager.isHdPath(path);
    _p.imgW = isHd ? Math.max(1, img.naturalWidth / 2) : img.naturalWidth;
    _p.imgH = isHd ? Math.max(1, img.naturalHeight / 2) : img.naturalHeight;
    _centerImage();
    img.style.opacity = "1";
    // 存在组件：用实际尺寸刷新信息区尺寸行
    _renderInfo(`${_p.imgW}x${_p.imgH}`);
  });
  img.addEventListener("error", () => {
    _p.previewEl.innerHTML = "";
    const t = document.createElement("div");
    t.className = "preview-err";
    t.textContent = "无法预览此图片";
    _p.previewEl.appendChild(t);
  });
  _p.img = img;
  _p.previewEl.appendChild(img);
  loadImageSrc(path).then((src) => {
    if (!src) {
      _p.previewEl.innerHTML = "";
      const t = document.createElement("div");
      t.className = "preview-err";
      t.textContent = "无法预览此图片";
      _p.previewEl.appendChild(t);
      return;
    }
    if (_p.previewUrl) {
      URL.revokeObjectURL(_p.previewUrl);
      _p.previewUrl = null;
    }
    if (src.startsWith("blob:")) _p.previewUrl = src;
    img.src = src;
  });
}

function _applyView() {
  if (!_p.img) return;
  _p.img.style.transform =
    `translate(${_p.offX}px, ${_p.offY}px) scale(${_p.zoom})`;
  _p.img.style.transformOrigin = "0 0";
  _p.img.style.width = _p.imgW + "px";
  _p.img.style.height = _p.imgH + "px";
}

function _centerImage() {
  if (!_p.imgW) return;
  const wrap = _p.previewEl.parentElement;
  const cw = wrap.clientWidth || 300;
  const ch = wrap.clientHeight || 200;
  _p.zoom = Math.min(1, cw / _p.imgW, ch / _p.imgH);
  _p.offX = (cw - _p.imgW * _p.zoom) / 2;
  _p.offY = (ch - _p.imgH * _p.zoom) / 2;
  _applyView();
}

function _onWheel(e) {
  e.preventDefault();
  const rect = _p.previewEl.parentElement.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const nz = Math.max(0.05, Math.min(_p.zoom * factor, 20));
  const ix = (cx - _p.offX) / _p.zoom;
  const iy = (cy - _p.offY) / _p.zoom;
  _p.zoom = nz;
  _p.offX = cx - ix * nz;
  _p.offY = cy - iy * nz;
  _applyView();
}

function _onPanStart(e) {
  if (e.button !== 0) return;
  _p.panStart = { x: e.clientX, y: e.clientY, ox: _p.offX, oy: _p.offY };
}

function _onPanMove(e) {
  if (!_p.panStart) return;
  _p.offX = _p.panStart.ox + (e.clientX - _p.panStart.x);
  _p.offY = _p.panStart.oy + (e.clientY - _p.panStart.y);
  _applyView();
}

function _onPanEnd() {
  _p.panStart = null;
}

// ---------------------------------------------------------------------------
// 动画
// ---------------------------------------------------------------------------

function _collectFrameFiles(files) {
  // 按帧号去重：@2x 是同一动画帧的高清版，不是额外帧。
  // 每帧保留一个代表文件（@2x 优先，其次原像素），避免播放时
  // 把“@2x 与原像素”当成两个不同帧，导致帧序错乱或停滞。
  const byFrame = new Map(); // frame -> { path, hasHd }（path 为选中的代表文件）
  for (const p of files) {
    const stem = String(p).split(/[\\/]/).pop();
    const dot = stem.lastIndexOf(".");
    const name = dot > 0 ? stem.slice(0, dot) : stem;
    const [, , frame] = parse_stem(name);
    const isHd = /@2x$/i.test(name);
    if (frame === null) continue;
    const cur = byFrame.get(frame);
    if (!cur) byFrame.set(frame, { path: p, hasHd: isHd });
    else if (isHd && !cur.hasHd) cur.path = p, cur.hasHd = true;
  }
  const out = [];
  for (const [frame, v] of byFrame.entries()) out.push({ frame, path: v.path });
  out.sort((a, b) => a.frame - b.frame);
  return out;
}

async function _playAnimation() {
  if (!_p.animFrames.length) return;
  _p.animPlaying = true;
  _p.animIdx = 0;
  const btn = _p.actionsEl.querySelector('[data-role="anim-btn"]');
  if (btn) btn.textContent = "停止";

  // 预载全部帧 Image 对象（上一轮动画的 Blob URL 先回收）
  if (_p.animUrls) {
    _p.animUrls.forEach((u) => URL.revokeObjectURL(u));
    _p.animUrls = null;
  }
  const urls = [];
  // 预载各帧。给每帧加失败与超时兜底：若某帧读取一直不 resolve /
  // 既不触发 onload 也不触发 onerror，Promise.all 会永久挂起导致整段动画
  // 停在第一帧——用 4s 超时 + onerror 兜底放行，动画照常轮换、跳过坏帧。
  const imgs = await Promise.all(
    _p.animFrames.map((f) => new Promise((res) => {
      const im = new Image();
      let done = false;
      const settle = (v) => { if (!done) { done = true; res(v); } };
      im.onload = () => settle(im);
      im.onerror = () => settle(null);
      loadImageSrc(f.path)
        .then((src) => {
          if (src) { im.src = src; }
          else settle(null);
        })
        .catch(() => settle(null));
      setTimeout(() => settle(null), 4000);
    })),
  );
  _p.animUrls = urls;

  const show = () => {
    if (!_p.animPlaying) return;
    const im = imgs[_p.animIdx];
    if (im) {
      _p.previewEl.innerHTML = "";
      const isHd = SkinManager.isHdPath(_p.animFrames[_p.animIdx].path);
      _p.imgW = isHd ? Math.max(1, im.naturalWidth / 2) : im.naturalWidth;
      _p.imgH = isHd ? Math.max(1, im.naturalHeight / 2) : im.naturalHeight;
      _p.img = im;
      im.className = "preview-img";
      _p.previewEl.appendChild(im);
      _centerImage();
      const label = document.createElement("div");
      label.className = "anim-label";
      label.textContent = `第 ${_p.animFrames[_p.animIdx].frame} 帧`;
      _p.previewEl.appendChild(label);
    }
    _p.animIdx = (_p.animIdx + 1) % _p.animFrames.length;
    _p.animTimer = setTimeout(show, 16); // 60fps，同官方动画速率
  };
  show();
}

function _stopAnimation() {
  _p.animPlaying = false;
  if (_p.animTimer) {
    clearTimeout(_p.animTimer);
    _p.animTimer = null;
  }
  const btn = _p.actionsEl && _p.actionsEl.querySelector('[data-role="anim-btn"]');
  if (btn) btn.textContent = "播放动画";
}

// ---------------------------------------------------------------------------
// 素材增删替换（与 Python 版逻辑一致）
// ---------------------------------------------------------------------------

async function _askHd(filename) {
  const mode = state.settings.hd_default;
  if (mode === "hd") return true;
  if (mode === "normal") return false;
  return confirmDialog({
    title: "@2x 高清素材",
    text: `是否将此素材标记为 @2x（高清）？\n\n选择"确定"：复制为 ${filename}@2x.png\n选择"取消"：复制为 ${filename}.png`,
    okText: "是",
  });
}

function _extOf(path) {
  const m = String(path).match(/\.([A-Za-z0-9]+)$/);
  return m ? "." + m[1].toLowerCase() : ".png";
}

async function _pickImages(title, folder, multi) {
  if (!backendAvailable()) return [];
  try {
    return await invoke("pick_files");
  } catch (e) {
    toast("选择文件失败：" + e.message, "error");
    return [];
  }
}

async function _addAsset(filename) {
  const mgr = state.manager;
  if (!mgr) return;
  const e = by_name(filename);
  const animatable = !!(e && e.animatable);
  const paths = await _pickImages(`选择 ${filename} 的素材`, mgr.folder, animatable);
  if (!paths.length) return;

  const addHd = await _askHd(filename);
  const multi = animatable && paths.length > 1;
  for (let idx = 0; idx < paths.length; idx++) {
    const src = paths[idx];
    const ext = _extOf(src);
    const base = multi ? `${filename}-${idx}` : filename;
    const destName = `${base}${addHd ? "@2x" : ""}${ext}`;
    const dest = mgr.folder.replace(/[\\/]+$/, "") + "/" + destName;
    try {
      await invoke("copy_file", { src, dest });
    } catch (exc) {
      toast(`复制失败：无法复制文件 ${exc.message}`, "error");
      return;
    }
  }
  await _postModify(filename);
}

async function _deleteAsset(filename, files) {
  if (!files || !files.length) return;
  const names = files.map((p) => "  - " + String(p).split(/[\\/]/).pop()).join("\n");
  const ok = await confirmDialog({
    title: "删除确认",
    text: `确定删除以下素材文件？\n\n${names}`,
    okText: "删除",
  });
  if (!ok) return;
  for (const p of files) {
    try {
      await invoke("delete_file", { path: p });
    } catch (exc) {
      toast(`无法删除 ${String(p).split(/[\\/]/).pop()}：${exc.message}`, "error");
      return;
    }
  }
  await _postModify(filename);
}

async function _replaceAsset(filename, files) {
  const mgr = state.manager;
  if (!mgr) return;
  const e = by_name(filename);
  const animatable = !!(e && e.animatable);
  const paths = await _pickImages(`选择替换 ${filename} 的素材`, mgr.folder, animatable);
  if (!paths.length) return;

  const addHd = await _askHd(filename);
  const multi = animatable && paths.length > 1;
  const dests = [];
  for (let idx = 0; idx < paths.length; idx++) {
    const src = paths[idx];
    const ext = _extOf(src);
    const base = multi ? `${filename}-${idx}` : filename;
    const destName = `${base}${addHd ? "@2x" : ""}${ext}`;
    const dest = mgr.folder.replace(/[\\/]+$/, "") + "/" + destName;
    if (src.replace(/[\\/]/g, "/").toLowerCase() === dest.replace(/[\\/]/g, "/").toLowerCase()) {
      dests.push(dest); // 源即目标：跳过复制，防止删除时误删
      continue;
    }
    try {
      await invoke("copy_file", { src, dest });
    } catch (exc) {
      toast(`复制失败：${exc.message}`, "error");
      return;
    }
    dests.push(dest);
  }
  // 先复制后删除；跳过本次目标
  const destSet = new Set(dests.map((d) => d.replace(/[\\/]/g, "/").toLowerCase()));
  for (const p of files) {
    const key = p.replace(/[\\/]/g, "/").toLowerCase();
    if (destSet.has(key)) continue;
    try {
      await invoke("delete_file", { path: p });
    } catch (e) { /* 删除失败不影响其它文件 */ }
  }
  await _postModify(filename);
}

async function _postModify(filename) {
  const mgr = state.manager;
  if (!mgr) return;
  await rescanSkin(); // 重新扫描，让增删/替换后的素材存在状态即时生效
  refreshPanel();
  emit("skin:modified", filename);
  _p.selected = filename;
  _updatePreview(filename);
}

// ---------------------------------------------------------------------------
// 展开状态持久化
// ---------------------------------------------------------------------------

function _saveOpenState() {
  if (!_p.tree) return;
  const state2 = state.expanded;
  let changed = false;
  for (const el of _p.tree.querySelectorAll("details[data-key]")) {
    const key = el.dataset.key;
    const val = el.open;
    if (state2[key] !== val) {
      state2[key] = val;
      changed = true;
    }
  }
  if (changed) persistSettings();
}

function _clearPreview() {
  _stopAnimation();
  _p.previewEl && (_p.previewEl.innerHTML = "");
  _p.infoEl && (_p.infoEl.textContent = "");
  _p.actionsEl && (_p.actionsEl.innerHTML = "");
}