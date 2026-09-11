// 游玩预览（Canvas）：根据 skin.ini [Mania] 设置绘制游玩舞台示意（16:9 / 16:10 可选）。
// 移植自 Python 版 StagePreview（OsuSkinMaker/gui.py），绘制逻辑保持一致：
// 参考坐标系 = 游戏区域高度固定 480 单位，宽度随画面比例变化；
// 面板以 ColumnStart 从左侧绝对定位，因此 mania 演奏面板整体偏左。
// 皮肤图片经后端 base64（loadImageSrc）加载，@2x 按官方规则减半为 1x 逻辑尺寸。

import { state, on, emit, persistSettings, rescanSkin } from "./state.js";
import { loadImageSrc } from "./api.js";
import { SkinManager } from "./manager.js";
import { NOTE_LAYOUT, findManiaSection } from "./skin_ini.js";
import { _num, _num_list, _choice, rgb_to_hex } from "./utilities.js";
import { modal } from "./components.js";

// ---------------------------------------------------------------------------
// 常量（与 Python 版一致）
// ---------------------------------------------------------------------------

// 判定评分可选值（对应皮肤 hitburst 命名，见 catalog 的“打击判定”分类）
const HIT_CHOICES = ["300g", "300", "200", "100", "50", "miss"];

// 判定评分值 -> 依次尝试的皮肤文件名（mania-* 优先，其次旧式 hit*）
const HIT_LOOKUP = {
  "300g": ["mania-hit300g", "hit300g"],
  "300": ["mania-hit300", "hit300"],
  "200": ["mania-hit200", "hit200"],
  "100": ["mania-hit100", "hit100"],
  "50": ["mania-hit50", "hit50"],
  "miss": ["mania-hit0", "hit0"],
};

// 判定评分值 -> skin.ini 中对应的 [Mania] 命令名
const HIT_INI_KEYS = {
  "300g": "Hit300g",
  "300": "Hit300",
  "200": "Hit200",
  "100": "Hit100",
  "50": "Hit50",
  "miss": "Hit0",
};

const NOTE_COLORS = ["#4fc3f7", "#ff8a65", "#fff176", "#aed581", "#f06292",
  "#ba68c8", "#4db6ac", "#ffd54f", "#90a4ae"];

// 数字/标点字符 -> 皮肤文件名后缀（前缀来自 [Fonts] ScorePrefix / ComboPrefix）
const DIGIT_FILES = {
  "0": "0", "1": "1", "2": "2", "3": "3", "4": "4",
  "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",
  ",": "comma", ".": "dot", "%": "percent", "x": "x",
};

// 暂停界面按钮（官方 SDK 基准：x768 满高 768；按钮纵坐标为 SD 高度，预览换算 ÷1.6）
const PAUSE_BUTTONS = [
  ["pause-continue", "继续", 224],
  ["pause-retry", "重试", 400],
  ["pause-back", "返回", 576],
];

// 失败界面按钮（官方仅「重试」与「返回」）
const FAIL_BUTTONS = [
  ["pause-retry", "重试", 400],
  ["pause-back", "返回", 576],
];

const MAGIC_SCALE = 1.6; // x768(SD) → x480 预览换算

const PAGES = ["游玩界面", "暂停界面", "失败界面", "成绩结算界面", "选歌界面"];

// ---------------------------------------------------------------------------
// 模块内部状态
// ---------------------------------------------------------------------------

let _p = {
  bar: null,        // 控制栏容器
  wrap: null,       // 画布容器
  canvas: null,
  ctx: null,
  pageSel: null,    // 页面下拉
  infoEl: null,     // 摘要文字
  aspectSel: null,  // 比例
  pickables: [],    // 本次绘制可点击元素 {filename, x, y, w, h}（绘制顺序 = 底层→顶层）
  hitStackKey: null, // 最近一次单击命中集的稳定键（供双击逐层向下）
  hitIdx: -1,
  hitPick: null,      // 当前选中的命中元素（用于绘制高亮框）
  imgCache: new Map(),   // path -> {img, w, h, failed}（w/h 为 @2x 减半后的 1x 逻辑尺寸）
  tintCache: new Map(),  // img + rgb -> 着色后的 canvas
  holdCache: new Map(),  // 长条 body 合成图缓存
  digitCache: new Map(), // (prefix, ch) -> 数字皮肤图路径
  timer: 0,
  resizeObs: null,
};

// ---------------------------------------------------------------------------
// 图片加载与基础绘制辅助
// ---------------------------------------------------------------------------

function _scheduleDraw() {
  // 皮肤/ini 变化后重绘前清空数字路径缓存，避免命中旧皮肤缓存的 null/旧路径
  if (_p.digitCache) _p.digitCache.clear();
  clearTimeout(_p.timer);
  _p.timer = setTimeout(_doDraw, 50);
}

/** 打开皮肤图片（带缓存；加载完成后自动触发重绘）。返回 {img,w,h,failed} 或 null。 */
function _imgEnt(path) {
  if (!path) return null;
  let ent = _p.imgCache.get(path);
  if (ent) return ent;
  ent = { img: null, w: 0, h: 0, failed: false };
  _p.imgCache.set(path, ent);
  loadImageSrc(path).then((src) => {
    if (!src) {
      ent.failed = true;
      _scheduleDraw();
      return;
    }
    const im = new Image();
    if (src.startsWith("blob:")) ent.url = src; // 供换皮肤时回收
    im.onload = () => {
      const w = im.naturalWidth, h = im.naturalHeight;
      if (SkinManager.isHdPath(path)) {
        // 与 Python 版一致：@2x 图按整数整除减半为 1x 像素（w//2, h//2）。
        // 注意必须用向下取整而非四舍五入：奇数尺寸的 @2x 精灵（如 combo/score 数字）
        // 若四舍五入会放大 1px，导致数字变扁（宽高比改变）并更贴下方 hitburst。
        // 后续所有源裁剪坐标（背景 Cover、长条 body 等）都基于 1x 逻辑尺寸。
        const iw = Math.max(1, Math.floor(w / 2));
        const ih = Math.max(1, Math.floor(h / 2));
        const half = document.createElement("canvas");
        half.width = iw;
        half.height = ih;
        half._srcKey = path; // canvas 无 src，供 tint 缓存区分
        const g = half.getContext("2d");
        g.imageSmoothingEnabled = true;
        g.drawImage(im, 0, 0, iw, ih);
        ent.img = half;
        ent.w = iw;
        ent.h = ih;
      } else {
        ent.img = im;
        ent.w = w;
        ent.h = h;
      }
      _scheduleDraw();
    };
    im.onerror = () => {
      ent.failed = true;
      _scheduleDraw();
    };
    im.src = src;
  });
  return ent;
}

/** 已加载完成的图片条目（未加载完成返回 null）。 */
function _imgEntLoaded(path) {
  const ent = _imgEnt(path);
  return ent && ent.img ? ent : null;
}

/** 把 img/canvas 元素绘制到画布（支持水平/垂直翻转）。 */
function _drawEl(el, dx, dy, dw, dh, flipH = false, flipV = false) {
  if (!el) return false;
  const ctx = _p.ctx;
  ctx.save();
  if (flipH || flipV) {
    ctx.translate(dx + (flipH ? dw : 0), dy + (flipV ? dh : 0));
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    ctx.drawImage(el, 0, 0, dw, dh);
  } else {
    ctx.drawImage(el, dx, dy, dw, dh);
  }
  ctx.restore();
  return true;
}

/** 按 (ent, dx, dy, dw, dh) 绘制皮肤图；未加载时返回 false。 */
function _drawEnt(ent, dx, dy, dw, dh, flipH = false, flipV = false) {
  return ent && ent.img ? _drawEl(ent.img, dx, dy, dw, dh, flipH, flipV) : false;
}

/** 逐像素乘法着色：仅乘算 RGB、保持 alpha 不变。
 * 等价 PIL ImageChops.multiply（alpha 通道相乘后因 tint alpha=255 而不变）；
 * canvas 的 "multiply" 混合模式会按源 alpha 重新合成，把透明区域填成 tint 色。 */
function _multiplyTint(g, w, h, rgb) {
  const d = g.getImageData(0, 0, w, h);
  const px = d.data;
  const r = rgb[0], gr = rgb[1], b = rgb[2];
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] > 0) {
      px[i] = Math.round(px[i] * r / 255);
      px[i + 1] = Math.round(px[i + 1] * gr / 255);
      px[i + 2] = Math.round(px[i + 2] * b / 255);
    }
  }
  g.putImageData(d, 0, 0);
}

/** 乘法混合着色（对应 osu! Multiplicative）。返回着色后的 canvas（带缓存）。 */
function _tintEl(el, rgb) {
  if (!el) return null;
  const key = (el.src || el._srcKey || "") + "|" + rgb.join(",");
  let c = _p.tintCache.get(key);
  if (c) return c;
  c = document.createElement("canvas");
  c.width = el.naturalWidth || el.width;
  c.height = el.naturalHeight || el.height;
  const g = c.getContext("2d");
  g.drawImage(el, 0, 0);
  _multiplyTint(g, c.width, c.height, rgb);
  _p.tintCache.set(key, c);
  return c;
}

/** 把图片逆时针旋转 90°，返回新的 canvas。
 * 注意：Canvas 的 rotate(θ) 在屏幕坐标（y 向下）中为顺时针，因此
 * 逆时针 90° 需用 rotate(-Math.PI/2) + translate(0, c.height)，
 * 与 PIL 的 Image.Transpose.ROTATE_90（逆时针）及官方 stable 一致。
 */
function _rot90(el) {
  const c = document.createElement("canvas");
  c.width = el.naturalHeight || el.height;
  c.height = el.naturalWidth || el.width;
  const g = c.getContext("2d");
  g.translate(0, c.height);
  g.rotate(-Math.PI / 2);
  g.drawImage(el, 0, 0);
  return c;
}

// ---------------------------------------------------------------------------
// 皮肤文件解析辅助（与 Python 版一致）
// ---------------------------------------------------------------------------

function _mgr() {
  return state.manager;
}

function _mgrPath(base) {
  const mgr = _mgr();
  if (!mgr || !base) return null;
  return mgr.pathFor(base);
}

function _mgrPathExact(base) {
  const mgr = _mgr();
  if (!mgr || !base) return null;
  return mgr.pathForExact(base);
}

/** “缺失组件显示默认组件”设置开关是否开启。 */
function _showDefaultOn() {
  return Boolean(state.settings.show_default);
}

/**
 * 按官方优先级解析素材路径，返回文件路径或 null：
 * 1. skin.ini 指定路径 → @2x 版本
 * 2. skin.ini 指定路径 → 原版
 * 3. 默认文件名 → @2x 版本
 * 4. 默认文件名 → 原版
 */
function _resolvePath(iniValue, ...defaultBases) {
  if (iniValue) {
    let probe = String(iniValue).trim().replace(/^"|"$/g, "");
    const m = probe.match(/\.(png|gif|jpg|jpeg)$/i);
    if (m) probe = probe.slice(0, -m[0].length);
    const p = _mgrPathExact(probe);
    if (p) return p;
  }
  for (const base of defaultBases) {
    if (base) {
      const p = _mgrPath(base);
      if (p) return p;
    }
  }
  return null;
}

function _parseRgba(text, defaultArr = [0, 0, 0, 255]) {
  const parts = text ? String(text).split(",").map((s) => s.trim()) : [];
  if (parts.length < 3) return defaultArr;
  const num = (s, d) => {
    const v = parseFloat(s);
    return Number.isNaN(v) ? d : Math.max(0, Math.min(255, Math.round(v)));
  };
  const a = parts.length >= 4 ? num(parts[3], defaultArr[3]) : defaultArr[3];
  return [num(parts[0], defaultArr[0]), num(parts[1], defaultArr[1]), num(parts[2], defaultArr[2]), a];
}

/** 读取 [Fonts] 数字前缀字段，区分"缺省"与"留空"（官方语义）：
 * 字段不存在 → 返回默认前缀；字段存在但值为空 → 返回 null（数字不可用，预览留空）。 */
function _fontPrefix(field, def) {
  const v = state.ini.get("Fonts", field);
  if (v === null || v === undefined) return def;
  const s = String(v).trim().replace(/^"|"$/g, "");
  return s === "" ? null : s;
}

/** 数字字符对应的皮肤图片路径（带缓存；prefix 为 null 或找不到返回 null）。 */
function _digitPath(prefix, ch) {
  const name = DIGIT_FILES[ch];
  const mgr = _mgr();
  if (!name || prefix == null || !mgr) return null;
  const key = prefix + "|" + ch;
  let hit = _p.digitCache.get(key);
  if (hit !== undefined) return hit;
  // 前缀是"路径+文件名"：直接以相对路径精确查找（含子目录）
  const stem = String(prefix).trim().replace(/^"|"$/g, "").replace(/[\\/]+$/, "");
  const path = mgr.pathForStem(stem ? `${stem}-${name}` : "-" + name);
  _p.digitCache.set(key, path);
  return path;
}

// ---------------------------------------------------------------------------
// 预览设置辅助
// ---------------------------------------------------------------------------

function _pv(key, def) {
  const v = state.preview[key];
  return v === undefined || v === null ? def : v;
}

function _commitPreview() {
  persistSettings();
}

// ---------------------------------------------------------------------------
// 各绘制子例程（与 Python 版一一对应）
// ---------------------------------------------------------------------------

/** 记录可点击元素，供单击/双击联动元素管理面板。 */
function _pick(filename, x, y, w, h) {
  _p.pickables.push({ filename, x, y, w, h });
}

/** 用皮肤数字图渲染一串字符；prefix 为 null（字段留空）时整体不绘制。 */
function _drawNumber(text, prefix, cx, cy, anchor, digitH, overlap, pickTag) {
  if (prefix == null) return;
  const ctx = _p.ctx;
  const items = [];
  for (const ch of String(text)) {
    const path = _digitPath(prefix, ch);
    const ent = path ? _imgEntLoaded(path) : null;
    let w = 0;
    if (ent && ent.h > 0) {
      w = ent.w * digitH / ent.h;
    } else {
      w = Math.max(digitH * 0.6, 1);
    }
    items.push({ ch, ent, w });
  }
  const n = items.length;
  const totalW = items.reduce((s, it) => s + it.w, 0) - overlap * (n - 1);
  let x = cx;
  if (anchor === "center") x = cx - totalW / 2;
  else if (anchor === "right") x = cx - totalW;
  for (const it of items) {
    if (it.ent) {
      _drawEl(it.ent.img, x, cy, it.w, digitH);
    } else {
      ctx.save();
      ctx.fillStyle = "#ffffff";
      ctx.font = `bold ${Math.max(digitH * 0.8, 8)}px "Microsoft YaHei UI"`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(it.ch, x + it.w / 2, cy + digitH / 2);
      ctx.restore();
    }
    x += it.w - overlap;
  }
  if (pickTag) _pick(pickTag, anchor === "right" ? cx - totalW : cx - (anchor === "center" ? totalW / 2 : 0), cy, totalW, digitH);
}

/** 绘制 osu!mania 血条（引擎硬编码规则：bg+colour 整体逆时针旋转 90°、缩放 0.7、÷1.6）。 */
function _drawScorebar(rightX, bottomY, scale) {
  const ctx = _p.ctx;
  const hp = 1.0; // 预览固定满血
  const shrink = 0.7;
  const posScale = 1.6; // x768 / x480 换算因子

  // 1) 锚点偏移：scorebar-marker 存在 -> (12,12)，否则 -> (5,16)
  const hasMarker = !!_mgrPath("scorebar-marker");
  const offX = hasMarker ? 12 : 5;
  const offY = hasMarker ? 12 : 16;

  const bgEnt = _imgEntLoaded(_mgrPath("scorebar-bg"));
  const colourEnt = _imgEntLoaded(_mgrPath("scorebar-colour"));

  if (!bgEnt && !colourEnt) {
    // 兜底：示意竖条（按 0.7 缩放、x768→x480 换算后的粗略尺寸，与 Python 版一致）
    const w = Math.max(6, Math.round(12 * scale * shrink / posScale));
    const h = Math.max(1, Math.round(480 * scale * shrink / posScale));
    ctx.fillStyle = "#20202a";
    ctx.fillRect(rightX, bottomY - h, w, h);
    ctx.strokeStyle = "#4a4a55";
    ctx.lineWidth = 1;
    ctx.strokeRect(rightX, bottomY - h, w, h);
    return;
  }

  // 2) 组合图层：bg 左上角为原点，colour 带锚点偏移叠加（满血保留整张）
  const bgW = bgEnt ? bgEnt.w : 757;
  const bgH = bgEnt ? bgEnt.h : 72;
  let cw = bgW, ch = bgH;
  if (colourEnt) {
    cw = Math.max(cw, offX + colourEnt.w);
    ch = Math.max(ch, offY + colourEnt.h);
  }
  const combo = document.createElement("canvas");
  combo.width = Math.max(1, cw);
  combo.height = Math.max(1, ch);
  const g = combo.getContext("2d");
  if (bgEnt) g.drawImage(bgEnt.img, 0, 0);
  if (colourEnt) {
    g.drawImage(colourEnt.img, offX, offY);
  } else {
    // 无 colour 图片：以半透明绿色示意血量
    g.fillStyle = "rgba(76,175,80,0.75)";
    g.fillRect(offX, offY, Math.max(1, Math.round((cw - offX) * hp)), Math.max(1, ch - offY));
  }

  // 3) 整体逆时针旋转 90° + 缩放 0.7 + x768→x480 换算（再乘画布 scale）
  const rot = _rot90(combo);
  const outW = Math.max(1, Math.round(rot.width * shrink / posScale * scale));
  const outH = Math.max(1, Math.round(rot.height * shrink / posScale * scale));
  // 锚定 sw：旋转后 bg 左上角（原左侧）位于血条左下角，贴场地底边向右上方延伸
  ctx.drawImage(rot, rightX, bottomY - outH, outW, outH);
  _pick("scorebar-colour", rightX, bottomY - outH, outW, outH);
  // 4) 血量标记（scorebar-marker）：同样旋转缩放后放在填充末端（满血 = 顶端）
  if (hasMarker) {
    const mEnt = _imgEntLoaded(_mgrPath("scorebar-marker"));
    if (mEnt) {
      const mrot = _rot90(mEnt.img);
      const mw = Math.max(1, Math.round(mrot.width * shrink / posScale * scale));
      const mh = Math.max(1, Math.round(mrot.height * shrink / posScale * scale));
      const mcx = rightX + outW / 2;
      const mcy = bottomY - outH; // 满血 fill_h = outH
      ctx.drawImage(mrot, mcx - mw / 2, mcy - mh / 2, mw, mh);
      _pick("scorebar-marker", mcx - mw / 2, mcy - mh / 2, mw, mh);
    }
  }
}

/** 舞台左右边框：垂直拉伸到舞台全高，宽度保持图片逻辑宽度（÷1.6 换算）。 */
function _drawStageSide(path, edgeX, topY, fullH, alignRight, tag) {
  const ctx = _p.ctx;
  const ent = _imgEntLoaded(path);
  if (ent && ent.h > 0) {
    const dispW = Math.max(1, Math.round(ent.w / 1.6 * (fullH / 480)));
    const x = alignRight ? edgeX - dispW : edgeX;
    _drawEnt(ent, x, topY, dispW, fullH);
    _pick(tag, x, topY, dispW, fullH);
    return;
  }
  if (!_showDefaultOn()) return;
  const w = Math.max(2, fullH * 0.018);
  const x0 = alignRight ? edgeX - w : edgeX;
  ctx.fillStyle = "#3a3a44";
  ctx.fillRect(x0, topY, w, fullH);
  _pick(tag, x0, topY, w, fullH);
}

/** 舞台底部：不拉伸，尺寸 = 图片 1x 逻辑尺寸 × scale，锚点 Bottom。 */
function _drawStageBottom(path, centerX, bottomY, scale, upside, tag) {
  const ctx = _p.ctx;
  const ent = path ? _imgEntLoaded(path) : null;
  if (ent) {
    const tw = Math.max(1, Math.round(ent.w * scale));
    const th = Math.max(1, Math.round(ent.h * scale));
    const x = centerX - tw / 2;
    const y = upside ? bottomY : bottomY - th;
    _drawEl(ent.img, x, y, tw, th);
    _pick(tag, x, y, tw, th);
    return;
  }
  if (!_showDefaultOn()) return;
  const w = Math.max(10, Math.round(120 * scale));
  const h = Math.max(10, Math.round(48 * scale));
  ctx.fillStyle = "#3a3a44";
  ctx.fillRect(centerX - w / 2, bottomY - h, w, h);
  _pick(tag, centerX - w / 2, bottomY - h, w, h);
}

/** 合成长条 body 图（带缓存）：0=拉伸，1=从顶级联，2=从底级联；ColourHold 覆盖颜色。 */
function _buildHoldBody(bodyPath, noteBodyStyle, bodyW, targetH, noteRefW, scale, holdRgba) {
  const key = `${bodyPath}|${noteBodyStyle}|${Math.round(bodyW)}|${Math.round(targetH)}|${noteRefW}|${scale}|${holdRgba.slice(0, 3).join(",")}`;
  let hit = _p.holdCache.get(key);
  if (hit) return hit;
  const ent = _imgEntLoaded(bodyPath);
  if (!ent || ent.w <= 0 || ent.h <= 0) return null;
  const iw = ent.w, ih = ent.h;
  const k = noteRefW / iw; // 公共缩放比
  const tileH = ih * k * scale; // 单张 body 等比后的高度（像素）
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bodyW));
  c.height = Math.max(1, Math.round(targetH));
  const g = c.getContext("2d");
  if (noteBodyStyle === 0) {
    // 拉伸样式：单张图直接拉伸填满（不保持宽高比）
    g.drawImage(ent.img, 0, 0, c.width, c.height);
  } else if (tileH >= targetH) {
    // 单张足够：按样式取向一侧裁剪
    const srcH = Math.max(1, Math.min(Math.round(targetH / k), ih));
    const sy = noteBodyStyle === 2 ? ih - srcH : 0;
    g.drawImage(ent.img, 0, sy, iw, srcH, 0, 0, c.width, c.height);
  } else {
    // 单张不够：等比缩放单张后平铺到所需高度（整张源图缩放到 列宽×step）
    const step = Math.max(1, Math.round(tileH));
    if (noteBodyStyle === 2) {
      for (let y = c.height - step; y > -step; y -= step) g.drawImage(ent.img, 0, 0, iw, ih, 0, y, c.width, step);
    } else {
      for (let y = 0; y < c.height; y += step) g.drawImage(ent.img, 0, 0, iw, ih, 0, y, c.width, step);
    }
  }
  // ColourHold 覆盖长条身体颜色（默认白色 = 不变，跳过乘算避免重建；
  // 与 PIL ImageChops.multiply 一致：仅乘 RGB、保持 alpha，透明区不染色）
  if (holdRgba[0] !== 255 || holdRgba[1] !== 255 || holdRgba[2] !== 255) {
    _multiplyTint(g, c.width, c.height, holdRgba);
  }
  const out = { canvas: c, srcW: iw };
  _p.holdCache.set(key, out);
  return out;
}

/** 绘制暂停界面（压暗 + pause-overlay + 三个按钮）。 */
function _drawPause(sx, sy, screenW, screenH, scale) {
  const ctx = _p.ctx;
  const cx = sx + screenW / 2;

  // 1) 游玩画面压暗约 70%
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.fillRect(sx, sy, screenW, screenH);

  // 2) 覆盖层：按 1x 原生尺寸 ÷1.6 渲染并居中
  const overlay = _resolvePath(null, "pause-overlay");
  const oEnt = overlay ? _imgEntLoaded(overlay) : null;
  if (oEnt && oEnt.w > 0 && oEnt.h > 0) {
    const ow = Math.max(1, Math.round(oEnt.w / 1.6 * scale));
    const oh = Math.max(1, Math.round(oEnt.h / 1.6 * scale));
    _drawEnt(oEnt, cx - ow / 2, sy + screenH / 2 - oh / 2, ow, oh);
    _pick("pause-overlay", cx - ow / 2, sy + screenH / 2 - oh / 2, ow, oh);
  }

  // 3) 三个按钮：Center 锚在画面中心，纵坐标按官方 SD 位置换算
  for (const [base, label, sdY] of PAUSE_BUTTONS) {
    const y = sy + (sdY / MAGIC_SCALE) * scale;
    const path = _resolvePath(null, base);
    const ent = path ? _imgEntLoaded(path) : null;
    let w = 0, h = 0;
    if (ent && ent.w > 0 && ent.h > 0) {
      w = Math.max(1, Math.round(ent.w / 1.6 * scale));
      h = Math.max(1, Math.round(ent.h / 1.6 * scale));
      _drawEnt(ent, cx - w / 2, y - h / 2, w, h);
    } else {
      ctx.save();
      ctx.fillStyle = "#ffffff";
      ctx.font = `bold ${Math.max(Math.round(26 * scale / MAGIC_SCALE), 9)}px "Microsoft YaHei UI"`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`[${label}]`, cx, y);
      w = Math.max(60 * scale / MAGIC_SCALE, 40);
      h = Math.max(30 * scale / MAGIC_SCALE, 22);
      ctx.restore();
    }
    _pick(base, cx - w / 2, y - h / 2, w, h);
  }
}

/** 绘制独立的失败界面（fail-background 铺满 + 两个按钮）。 */
function _drawFail(sx, sy, screenW, screenH, scale) {
  const ctx = _p.ctx;
  // 失败界面背景：仅使用专门组件 fail-background；
  // 皮肤未设置该组件则不显示背景（保持纯黑，不降级回退到 menu 背景）
  const fbPath = _mgrPath("fail-background");
  const ent = fbPath ? _imgEntLoaded(fbPath) : null;
  if (ent && ent.w > 0 && ent.h > 0) {
    // 与 Python 版一致：整体等比放大 cover 倍后，裁剪中间 screenW×screenH 区域
    // 铺满整屏（Cover），避免“放大后再偏移”造成的二次缩放/错位
    const iw = ent.w, ih = ent.h;
    const cover = Math.max(screenW / iw, screenH / ih);
    const srcW = screenW / cover;
    const srcH = screenH / cover;
    const srcX = Math.max(0, Math.round((iw - srcW) / 2));
    const srcY = Math.max(0, Math.round((ih - srcH) / 2));
    const tmp = document.createElement("canvas");
    tmp.width = Math.max(1, screenW);
    tmp.height = Math.max(1, screenH);
    tmp.getContext("2d").drawImage(ent.img, srcX, srcY, srcW, srcH, 0, 0, screenW, screenH);
    _drawEl(tmp, sx, sy, screenW, screenH);
    _pick("fail-background", sx, sy, screenW, screenH);
  } else {
    ctx.fillStyle = "#000000";
    ctx.fillRect(sx, sy, screenW, screenH);
  }

  const cx = sx + screenW / 2;
  for (const [base, label, sdY] of FAIL_BUTTONS) {
    const y = sy + (sdY / MAGIC_SCALE) * scale;
    const path = _resolvePath(null, base);
    const ent = path ? _imgEntLoaded(path) : null;
    let w = 0, h = 0;
    if (ent && ent.w > 0 && ent.h > 0) {
      w = Math.max(1, Math.round(ent.w / 1.6 * scale));
      h = Math.max(1, Math.round(ent.h / 1.6 * scale));
      _drawEnt(ent, cx - w / 2, y - h / 2, w, h);
    } else {
      ctx.save();
      ctx.fillStyle = "#ffffff";
      ctx.font = `bold ${Math.max(Math.round(26 * scale / MAGIC_SCALE), 9)}px "Microsoft YaHei UI"`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`[${label}]`, cx, y);
      w = Math.max(60 * scale / MAGIC_SCALE, 40);
      h = Math.max(30 * scale / MAGIC_SCALE, 22);
      ctx.restore();
    }
    _pick(base, cx - w / 2, y - h / 2, w, h);
  }
}

/** 绘制“跳过”按钮（play-skip，BottomRight 定位，仅游玩界面）。 */
function _drawPlaySkip(sx, sy, screenW, screenH, scale) {
  if (!_pv("skip", true)) return;
  const path = _resolvePath(null, "play-skip");
  const ent = path ? _imgEntLoaded(path) : null;
  if (ent && ent.w > 0 && ent.h > 0) {
    const w = Math.max(1, Math.round(ent.w / 1.6 * scale));
    const h = Math.max(1, Math.round(ent.h / 1.6 * scale));
    _drawEnt(ent, sx + screenW - w, sy + screenH - h, w, h);
    _pick("play-skip", sx + screenW - w, sy + screenH - h, w, h);
  }
}

// ---------------------------------------------------------------------------
// 主绘制流程（移植自 Python _draw）
// ---------------------------------------------------------------------------

function _draw(ctx, cw, ch) {
  const vals = _collectValues();
  const keys = Math.max(1, Math.min(18, parseInt(_num(vals.get("Keys"), 4), 10) || 4));
  const layout = NOTE_LAYOUT[keys] || Array(keys).fill("1");

  // 画面比例（16:9 / 16:10），据此在画布内拟合一块“屏幕”
  const aspect = _pv("aspect", "16:9") === "16:9" ? 16.0 / 9.0 : 16.0 / 10.0;
  const margin = 20;
  const availW = cw - 2 * margin;
  const availH = ch - 2 * margin;
  let screenW, screenH;
  if (availW / availH > aspect) {
    screenH = availH;
    screenW = availH * aspect;
  } else {
    screenW = availW;
    screenH = availW / aspect;
  }
  const sx = (cw - screenW) / 2;
  const sy = (ch - screenH) / 2;

  // 游戏区域高度固定 480 单位
  const scale = screenH / 480.0;
  const X = (x) => sx + x * scale;
  const upside = _bool(vals.get("UpsideDown"));
  const flipKeys = upside && !_boolFalse(vals.get("KeyFlipWhenUpsideDown"));
  const flipNotes = upside && !_boolFalse(vals.get("NoteFlipWhenUpsideDown"));
  const keysUnder = _bool(vals.get("KeysUnderNotes"));
  const split = _bool(vals.get("SplitStages")) && keys > 1;
  const stageSep = _num(vals.get("StageSeparation"), 40);
  const noteBodyStyle = parseInt(_choice(vals.get("NoteBodyStyle"), 1), 10) || 0;
  const noteRefW = _num(vals.get("WidthForNoteHeightScale"), 0);
  const cbStyle = parseInt(_choice(vals.get("ComboBurstStyle"), 1), 10) || 0;

  const Y = (y) => (upside ? sy + (480 - y) * scale : sy + y * scale);

  const colStart = _num(vals.get("ColumnStart"), 136);
  const widths = _num_list(vals.get("ColumnWidth"), 30, keys);
  const spacings = _num_list(vals.get("ColumnSpacing"), 0, keys);
  const lineWidths = _num_list(vals.get("ColumnLineWidth"), 2, keys + 1);
  const hitY = _num(vals.get("HitPosition"), 402);
  const lightY = _num(vals.get("LightPosition"), 413);

  // 计算列矩形
  let x = colStart;
  const cols = [];
  for (let i = 0; i < keys; i++) {
    cols.push([x, x + widths[i]]);
    x += widths[i] + spacings[i];
  }
  // 分离舞台：右半列整体右移
  const half = keys >> 1;
  if (split) {
    x = cols[half - 1][1] + stageSep;
    for (let i = half; i < keys; i++) {
      cols[i] = [x, x + widths[i]];
      x += widths[i] + spacings[i];
    }
  }
  const refW = noteRefW || Math.min(...widths.filter((w) => w > 0)) || 30;
  const stageLeft = cols[0][0];
  const stageRight = cols[cols.length - 1][1];
  const stageW = stageRight - stageLeft;

  const colLine = _parseRgba(vals.get("ColourColumnLine"), [255, 255, 255, 255]);
  const colLineColor = colLine[3] > 0 ? rgb_to_hex(colLine.slice(0, 3)) : null;
  const judgeLine = _parseRgba(vals.get("ColourJudgementLine"), [255, 255, 255, 255]);
  const judgeLineColor = rgb_to_hex(judgeLine.slice(0, 3));

  // 屏幕背景：优先皮肤 menu-background / menu-bg（等比覆盖铺满、居中裁掉溢出），否则纯黑
  let bgPath = null;
  if (_pv("bg", true)) {
    bgPath = _mgrPath("menu-background") || _mgrPath("menu-bg");
  }
  const bgEnt = bgPath ? _imgEntLoaded(bgPath) : null;
  if (bgEnt && bgEnt.w > 0 && bgEnt.h > 0) {
    const iw = bgEnt.w, ih = bgEnt.h;
    const cover = Math.max(screenW / iw, screenH / ih);
    const srcW = Math.round(screenW / cover);
    const srcH = Math.round(screenH / cover);
    const srcX = Math.max(0, Math.round((iw - srcW) / 2));
    const srcY = Math.max(0, Math.round((ih - srcH) / 2));
    const tmp = document.createElement("canvas");
    tmp.width = Math.max(1, screenW);
    tmp.height = Math.max(1, screenH);
    tmp.getContext("2d").drawImage(bgEnt.img, srcX, srcY, srcW, srcH, 0, 0, screenW, screenH);
    _drawEl(tmp, sx, sy, screenW, screenH);
    _pick("menu-background", sx, sy, screenW, screenH);
  } else {
    ctx.fillStyle = "#000000";
    ctx.fillRect(sx, sy, screenW, screenH);
  }

  // 失败界面：独立新开一块屏幕（不绘制游玩画面与血条）
  if (_pv("page", "游玩界面") === "失败界面") {
    _drawFail(sx, sy, screenW, screenH, scale);
    return;
  }

  // 列底
  for (let i = 0; i < cols.length; i++) {
    const [x0, x1] = cols[i];
    const rgba = _parseRgba(vals.get(`Colour${i + 1}`), [0, 0, 0, 255]);
    const fill = rgba[3] > 0 ? rgb_to_hex(rgba.slice(0, 3)) : "#1c1c22";
    ctx.fillStyle = fill;
    ctx.fillRect(X(x0), Y(0), (x1 - x0) * scale, 480 * scale);
  }

  // 血条（屏幕级 HUD）：移至舞台装饰之后绘制，避免被舞台底部/左右边框遮挡，
  // 与官方一致（HUD 位于 StageForeground 层之上）。贴屏幕底边、锚定最右轨道右侧，
  // 倒置时不随舞台翻转。绘制位置见下方 HUD 区块（与分数/连击同层）。
  // 列分隔线（xK 共 x+1 条）
  const lineXs = [cols[0][0]].concat(cols.map((c) => c[1]));
  for (let j = 0; j < lineXs.length; j++) {
    const lw = Math.max(0, lineWidths[j]) * scale;
    if (!colLineColor || lw <= 0) continue;
    ctx.strokeStyle = colLineColor;
    ctx.lineWidth = Math.max(1, Math.round(lw));
    ctx.beginPath();
    ctx.moveTo(X(lineXs[j]), Y(0));
    ctx.lineTo(X(lineXs[j]), Y(480));
    ctx.stroke();
  }

  // 小节线（barline）：预览展示在舞台中部 y=240
  const barlineRgba = _parseRgba(vals.get("ColourBarline"), [255, 255, 255, 255]);
  const barlineH = Math.max(0, _num(vals.get("BarlineHeight"), 1.2)) * scale;
  if (barlineRgba[3] <= 0) {
    ctx.strokeStyle = "#888888";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(X(stageLeft), Y(240));
    ctx.lineTo(X(stageRight), Y(240));
    ctx.stroke();
    ctx.setLineDash([]);
  } else if (barlineH > 0) {
    ctx.strokeStyle = rgb_to_hex(barlineRgba.slice(0, 3));
    ctx.lineWidth = Math.max(1, Math.round(barlineH));
    ctx.beginPath();
    ctx.moveTo(X(stageLeft), Y(240));
    ctx.lineTo(X(stageRight), Y(240));
    ctx.stroke();
  }

  // 舞台灯光（按压状态列 i >= keys//2，颜色按 ColourLight 着色）
  // 按需求纳入“显示默认组件”开关：关闭则隐藏按压灯光效果
  const lightPath = _resolvePath(vals.get("StageLight"), "mania-stage-light");
  if (lightPath && _showDefaultOn()) {
    const lightEnt = _imgEntLoaded(lightPath);
    for (let i = 0; i < cols.length; i++) {
      if (i < half) continue;
      const [x0, x1] = cols[i];
      const colLight = _parseRgba(vals.get(`ColourLight${i + 1}`), [55, 255, 255, 255]);
      const tinted = lightEnt ? _tintEl(lightEnt.img, colLight.slice(0, 3)) : null;
      if (tinted) {
        const lw = (x1 - x0) * scale;
        const lh = 30 * scale;
        _drawEl(tinted, X(x0), Y(lightY) - 15 * scale, lw, lh);
        _pick("mania-stage-light", X(x0), Y(lightY) - 15 * scale, lw, lh);
      }
    }
  }

  // 按键/接收器：宽度拉伸到轨道宽度、高度保持图片原逻辑高度（÷1.6）
  const drawKeys = () => {
    for (let i = 0; i < cols.length; i++) {
      const [x0, x1] = cols[i];
      const pressed = i >= half;
      const cmd = pressed ? `KeyImage${i}D` : `KeyImage${i}`;
      const fallback = pressed ? `mania-key${layout[i]}D` : `mania-key${layout[i]}`;
      const path = _resolvePath(vals.get(cmd), fallback);
      const ent = _imgEntLoaded(path);
      const keyW = (x1 - x0) * scale;
      const pickName = `mania-key${layout[i]}${pressed ? "D" : ""}`;
      if (ent && ent.h > 0) {
        const keyH = Math.max(1, ent.h * scale / 1.6);
        const x = X((x0 + x1) / 2) - keyW / 2;
        const y = upside ? Y(480) : Y(480) - keyH;
        _drawEnt(ent, x, y, keyW, keyH, false, flipKeys);
        _pick(pickName, x, upside ? y : y, keyW, keyH);
      } else if (_showDefaultOn()) {
        ctx.fillStyle = "#3a3a44";
        ctx.strokeStyle = "#ffffff";
        ctx.fillRect(X(x0), Y(hitY), keyW, Y(480) - Y(hitY));
        ctx.strokeRect(X(x0), Y(hitY), keyW, Y(480) - Y(hitY));
      }
    }
  };

  if (keysUnder) drawKeys();

  // 音符灯光（lightingN/lightingL）：判定线与轨道中心交点处，只画按压列
  // 同样纳入“显示默认组件”开关：关闭则隐藏灯光
  if (_showDefaultOn()) {
  const lightingN = _resolvePath(vals.get("LightingN"), "lightingN");
  const lightingL = _resolvePath(vals.get("LightingL"), "lightingL");
  const nWidths = _num_list(vals.get("LightingNWidth"), 0, keys);
  const lWidths = _num_list(vals.get("LightingLWidth"), 0, keys);
  for (let i = 0; i < cols.length; i++) {
    if (i < half) continue;
    const [x0, x1] = cols[i];
    const isLast = i === keys - 1;
    const path = isLast ? lightingL : lightingN;
    const wOverride = isLast ? lWidths[i] : nWidths[i];
    if (!path) continue;
    const ent = _imgEntLoaded(path);
    if (!ent || ent.w <= 0) continue;
    const wpx = wOverride > 0 ? wOverride * scale : (x1 - x0) * scale;
    const hpx = Math.max(1, Math.round(ent.h * wpx / ent.w));
    _drawEnt(ent, X((x0 + x1) / 2) - wpx / 2, Y(hitY) - hpx / 2, wpx, hpx);
    _pick(isLast ? "lightingL" : "lightingN", X((x0 + x1) / 2) - wpx / 2, Y(hitY) - hpx / 2, wpx, hpx);
  }
  }

  // 音符（判定线上方，模拟下落）：最右列留作长条
  const noteH = 44.0;
  for (let i = 0; i < cols.length; i++) {
    if (i === keys - 1) continue;
    const [x0, x1] = cols[i];
    const path = _resolvePath(vals.get(`NoteImage${i}`), `mania-note${layout[i]}`);
    const color = NOTE_COLORS[i % NOTE_COLORS.length];
    const ent = _imgEntLoaded(path);
    const colW = (x1 - x0) * scale;
    const pickName = `mania-note${layout[i]}`;
    for (const k of [1, 2, 3]) {
      const ny = hitY - k * 70;
      if (ny < 20) continue;
      if (ent && ent.w > 0) {
        const nh = Math.max(1, Math.round(ent.h * refW / ent.w * scale));
        const x = X((x0 + x1) / 2) - colW / 2;
        const y = upside ? Y(ny) : Y(ny) - nh;
        _drawEnt(ent, x, y, colW, nh, false, flipNotes);
        _pick(pickName, x, y, colW, nh);
      } else if (_showDefaultOn()) {
        ctx.fillStyle = color;
        const yTop = upside ? Y(ny) : Y(ny) - noteH * scale;
        ctx.fillRect(X(x0), yTop, colW, noteH * scale);
      }
    }
  }

  // 长条（LN / hold note）：展示在最右列
  const ln = keys - 1;
  const [lx0, lx1] = cols[ln];
  const lnColor = NOTE_COLORS[ln % NOTE_COLORS.length];
  const lnLen = 260.0;
  const lnW = (lx1 - lx0) * scale;
  const lnPick = `mania-note${layout[ln]}`;

  const headPath = _resolvePath(vals.get(`NoteImage${ln}H`), `mania-note${layout[ln]}H`);
  const headEnt = headPath ? _imgEntLoaded(headPath) : null;
  let headH = 0;
  if (headEnt && headEnt.w > 0) headH = Math.max(1, Math.round(headEnt.h * refW / headEnt.w * scale));
  const headCxY = hitY - (headH / scale) / 2;
  const lnTop = headCxY - lnLen;

  // 身体
  const bodyPath = _resolvePath(vals.get(`NoteImage${ln}L`), `mania-note${layout[ln]}L`);
  const holdRgba = _parseRgba(vals.get("ColourHold"), [255, 255, 255, 255]);
  const bodyOut = bodyPath
    ? _buildHoldBody(bodyPath, noteBodyStyle, lnW, lnLen * scale, refW, scale, holdRgba)
    : null;
  const bodyCanvas = bodyOut ? bodyOut.canvas : null;

  // 尾帽 cup
  const tailPath = _resolvePath(vals.get(`NoteImage${ln}T`), `mania-note${layout[ln]}T`);
  let tailCanvas = null;
  let tailW = 0, tailH = 0;
  if (tailPath) {
    const tEnt = _imgEntLoaded(tailPath);
    if (tEnt && tEnt.w > 0 && tEnt.h > 0) {
      const k = bodyOut ? refW / bodyOut.srcW : refW / tEnt.w;
      tailW = Math.max(1, Math.round(tEnt.w * k * scale));
      tailH = Math.max(1, Math.round(tEnt.h * k * scale));
      tailCanvas = tEnt.img;
    }
  }
  if (!tailCanvas && headPath) {
    // 无尾图：用头图（绘制时翻转形成"倒扣"盖子，见下方 !flipNotes）
    const hEnt = _imgEntLoaded(headPath);
    if (hEnt && hEnt.w > 0) {
      tailCanvas = hEnt.img;
      tailW = lnW;
      tailH = headH;
    }
  }

  if (bodyCanvas || headEnt || tailCanvas) {
    if (bodyCanvas) {
      const bx = X((lx0 + lx1) / 2) - lnW / 2;
      const by = upside ? Y(headCxY) : Y(lnTop);
      _drawEl(bodyCanvas, bx, by, lnW, lnLen * scale, false, flipNotes);
      _pick(`${lnPick}L`, bx, by, lnW, lnLen * scale);
    }
    if (headEnt) {
      const hx = X((lx0 + lx1) / 2) - lnW / 2;
      const hy = upside ? Y(hitY) : Y(hitY) - headH;
      _drawEnt(headEnt, hx, hy, lnW, headH, false, flipNotes);
      _pick(`${lnPick}H`, hx, hy, lnW, headH);
    }
    if (tailCanvas) {
      const tx = X((lx0 + lx1) / 2) - tailW / 2;
      const ty = Y(lnTop) - tailH / 2;
      // 尾帽"倒扣"在面条顶部：相对头部方向相反（头部 flipV=flipNotes，尾图取反）
      _drawEl(tailCanvas, tx, ty, tailW, tailH, false, !flipNotes);
      _pick(`${lnPick}T`, tx, ty, tailW, tailH);
    }
  } else if (_showDefaultOn()) {
    ctx.fillStyle = lnColor;
    ctx.fillRect(X(lx0), Y(lnTop), lnW, Y(hitY) - Y(lnTop));
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(X(lx0), Y(hitY) - 8 * scale, lnW, 8 * scale);
  }

  if (!keysUnder) drawKeys();

  // 判定线（mania-stage-hint；分离模式每个舞台各画一条）
  const hintPath = _resolvePath(vals.get("StageHint"), "mania-stage-hint");
  const stageRanges = split
    ? [[cols[0][0], cols[half - 1][1]], [cols[half][0], cols[cols.length - 1][1]]]
    : [[stageLeft, stageRight]];
  for (const [sl, sr] of stageRanges) {
    const sw = sr - sl;
    const hEnt = hintPath ? _imgEntLoaded(hintPath) : null;
    if (hEnt && hEnt.w > 0) {
      // 判定线高度按图片宽高比缩放，但 1x1 占位图会把高度撑成与宽度等大
      // （th = sw*scale 的巨大方形），既影响观感也导致框选范围/高亮框错误。
      // 故限制高度不超过一个合理上限（按舞台宽的 20%，通常判定线远细于此）。
      const th = Math.max(1, Math.min(
        Math.round(hEnt.h * sw * scale / hEnt.w),
        Math.round(sw * scale * 0.2),
      ));
      const cx = X((sl + sr) / 2) - sw * scale / 2;
      const cy = Y(hitY) - th / 2;
      _drawEnt(hEnt, cx, cy, sw * scale, th);
      _pick("mania-stage-hint", cx, cy, sw * scale, th);
    } else {
      ctx.strokeStyle = judgeLineColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(X(sl), Y(hitY));
      ctx.lineTo(X(sr), Y(hitY));
      ctx.stroke();
    }
    // 额外的判定提示线（JudgementLine 命令）——无论 stage-hint 图片是否存在都绘制
    // （与原项目一致：置于 if/else 之外，独立于舞台提示线）
    if (_bool(vals.get("JudgementLine"))) {
      ctx.strokeStyle = judgeLineColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(X(sl), Y(hitY));
      ctx.lineTo(X(sr), Y(hitY));
      ctx.stroke();
    }
  }

  // 警告箭头（WarningArrow）
  const warningPath = _resolvePath(vals.get("WarningArrow"), "mania-warningarrow");
  if (_pv("warning", true) && warningPath) {
    const wEnt = _imgEntLoaded(warningPath);
    if (wEnt && wEnt.w > 0) {
      const wpx = Math.max(1, Math.round(stageW * 0.4 * scale));
      const hpx = Math.max(1, Math.round(wEnt.h * wpx / wEnt.w));
      _drawEnt(wEnt, X((stageLeft + stageRight) / 2) - wpx / 2, Y(480 * 0.35) - hpx / 2, wpx, hpx, upside);
      _pick("mania-warningarrow", X((stageLeft + stageRight) / 2) - wpx / 2, Y(480 * 0.35) - hpx / 2, wpx, hpx);
    }
  }

  // 舞台左右边框（StageForeground 层；分离模式每舞台各画一对）
  const leftPath = _resolvePath(vals.get("StageLeft"), "mania-stage-left");
  const rightPath = _resolvePath(vals.get("StageRight"), "mania-stage-right");
  let sideEdges = [];
  if (split) {
    sideEdges = [[cols[0][0], true], [cols[half - 1][1], false], [cols[half][0], true], [cols[cols.length - 1][1], false]];
  } else {
    sideEdges = [[cols[0][0], true], [cols[cols.length - 1][1], false]];
  }
  for (const [edgeX, alignRight] of sideEdges) {
    if (alignRight) {
      _drawStageSide(leftPath, X(edgeX), sy, 480 * scale, true, "mania-stage-left");
    } else {
      _drawStageSide(rightPath, X(edgeX), sy, 480 * scale, false, "mania-stage-right");
    }
  }

  // 舞台底部（StageForeground 层）
  const bottomPath = _resolvePath(vals.get("StageBottom"), "mania-stage-bottom");
  if (split) {
    for (const [sl, sr] of [[cols[0][0], cols[half - 1][1]], [cols[half][0], cols[cols.length - 1][1]]]) {
      _drawStageBottom(bottomPath, X((sl + sr) / 2), Y(480), scale, upside, "mania-stage-bottom");
    }
  } else {
    _drawStageBottom(bottomPath, X((stageLeft + stageRight) / 2), Y(480), scale, upside, "mania-stage-bottom");
  }

  // 连击图（ComboBurstStyle：0=左，1=右，2=两侧；右侧水平翻转）
  if (_pv("cb", true)) {
    let cbSides = [];
    if (cbStyle === 0) cbSides = [[X(stageLeft) - 6 * scale, "se", false]];
    else if (cbStyle === 2) cbSides = [[X(stageLeft) - 6 * scale, "se", false], [X(stageRight) + 6 * scale, "sw", true]];
    else cbSides = [[X(stageRight) + 6 * scale, "sw", true]];
    const comboburst = _mgrPath("comboburst-mania");
    for (const [edgeX, anchor, flipH] of cbSides) {
      const cbEnt = comboburst ? _imgEntLoaded(comboburst) : null;
      if (!cbEnt) continue;
      const cbH = (cbEnt.h / 1.6) * scale;
      const cbW = Math.max(1, Math.round(cbEnt.w * cbH / cbEnt.h));
      const dispAnchor = upside ? anchor.replace("s", "n") : anchor;
      // 与 Python 版一致：按 tkinter anchor 语义把锚点换算为左上角坐标
      let x = edgeX, y = Y(hitY);
      if (dispAnchor === "se") { x -= cbW; y -= cbH; }          // 右下
      else if (dispAnchor === "sw") { y -= cbH; }               // 左下
      else if (dispAnchor === "ne") { x -= cbW; }               // 右上
      // "nw"（左上）即原点，无需偏移
      _drawEnt(cbEnt, x, y, cbW, cbH, flipH, upside);
      _pick("comboburst-mania", x, y, cbW, cbH);
    }
  }

  // ColumnRight 边界标记
  const colRight = _num(vals.get("ColumnRight"), 19);
  if (colRight > stageRight + 1) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(X(colRight), Y(0));
    ctx.lineTo(X(colRight), Y(480));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ---- HUD：血条 / 分数 / 准确度 / 连击计数 / 判定评分 ----
  // 血条为 HUD 级元素，绘制在舞台装饰（StageForeground）之上、贴屏幕底边，
  // 锚定最右轨道右侧、向右上方延伸；倒置时不随舞台翻转。
  _drawScorebar(X(stageRight), sy + 480 * scale, scale);

  const stageCx = X((stageLeft + stageRight) / 2);
  const scorePrefix = _fontPrefix("ScorePrefix", "score");
  const comboPrefix = _fontPrefix("ComboPrefix", "combo");

  // 分数 / 准确度（屏幕右上角；x768→x480 ÷1.6；acc 高度 = 分数的 0.6 倍）
  const scoreImg = _imgEntLoaded(_digitPath(scorePrefix, "1"));
  const scoreH = (scoreImg ? scoreImg.h : 26) / 1.6 * scale;
  const scoreOverlap = _num(state.ini.get("Fonts", "ScoreOverlap"), 0) / 1.6 * scale;
  const hudRight = 14 / 1.6 * scale;
  const scoreY0 = sy + 10 / 1.6 * scale;
  _drawNumber(_pv("score", "1234567"), scorePrefix, sx + screenW - hudRight, scoreY0, "right", scoreH, scoreOverlap, "score-0");
  const accH = scoreH * 0.6;
  _drawNumber(_pv("acc", "100.00%"), scorePrefix, sx + screenW - hudRight, sy + 45 / 1.6 * scale, "right", accH, scoreOverlap);

  // 连击计数（场地水平居中，ComboPosition 为数字中心 Y）
  const comboY = _num(vals.get("ComboPosition"), 111);
  const comboImg = _imgEntLoaded(_digitPath(comboPrefix, "1"));
  const comboH = (comboImg ? comboImg.h : 44) / 1.6 * scale;
  const comboOverlap = _num(state.ini.get("Fonts", "ComboOverlap"), 0) / 1.6 * scale;
  _drawNumber(_pv("combo", "123"), comboPrefix, stageCx, Y(comboY) - comboH / 2, "center", comboH, comboOverlap, "combo-0");

  // 判定评分 / hitburst（垂直 = ScorePosition；分离且 SeparateScore=1 时取右舞台）
  const scoreYPos = _num(vals.get("ScorePosition"), 300);
  let hbCx = stageCx;
  if (split && _bool(vals.get("SeparateScore"))) {
    hbCx = X((cols[half][0] + cols[cols.length - 1][1]) / 2);
  }
  const hitValue = _pv("hit", "300g");
  let hitburstPath = null;
  if (HIT_LOOKUP[hitValue]) {
    const iniKey = HIT_INI_KEYS[hitValue];
    const iniPath = iniKey ? vals.get(iniKey) : null;
    for (const base of HIT_LOOKUP[hitValue]) {
      hitburstPath = _resolvePath(iniPath, base);
      if (hitburstPath) break;
    }
  }
  const hbTag = HIT_LOOKUP[hitValue] ? HIT_LOOKUP[hitValue][0] : "mania-hit";
  if (hitburstPath) {
    const hbEnt = _imgEntLoaded(hitburstPath);
    const hbH = (hbEnt ? hbEnt.h : 40) / 1.6 * scale;
    if (hbEnt && hbEnt.w > 0) {
      const hbW = Math.max(1, Math.round(hbEnt.w * hbH / hbEnt.h));
      const hbCy = Y(scoreYPos); // 判定评分垂直居中于 Y(ScorePosition)（与原项目一致，无偏移）
      _drawEnt(hbEnt, hbCx - hbW / 2, hbCy - hbH / 2, hbW, hbH);
      _pick(hbTag, hbCx - hbW / 2, hbCy - hbH / 2, hbW, hbH);
    }
  } else if (_showDefaultOn()) {
    ctx.save();
    ctx.fillStyle = "#ffd54f";
    ctx.font = `bold ${Math.max(Math.round(30 * scale / 1.6), 8)}px "Microsoft YaHei UI"`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(hitValue, hbCx, Y(scoreYPos));
    const tw = Math.max(40 * scale / 1.6, 24);
    const th = Math.max(30 * scale / 1.6, 18);
    ctx.restore();
    _pick(hbTag, hbCx - tw / 2, Y(scoreYPos) - th / 2, tw, th);
  }

  // 摘要信息
  const flags = [];
  if (upside) flags.push("倒置");
  if (split) flags.push(`分离(${Math.round(stageSep)})`);
  if (noteBodyStyle) flags.push(`长条样式${noteBodyStyle}`);
  if (cbStyle !== 1) flags.push("连击图" + (cbStyle === 0 ? "左" : "两侧"));
  _p.infoEl.textContent =
    `${keys}K | ${_pv("aspect", "16:9")} | 判定线 ${Math.round(hitY)} | 列起点 ${Math.round(colStart)} `
    + `| 列宽 ${widths.map((w) => Math.round(w)).join("/")}`
    + (flags.length ? " | " + flags.join(" | ") : "");

  // 页面切换：游玩界面在 HUD 之上绘制“跳过”按钮；暂停界面绘制覆盖层
  const page = _pv("page", "游玩界面");
  if (page === "游玩界面") _drawPlaySkip(sx, sy, screenW, screenH, scale);
  if (page === "暂停界面") _drawPause(sx, sy, screenW, screenH, scale);
}

// ---------------------------------------------------------------------------
// 数值收集
// ---------------------------------------------------------------------------

/** 当前编辑器选中的键数（与原项目 keys_var 一致）；编辑器未构建时默认 4。 */
function _currentKeys() {
  const sel = document.querySelector(".mania-keys");
  if (sel) {
    const k = parseInt(sel.value, 10);
    if (Number.isFinite(k) && k >= 1 && k <= 18) return k;
  }
  return 4;
}

/** 预览字段：键数跟随编辑器选择，字段取该键数对应的 [Mania] 段
 * （与原项目一致：vals 来自编辑器 UI，键数切换即切换所绘制的段）。
 * 注意与 Python 版 sec.get 一致：同一键出现多次时取第一个匹配值，
 * 而非最后覆盖（否则编辑第一个值后预览仍取旧值，表现为"改位置没反应"）。 */
function _collectValues() {
  const keys = _currentKeys();
  const sec = findManiaSection(state.ini, keys);
  const v = new Map();
  if (sec) {
    for (const e of sec.entries) {
      if (!e.isComment && e.key && !v.has(e.key)) v.set(e.key, e.value);
    }
  }
  v.set("Keys", String(keys));
  return v;
}

function _bool(v) {
  return v === true || String(v).toLowerCase() === "1" || String(v).toLowerCase() === "true" || String(v).toLowerCase() === "yes";
}

function _boolFalse(v) {
  return v === false || String(v).toLowerCase() === "0" || String(v).toLowerCase() === "false" || String(v).toLowerCase() === "no";
}

// ---------------------------------------------------------------------------
// 画布尺寸与主绘制
// ---------------------------------------------------------------------------

function _resize() {
  if (!_p.canvas || !_p.wrap) return;
  const dpr = window.devicePixelRatio || 1;
  const w = _p.wrap.clientWidth;
  const h = _p.wrap.clientHeight;
  _p.canvas.width = Math.max(1, Math.round(w * dpr));
  _p.canvas.height = Math.max(1, Math.round(h * dpr));
  _p.canvas.style.width = w + "px";
  _p.canvas.style.height = h + "px";
  _scheduleDraw();
}

function _doDraw() {
  clearTimeout(_p.timer);
  _p.timer = 0;
  const ctx = _p.ctx;
  if (!ctx || !_p.canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cw = _p.canvas.width / dpr;
  const ch = _p.canvas.height / dpr;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  _p.pickables = [];
  if (_p.infoEl) _p.infoEl.textContent = "";

  if (!state.skinFolder || !state.manager) {
    ctx.fillStyle = "#888";
    ctx.font = '14px "Microsoft YaHei UI"';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("请先打开皮肤文件夹", cw / 2, ch / 2);
    ctx.restore();
    return;
  }
  try {
    if (cw >= 60 && ch >= 60) _draw(ctx, cw, ch);
  } catch (e) {
    console.error("[preview] 绘制失败", e);
  }
  // 当前选中图层高亮框（点击/双击下钻后的视觉反馈；可在设置中开关/改色）
  const hp = _p.hitPick;
  if (hp && state.settings.click_select && state.settings.hitbox_show) {
    ctx.save();
    ctx.strokeStyle = state.settings.hitbox_color;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(hp.x, hp.y, hp.w, hp.h);
    ctx.restore();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 点击联动元素管理面板
// ---------------------------------------------------------------------------

function _pickAt(x, y) {
  const hits = [];
  for (const pk of _p.pickables) {
    if (x >= pk.x && x <= pk.x + pk.w && y >= pk.y && y <= pk.y + pk.h) hits.push(pk);
  }
  return hits; // 底层→顶层
}

/** 命中集合的稳定键（文件名 + 整取坐标），用于跨事件比较“同一位置同一组命中”。 */
function _hitsKey(hits) {
  return hits.map((h) => `${h.filename}@${Math.round(h.x)},${Math.round(h.y)}`).join("|");
}

function _selectPick(pk) {
  _p.hitPick = pk;
  emit("preview:element-selected", pk.filename);
  _scheduleDraw(); // 绘制选中高亮框
}

function _onCanvasClick(e) {
  if (!state.settings.click_select) return;
  const rect = _p.canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const hits = _pickAt(x, y);
  if (!hits.length) return;
  _p.hitStackKey = _hitsKey(hits);
  _p.hitIdx = hits.length - 1;
  _selectPick(hits[hits.length - 1]);
}

function _onCanvasDblClick(e) {
  if (!state.settings.click_select) return;
  const rect = _p.canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const hits = _pickAt(x, y);
  if (!hits.length) return;
  // 同一位置且命中集合与上次单击一致：从当前层向下一层移动
  let idx;
  if (_p.hitStackKey === _hitsKey(hits) && _p.hitIdx != null && hits.length > 1) {
    idx = (_p.hitIdx - 1 + hits.length) % hits.length;
  } else {
    idx = hits.length > 1 ? hits.length - 2 : 0;
  }
  _p.hitStackKey = _hitsKey(hits);
  _p.hitIdx = idx;
  _selectPick(hits[idx]);
}

// ---------------------------------------------------------------------------
// 控制栏（页面 / 比例 / 显示 / 数值 / 刷新）
// ---------------------------------------------------------------------------

function _buildBar() {
  const bar = document.createElement("div");
  bar.className = "preview-bar";

  // 页面选择
  const sel = document.createElement("select");
  sel.className = "text-input field-select preview-page";
  for (const p of PAGES) {
    const o = document.createElement("option");
    o.value = p;
    o.textContent = p;
    sel.appendChild(o);
  }
  sel.value = _pv("page", "游玩界面");
  sel.addEventListener("change", () => {
    state.preview.page = sel.value;
    _commitPreview();
    emit("preview:page-changed");
    _scheduleDraw();
  });
  bar.appendChild(sel);
  _p.pageSel = sel;

  // 比例
  const aspectGroup = document.createElement("div");
  aspectGroup.className = "preview-aspect";
  aspectGroup.appendChild(document.createElement("span")).textContent = "比例:";
  for (const a of ["16:9", "16:10"]) {
    const b = document.createElement("button");
    b.className = "btn btn-tool preview-btn-sm";
    b.textContent = a;
    b.dataset.val = a;
    b.addEventListener("click", () => {
      if (state.preview.aspect === a) return;
      state.preview.aspect = a;
      _commitPreview();
      _syncBar();
      _scheduleDraw();
    });
    aspectGroup.appendChild(b);
  }
  bar.appendChild(aspectGroup);

  // 显示 / 数值
  const showBtn = document.createElement("button");
  showBtn.className = "btn btn-tool preview-btn-sm";
  showBtn.textContent = "显示";
  showBtn.addEventListener("click", _openShowDialog);
  bar.appendChild(showBtn);

  const valBtn = document.createElement("button");
  valBtn.className = "btn btn-tool preview-btn-sm";
  valBtn.textContent = "数值";
  valBtn.addEventListener("click", _openValueDialog);
  bar.appendChild(valBtn);

  // 摘要
  const info = document.createElement("span");
  info.className = "preview-info";
  bar.appendChild(info);
  _p.infoEl = info;

  // 刷新
  const refreshBtn = document.createElement("button");
  refreshBtn.className = "btn btn-tool preview-btn-sm";
  refreshBtn.textContent = "刷新";
  refreshBtn.addEventListener("click", async () => {
    // 真正重新扫描皮肤文件夹（识别外部新增/删除/覆盖素材）；skin:reloaded 会触发重绘
    if (state.manager && state.skinFolder) {
      await rescanSkin();
    }
    _scheduleDraw();
  });
  bar.appendChild(refreshBtn);

  return bar;
}

function _syncBar() {
  if (_p.pageSel) _p.pageSel.value = _pv("page", "游玩界面");
  if (_p.aspectSel) {
    _p.aspectSel.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.val === state.preview.aspect);
    });
  }
}

function _openShowDialog() {
  const scroll = document.createElement("div");
  scroll.className = "modal-scroll";
  const rows = [
    ["显示背景图（menu-background）", "bg"],
    ["显示连击图（comboburst）", "cb"],
    ["显示警告箭头（mania-warningarrow）", "warning"],
    ["显示跳过按钮（play-skip）", "skip"],
  ];
  const commit = () => {
    _commitPreview();
    _scheduleDraw();
  };
  for (const [label, key] of rows) {
    const lab = document.createElement("label");
    lab.className = "opt checkbox";
    const inp = document.createElement("input");
    inp.type = "checkbox";
    inp.checked = !!_pv(key, true);
    inp.addEventListener("change", () => {
      state.preview[key] = inp.checked;
      commit();
    });
    const span = document.createElement("span");
    span.textContent = label;
    lab.append(inp, span);
    scroll.appendChild(lab);
  }
  const m = modal({ title: "预览显示开关", bodyEl: scroll, width: 420 });
  const closeBtn = document.createElement("button");
  closeBtn.className = "btn btn-tool";
  closeBtn.textContent = "关闭";
  closeBtn.addEventListener("click", () => m.close());
  scroll.appendChild(closeBtn);
}

function _openValueDialog() {
  const scroll = document.createElement("div");
  scroll.className = "modal-scroll";
  const mkInput = (label, key) => {
    const row = document.createElement("div");
    row.className = "modal-label";
    row.textContent = label;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "text-input";
    inp.value = _pv(key, "");
    row.appendChild(inp);
    scroll.appendChild(row);
    return inp;
  };
  const scoreInp = mkInput("分数:", "score");
  const accInp = mkInput("准确度:", "acc");
  const comboInp = mkInput("连击数:", "combo");

  const row = document.createElement("div");
  row.className = "modal-label";
  row.textContent = "中间评分:";
  const hitSel = document.createElement("select");
  hitSel.className = "text-input field-select";
  for (const h of HIT_CHOICES) {
    const o = document.createElement("option");
    o.value = h;
    o.textContent = h;
    hitSel.appendChild(o);
  }
  hitSel.value = _pv("hit", "300g");
  row.appendChild(hitSel);
  scroll.appendChild(row);

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const cancel = document.createElement("button");
  cancel.className = "btn btn-tool";
  cancel.textContent = "取消";
  const ok = document.createElement("button");
  ok.className = "btn btn-accent";
  ok.textContent = "确定";
  actions.append(cancel, ok);
  scroll.appendChild(actions);

  const m = modal({ title: "自定义预览数值", bodyEl: scroll, width: 420 });
  const done = () => {
    state.preview.score = scoreInp.value.trim() || "0";
    state.preview.acc = accInp.value.trim() || "0%";
    state.preview.combo = comboInp.value.trim() || "0";
    state.preview.hit = hitSel.value;
    _commitPreview();
    _scheduleDraw();
    m.close();
  };
  cancel.onclick = () => m.close();
  ok.onclick = done;
  scoreInp.addEventListener("keydown", (e) => { if (e.key === "Enter") done(); });
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/** 渲染预览区：控制栏 + 画布。 */
export function renderPreview() {
  const host = document.getElementById("preview-pane");
  host.innerHTML = "";
  host.className = "preview-host";

  const bar = _buildBar();
  host.appendChild(bar);

  const wrap = document.createElement("div");
  wrap.className = "preview-canvas-wrap";
  const canvas = document.createElement("canvas");
  canvas.className = "preview-canvas";
  wrap.appendChild(canvas);
  host.appendChild(wrap);

  _p.bar = bar;
  _p.wrap = wrap;
  _p.canvas = canvas;
  _p.ctx = canvas.getContext("2d");
  _p.aspectSel = bar.querySelector(".preview-aspect");
  _syncBar();

  canvas.addEventListener("click", _onCanvasClick);
  canvas.addEventListener("dblclick", _onCanvasDblClick);
  window.addEventListener("resize", _resize);
  if (!_p.resizeObs && typeof ResizeObserver !== "undefined") {
    _p.resizeObs = new ResizeObserver(_resize);
  }
  if (_p.resizeObs) _p.resizeObs.observe(wrap);

  _resize();

  // 数据联动
  on("skin:reloaded", () => {
    // 文件清单可能变化（重扫描/覆盖素材）：清空图片缓存并回收 Blob URL，重新加载
    for (const ent of _p.imgCache.values()) {
      if (ent && ent.url) URL.revokeObjectURL(ent.url);
    }
    _p.imgCache.clear();
    _scheduleDraw();
  });
  on("skin:opened", () => {
    // 换皮肤时回收旧皮肤的 Blob URL，并清空图片缓存
    for (const ent of _p.imgCache.values()) {
      if (ent && ent.url) URL.revokeObjectURL(ent.url);
    }
    _p.imgCache.clear();
    _scheduleDraw();
  });
  on("ini:changed", _scheduleDraw);
  on("settings:changed", _scheduleDraw);
  on("preview:element-selected", () => { /* 元素面板会自行处理 */ });
}

/** 触发预览重绘（防抖）。 */
export function refreshPreview() {
  _scheduleDraw();
}

/** 挂载预览控制栏（兼容旧调用；控制栏在 renderPreview 中已构建）。 */
export function mountPreviewActions() {
  /* 控制栏交互已在 renderPreview 中绑定 */
}
