// 游玩预览（Canvas）：根据 skin.ini [Mania] 设置绘制游玩舞台示意（16:9 / 16:10 可选）。
// 移植自 Python 版 StagePreview（OsuSkinMaker/gui.py），绘制逻辑保持一致：
// 参考坐标系 = 游戏区域高度固定 480 单位，宽度随画面比例变化；
// 面板以 ColumnStart 从左侧绝对定位，因此 mania 演奏面板整体偏左。
// 皮肤图片经后端 base64（loadImageSrc）加载，@2x 按官方规则减半为 1x 逻辑尺寸。

import { state, on, emit, persistSettings, rescanSkin, JUDGE_KEYS, PLAY_RATES } from "./state.js";
import { loadImageSrc, invoke, setWindowFullscreen } from "./api.js";
import { SkinManager } from "./manager.js";
import { NOTE_LAYOUT, findManiaSection } from "./skin_ini.js";
import { _num, _num_list, _choice, rgb_to_hex } from "./utilities.js";
import { modal, toast } from "./components.js";
import { parseOsuBeatmap, bisectLeft } from "./osu_parser.js";

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

const PAGES = ["静态游玩预览", "动态游玩预览", "暂停界面", "失败界面", "成绩结算界面", "选歌界面"];

// 动态预览滚动参数（官方 DrawableManiaRuleset）：
//   ComputeScrollTime(speed) = MAX_TIME_RANGE / speed（MAX_TIME_RANGE = 11485，speed 1~40）
//   音符线速度 = 基准距离 × speed / 11485（unit/ms）；基准距离取默认判定线到屏幕顶端的 402
//   改判定线高度时可见提前量按 (hitY / 402) 等比缩放，速度恒定（见 _playScrollVel）
const PLAY_BASE_MS_VISIBLE = 11485;
const PLAY_REF_HIT_Y = 402;     // 官方 DEFAULT_HIT_POSITION：默认判定线距屏幕顶端 402（unit）
const PLAY_HIT_FLASH = 180;     // 打击后按键/灯光保留时长（ms）
const PLAY_KEY_RELEASE_DELAY = 80; // 官方 LegacyKeyArea：松开后 Delay(80) 才切回抬起图
const PLAY_LIGHT_OUT = 250;     // 官方 LegacyColumnBackground：松开后 250ms 淡出并纵向压扁
const PLAY_SPEED_MIN = 1, PLAY_SPEED_MAX = 40;
const PLAY_LIGHT_FPS_DEFAULT = 60; // 官方 LightFramePerSecond 默认 60（解码器把 ≤0 归为 24）
// 旧版皮肤动画默认帧长（官方 LegacySkinExtensions.SIXTY_FRAME_TIME = 1000 / 60）：
// 音符 / 长条头尾等未显式指定帧长的动画都按此帧率播放。
const PLAY_ANIM_60FPS_MS = 1000 / 60;
// 音符 / 长条动画的计时原点偏移（官方 DrawableHitObject.UpdateState：
// AnimationStartTime = HitObject.StartTime - InitialLifetimeOffset，mania 未覆写
// InitialLifetimeOffset → 取 DrawableHitObject 默认值 10000ms）。
const PLAY_ANIM_LIFETIME_OFFSET = 10000;
// 打击爆炸动画总时长（官方 LegacyHitExplosion / LegacyBodyPiece：
// frameLength = max(1000/60, 170 / 帧数)，即整段动画约 170ms 播完）
const PLAY_ANIM_EXPLODE_SPAN = 170;
// 判定图动画帧长（官方 ManiaLegacySkinTransformer.getResult：frameLength = 1000 / 20）
const PLAY_ANIM_JUDGE_MS = 1000 / 20;
// 判定线贴图（mania-stage-hint）的纵向缩放：官方 LegacyHitTarget 的 Sprite 设
// Scale = (1, 0.9 × 1.6025)，且 RelativeSizeAxes = X（宽度拉伸到舞台宽，不按比例）。
// 0.9 × 1.6025 是 768 空间下的系数，换算到 480 空间再 ÷1.6。
const PLAY_HINT_SCALE_Y = 0.9 * 1.6025 / 1.6; // ≈ 0.9014
// 判定提示线（JudgementLine）对应的 Box：Height = 1（768 空间 → 480 空间 ÷1.6），
// Alpha = 0.9（官方 LegacyHitTarget），且竖直方向与提示线贴图中心对齐。
const PLAY_JUDGE_LINE_H = 1 / 1.6;
const PLAY_JUDGE_LINE_ALPHA = 0.9;
// 列分隔线宽度缩放：官方 LegacyStageBackground 的列线 Container 设 Scale = (0.740, 1)
// （只压横向宽度，纵向仍铺满）。
const PLAY_COL_LINE_SCALE = 0.740;
// 连击数字跳动（官方 LegacyManiaComboCounter.onCountIncrement）：
// 每次连击 +1 时瞬时 ScaleTo(1, 1.4)，再 300ms Out 缓动回 (1, 1)（横向不变，纵向拉伸）。
const PLAY_COMBO_PUNCH_MS = 300;
const PLAY_COMBO_PUNCH_SCALE_Y = 1.4;

// HUD 分数 / 准确率滚动（官方 RollingCounter.TransformCount）：
// 目标值变化时从「当前显示值」在固定时长内按 Easing.OutQuad 缓动到新值，
// 中途再次变化则打断上一次动画、从打断瞬间的显示值重新起步。
// LegacyScoreCounter：RollingDuration 1000 / Easing.Out；
// LegacyAccuracyCounter（PercentageCounter）：RollingDuration 375 / Easing.OutQuad。
const PLAY_ROLL_SCORE_MS = 1000;
const PLAY_ROLL_ACC_MS = 375;

// 分数 / 准确率的等宽步进（官方 LegacySpriteText.FixedWidth，
// LegacyScoreCounter 与 LegacyAccuracyCounter 均设为 true）：
// 数字一律按参考字符 '5' 的宽度步进，',' '.' '%' 例外（仍用自身宽度）。
// 步进固定后整串宽度不随数值变化，数值滚动时不会左右伸缩。
const PLAY_FIXED_WIDTH_REF = "5";
const PLAY_FIXED_WIDTH_EXCLUDE = ",.%";

// 血条（官方 LegacyHealthDisplay / HealthDisplay / ManiaHealthProcessor）：
//   - 初始满血；mania 无自然掉血，只在判定时增减（Meh/Miss 掉血，其余回血，clamp 到 [0,1]）
//   - 显示血量 Current 启动时从 0 起每 150ms +0.05 填充到当前血量（约 3s），此后直接跟随血量
//   - fill 宽度对 Current × 满宽逐帧做 200ms OutQuint 平滑（官方 Interpolation.ValueAt）
//   - 血量上升时 marker.Bulge()：瞬时 1.2，再 150ms 线性回落到 0.8
//   - 命中判定（非 miss）与启动填充的每一步触发 Flash：explode 精灵 120ms 内 1 → 1.6
//     （血量 ≥ 0.5 时 1 → 2）并同步淡出，血量 ≥ 0.5 时改用 Additive 混合
const PLAY_HP_EPIC = 0.5;
const PLAY_HP_SMOOTH_MS = 200;
const PLAY_HP_INIT_STEP = 0.05;
const PLAY_HP_INIT_MS = 150;
const PLAY_HP_BULGE_PEAK = 1.2;
const PLAY_HP_BULGE_END = 0.8;
const PLAY_HP_BULGE_MS = 150;
const PLAY_HP_FLASH_MS = 120;

// 打击反馈时长（官方 LegacyHitExplosion：FadeIn 80 + FadeOut 120）
const PLAY_EXPLODE_IN = 80, PLAY_EXPLODE_OUT = 120;
// 判定图时长（官方 LegacyManiaJudgementPiece：FadeIn 20 + Delay 160 + FadeOut 40）
const PLAY_JUDGE_IN = 20, PLAY_JUDGE_HOLD = 160, PLAY_JUDGE_OUT = 40;
const PLAY_JUDGE_TOTAL = PLAY_JUDGE_IN + PLAY_JUDGE_HOLD + PLAY_JUDGE_OUT;
// 判定图 miss 曲线（官方 LegacyManiaJudgementPiece.PlayAnimation 的 Miss 分支）：
// ScaleTo(1.2) 瞬时后 100ms Out 回到 1；RotateTo(0) 后 100ms Out 转到随机 ±5.73°
const PLAY_JUDGE_MISS_SCALE = 1.2;
const PLAY_JUDGE_MISS_MS = 100;
const PLAY_JUDGE_MISS_ROT = 5.73;

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
  animCache: new Map(),  // (ini 值|默认名) -> 动画帧文件路径列表
  holdCache: new Map(),  // 长条 body 合成图缓存
  digitCache: new Map(), // (prefix, ch) -> 数字皮肤图路径
  timer: 0,
  resizeObs: null,
  host: null,            // 预览容器（.preview-host），用于把控制行放到画布下方
  play: null,            // 动态预览状态（见 _playReset）
  fullscreen: false,     // 是否处于全屏播放（F11 / 控制行按钮）
  fsDom: false,          // 是否走了 DOM 全屏回退（仅浏览器调试环境，需监听 Esc 退出）
  fsKeysBound: false,    // F11 快捷键是否已绑定（renderPreview 会被重复调用）
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

/**
 * 动画帧文件路径列表（官方 LegacySkinExtensions.GetAnimation 语义）：
 * 先试「名-0、名-1 …」连续编号帧，无编号帧时回退单张「名」。
 * 返回路径数组（可能为空）；按名缓存，换皮肤时随 imgCache 一并清空。
 */
function _animPaths(iniValue, base) {
  const names = [];
  if (iniValue) {
    let probe = String(iniValue).trim().replace(/^"|"$/g, "");
    const m = probe.match(/\.(png|gif|jpg|jpeg)$/i);
    if (m) probe = probe.slice(0, -m[0].length);
    if (probe) names.push(probe);
  }
  if (!names.includes(base)) names.push(base);
  const key = names.join("|");
  const cached = _p.animCache.get(key);
  if (cached) return cached;

  let out = [];
  for (const name of names) {
    const frames = [];
    for (let i = 0; i < 1024; i++) {
      const p = _mgrPath(`${name}-${i}`);
      if (!p) break;
      frames.push(p);
    }
    if (frames.length) { out = frames; break; }
    const single = _mgrPath(name);
    if (single) { out = [single]; break; }
  }
  _p.animCache.set(key, out);
  return out;
}

/**
 * 依次尝试若干候选名，返回第一个存在的动画帧序列（官方 GetAnimation 的回退链：
 * ini 指定名 → 默认名，各自先试 -N 序列帧再回退单张）。
 */
function _animPathsAny(iniValue, ...bases) {
  for (const base of bases) {
    const paths = _animPaths(iniValue, base);
    if (paths.length) return paths;
  }
  return [];
}

/**
 * 从动画帧序列取当前帧（官方 osu.Framework Animation 语义）：
 * 每帧 frameLen 毫秒，elapsed 为动画已播放时长；loop = false 时播完停在末帧。
 * 单帧素材（非动画）恒返回该帧。
 */
function _animEnt(paths, elapsed, frameLen, loop) {
  if (!paths || !paths.length) return null;
  if (paths.length === 1) return _imgEntLoaded(paths[0]);
  const n = paths.length;
  const i = Math.floor(Math.max(0, elapsed) / Math.max(1, frameLen));
  return _imgEntLoaded(paths[loop ? ((i % n) + n) % n : Math.min(i, n - 1)]);
}

/**
 * [General] AnimationFramerate 决定的帧长（官方 LegacySkinExtensions.getFrameLength）：
 * 值 > 0 → 1000 / 值；否则（缺省 -1）视为「1 秒播完所有帧」→ 1000 / 帧数。
 */
function _animConfigFrameLen(paths) {
  const rate = _num(state.ini ? state.ini.get("General", "AnimationFramerate") : null, 0);
  return rate > 0 ? 1000 / rate : 1000 / Math.max(1, paths.length);
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

/** 官方 LegacyColourCompatibility.ApplyWithDoubledAlpha：
 * Alpha 属性与 Colour.A 相乘（Colour 经 DisallowZeroAlpha），故最终 alpha = (A/255)²；
 * A = 0 时 Alpha 为 0，完全不可见。 */
function _doubledAlpha(rgba) {
  const a = (rgba && rgba[3] ? rgba[3] : 0) / 255;
  return a * a;
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

/** 用皮肤数字图渲染一串字符；prefix 为 null（字段留空）时整体不绘制。
 * tint（[r,g,b]）非空时对数字图做乘法着色（官方 Drawable.Colour 语义）。
 * scaleY（默认 1）为纵向缩放（官方 ScaleTo 的非等比缩放语义）：横向按图片宽高比、
 * 纵向拉伸，且围绕数字框的竖直中心伸缩（官方 Origin = Centre）。
 * fixedW 为真时启用等宽步进（官方 LegacySpriteText.FixedWidth）：数字按参考字符
 * 的宽度推进，图仍按自身宽高比绘制。 */
function _drawNumber(text, prefix, cx, cy, anchor, digitH, overlap, pickTag, tint, scaleY = 1, fixedW = false) {
  if (prefix == null) return;
  const ctx = _p.ctx;
  const dh = digitH * scaleY;
  const dy = cy + (digitH - dh) / 2;
  const fallbackW = Math.max(digitH * 0.6, 1);
  let refW = 0;
  if (fixedW) {
    const rp = _digitPath(prefix, PLAY_FIXED_WIDTH_REF);
    const re = rp ? _imgEntLoaded(rp) : null;
    refW = re && re.h > 0 ? re.w * digitH / re.h : fallbackW;
  }
  const items = [];
  for (const ch of String(text)) {
    const path = _digitPath(prefix, ch);
    const ent = path ? _imgEntLoaded(path) : null;
    const w = ent && ent.h > 0 ? ent.w * digitH / ent.h : fallbackW;
    items.push({ ch, ent, w, adv: fixedW && !PLAY_FIXED_WIDTH_EXCLUDE.includes(ch) ? refW : w });
  }
  const n = items.length;
  const totalW = items.reduce((s, it) => s + it.adv, 0) - overlap * (n - 1);
  let x = cx;
  if (anchor === "center") x = cx - totalW / 2;
  else if (anchor === "right") x = cx - totalW;
  for (const it of items) {
    if (it.ent) {
      const src = tint ? _tintEl(it.ent.img, tint) : null;
      _drawEl(src || it.ent.img, x, dy, it.w, dh);
    } else {
      ctx.save();
      ctx.fillStyle = tint ? `rgb(${tint[0]},${tint[1]},${tint[2]})` : "#ffffff";
      ctx.font = `bold ${Math.max(dh * 0.8, 8)}px "Microsoft YaHei UI"`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(it.ch, x + it.w / 2, dy + dh / 2);
      ctx.restore();
    }
    x += it.adv - overlap;
  }
  if (pickTag) _pick(pickTag, anchor === "right" ? cx - totalW : cx - (anchor === "center" ? totalW / 2 : 0), dy, totalW, dh);
}

/** 官方 LegacyHealthDisplay.getFillColour：血量越低 fill / marker 越暗，低于 0.2 后转红。
 * 插值走 LegacyUtils.InterpolateNonLinear（sRGB 空间线性，默认 Easing.None）。 */
function _scorebarFillColour(hp) {
  const BLACK = [0, 0, 0], WHITE = [255, 255, 255], RED = [255, 0, 0];
  const mix = (a, b, k) => [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
  if (hp < 0.2) return mix(BLACK, RED, Math.min(1, (0.2 - hp) / 0.2));
  if (hp < PLAY_HP_EPIC) return mix(WHITE, BLACK, Math.min(1, (PLAY_HP_EPIC - hp) / PLAY_HP_EPIC));
  return WHITE;
}

/** marker 缩放（官方 LegacyMarker.Bulge）：瞬时 1.2，再 150ms 线性回落到 0.8。
 * bulgeAt 为 Infinity（尚未发生过 Bulge）时返回 1。 */
function _scorebarBulge(bulgeAt, t) {
  const dt = t - bulgeAt;
  if (!(dt >= 0)) return 1;
  if (dt >= PLAY_HP_BULGE_MS) return PLAY_HP_BULGE_END;
  return PLAY_HP_BULGE_PEAK + (PLAY_HP_BULGE_END - PLAY_HP_BULGE_PEAK) * (dt / PLAY_HP_BULGE_MS);
}

/**
 * 血条逐帧状态（对应官方 HealthDisplay.Update + LegacyHealthDisplay.Update）：
 *   cur      = HealthDisplay.Current（显示血量；启动时从 0 逐步填充，之后直接跟随血量）
 *   w        = LegacyHealthDisplay.fill.Width（对 cur × 满宽做 200ms OutQuint 平滑）
 *   bulgeAt  = 最近一次 marker.Bulge() 的时刻（血量上升超过 0.001 时触发）
 *   flashAt  = 最近一次 Flash() 的时刻（命中判定 / 启动填充每步）
 * 状态以谱面时间 t 驱动：暂停 / 拖动进度条时动画随之冻结，与官方一致。
 */
function _scorebarStep(stat, ev, t, maxW) {
  const p = _p.play;
  let sb = p.sb;
  if (!sb) {
    // seek 后 HUD 并未重新加载 → 不重播启动填充动画，直接对齐当前血量
    const snap = !!p.sbSnap;
    p.sbSnap = false;
    sb = p.sb = {
      t, k: stat.k, hp0: stat.hp, step: 0,
      init: !snap, initAt: t, cur: snap ? stat.hp : 0,
      lastCur: snap ? stat.hp : 0,
      w: snap ? null : 0, // null = 首帧直接对齐目标宽度
      bulgeAt: Infinity, flashAt: Infinity,
    };
  }
  // 官方 Math.Clamp(Clock.ElapsedFrameTime, 0, 200)
  const dt = Math.max(0, Math.min(t - sb.t, PLAY_HP_SMOOTH_MS));
  sb.t = t;

  // 1) 启动填充动画（官方 HealthDisplay.startInitialAnimation）：
  //    每 150ms 把 Current 抬高 0.05，并在该 150ms 内线性走过去（TransformBindableTo）；
  //    一旦 health 变化（首个判定到来）立即结束动画。
  if (sb.init) {
    if (stat.hp !== sb.hp0) {
      sb.init = false;
      sb.cur = stat.hp;
    } else {
      const e = Math.max(0, t - sb.initAt) / PLAY_HP_INIT_MS;
      const full = Math.floor(e), frac = e - full;
      sb.cur = full >= 1 ? Math.min(PLAY_HP_INIT_STEP * (full - 1 + frac), stat.hp) : 0;
      if (full !== sb.step) {
        sb.step = full;
        if (full >= 1) sb.flashAt = t; // 官方每步 Scheduler.AddOnce(Flash)
      }
      if (full >= 1 && Math.min(PLAY_HP_INIT_STEP * full, stat.hp) >= stat.hp) {
        sb.init = false;
        sb.cur = stat.hp;
      }
    }
  } else {
    sb.cur = stat.hp; // 官方 Update：Current.Value = health.Value
  }

  // 2) fill 宽度平滑（官方 Interpolation.ValueAt(…, 0, 200, Easing.OutQuint)）
  const targetW = sb.cur * maxW;
  if (sb.w == null) {
    sb.w = targetW;
  } else if (dt > 0) {
    const k = Math.min(1, dt / PLAY_HP_SMOOTH_MS);
    sb.w += (targetW - sb.w) * (1 - Math.pow(1 - k, 5));
  }

  // 3) HealthChanged：显示血量变化超过 0.001 且上升时 Bulge
  if (Math.abs(sb.cur - sb.lastCur) > 0.001) {
    if (sb.cur > sb.lastCur) sb.bulgeAt = t;
    sb.lastCur = sb.cur;
  }

  // 4) 新判定触发 Flash（官方 onNewJudgement：IsHit 才闪，miss 不闪）
  if (stat.k !== sb.k) {
    if (stat.k > sb.k) {
      for (let j = sb.k; j < stat.k; j++) {
        if (ev.r[j] !== "miss") { sb.flashAt = t; break; }
      }
    }
    sb.k = stat.k;
  }
  return sb;
}

/**
 * 绘制 osu!mania 血条（引擎硬编码规则：bg / fill / marker 整体逆时针旋转 90°、
 * 缩放 0.7、÷1.6 后贴场地右下角，见 LegacyHealthDisplay）。
 * 血量动画对齐官方 HealthDisplay + LegacyHealthDisplay（见 _scorebarStep）；
 * 静态预览不传 stat / ev，按满血不播动画绘制。
 */
function _drawScorebar(rightX, bottomY, scale, stat, ev, t) {
  const ctx = _p.ctx;
  const shrink = 0.7;
  const posScale = 1.6; // x768 / x480 换算因子
  const s = shrink / posScale * scale; // 1 个 768 空间单位 → 画布像素

  const bgEnt = _imgEntLoaded(_mgrPath("scorebar-bg"));
  // fill 贴图为动画序列（官方 LegacyHealthDisplay：GetAnimation("scorebar-colour",
  // true, true, startAtCurrentTime: false, applyConfigFrameRate: true)）：
  // 帧长取自 [General] AnimationFramerate（未设置时 1 秒播完所有帧）；
  // startAtCurrentTime = false → 动画自对局开始（t = 0）起从第 0 帧循环播放。
  // 尺寸基准取第 0 帧（官方 fill.Width 在贴图加载时确定，不随帧变化）。
  const colourPaths = _animPaths(null, "scorebar-colour");
  const colourFirst = _animEnt(colourPaths, 0, 1, false);
  const colourEnt = stat && ev ? _animEnt(colourPaths, t, _animConfigFrameLen(colourPaths), true) : colourFirst;

  if (!bgEnt && !colourFirst) {
    // 兜底：示意竖条（按 0.7 缩放、x768→x480 换算后的粗略尺寸，与 Python 版一致）
    const w = Math.max(6, Math.round(12 * s));
    const h = Math.max(1, Math.round(480 * s));
    ctx.fillStyle = "#20202a";
    ctx.fillRect(rightX, bottomY - h, w, h);
    ctx.strokeStyle = "#4a4a55";
    ctx.lineWidth = 1;
    ctx.strokeRect(rightX, bottomY - h, w, h);
    return;
  }

  // 新式 / 旧式：有 scorebar-marker 为新式（fill 与 marker 均按血量着色），否则旧式
  const isNew = !!_mgrPath("scorebar-marker");
  const offX = (isNew ? 7.5 : 3) * posScale;   // fill 在容器内的偏移（LegacyFill.Position）
  const offY = (isNew ? 7.8 : 10) * posScale;
  const bgW = bgEnt ? bgEnt.w : 757;
  const bgH = bgEnt ? bgEnt.h : 72;
  const fullW = colourFirst ? colourFirst.w : 0;   // maxFillWidth（fill.Width 的初始值）
  const fullH = colourFirst ? colourFirst.h : 0;
  const cw = Math.max(bgW, offX + fullW, 1);
  const ch = Math.max(bgH, offY + fullH, 1);

  // 静态预览（不传 stat / ev）：满血、不播动画，离屏画布跨帧复用
  let sb;
  if (stat && ev) {
    sb = _scorebarStep(stat, ev, t, fullW);
  } else {
    sb = _p.sbStatic || (_p.sbStatic = { cur: 1, bulgeAt: Infinity, flashAt: Infinity });
    sb.w = fullW;
  }
  const hp = sb.cur;
  const fw = Math.max(0, Math.min(sb.w, fullW));

  // 离屏画布（尺寸变化时重建）：main = 组合图层，a / b 供血量着色用
  let buf = sb.buf;
  if (!buf || buf.w !== cw || buf.h !== ch) {
    const mk = () => { const c = document.createElement("canvas"); c.width = cw; c.height = ch; return c; };
    buf = sb.buf = { w: cw, h: ch, main: mk(), a: mk(), b: mk() };
  }
  const g = buf.main.getContext("2d");
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
  g.clearRect(0, 0, cw, ch);
  if (bgEnt) g.drawImage(bgEnt.img, 0, 0);

  // marker 贴图：新式固定 scorebar-marker；旧式按血量切 ki / kidanger / kidanger2
  let markerEnt = null;
  if (isNew) {
    markerEnt = _imgEntLoaded(_mgrPath("scorebar-marker"));
  } else {
    const base = hp < 0.2 ? "scorebar-kidanger2" : hp < PLAY_HP_EPIC ? "scorebar-kidanger" : "scorebar-ki";
    markerEnt = _imgEntLoaded(_mgrPath(base));
  }

  // 新式：fill 与 marker 一起乘算着色（官方 Drawable.Colour）；≥0.5 时为白色，无需着色
  const tint = isNew && hp < PLAY_HP_EPIC ? _scorebarFillColour(hp) : null;
  const layer = tint ? buf.a.getContext("2d") : g;
  if (tint) {
    layer.globalCompositeOperation = "source-over";
    layer.clearRect(0, 0, cw, ch);
  }

  // fill：官方 LegacyFill 开了 Masking，按当前宽度裁剪 colour 纹理（取当前动画帧）
  const colourDraw = colourEnt || colourFirst;
  if (fw > 0) {
    if (colourDraw) {
      layer.save();
      layer.beginPath();
      layer.rect(offX, offY, fw, fullH);
      layer.clip();
      layer.drawImage(colourDraw.img, offX, offY);
      layer.restore();
    } else {
      layer.fillStyle = "rgba(76,175,80,0.75)";
      layer.fillRect(offX, offY, fw, Math.max(1, ch - offY));
    }
  }

  // marker：Origin = Centre，位置 = fill 末端（新式竖直居中，旧式贴 fill 上沿）
  const mcx = offX + fw;
  const mcy = offY + (isNew ? fullH / 2 : 0);
  const bulge = _scorebarBulge(sb.bulgeAt, t);
  if (markerEnt && markerEnt.w > 0) {
    const mw = markerEnt.w * bulge, mh = markerEnt.h * bulge;
    layer.drawImage(markerEnt.img, mcx - mw / 2, mcy - mh / 2, mw, mh);
  }

  if (tint) {
    // 乘算着色：先着色整层，再用 destination-in 把透明区域还原（canvas 的 multiply
    // 会按源 alpha 重新合成，把透明处填成 tint 色，与逐像素乘法语义不同）
    const gb = buf.b.getContext("2d");
    gb.globalCompositeOperation = "source-over";
    gb.clearRect(0, 0, cw, ch);
    gb.drawImage(buf.a, 0, 0);
    gb.globalCompositeOperation = "multiply";
    gb.fillStyle = `rgb(${tint[0]},${tint[1]},${tint[2]})`;
    gb.fillRect(0, 0, cw, ch);
    gb.globalCompositeOperation = "destination-in";
    gb.drawImage(buf.a, 0, 0);
    g.drawImage(buf.b, 0, 0);
  }

  // explode 精灵（官方 LegacyMarker.Flash）：不着色，命中判定与启动填充每步触发
  const dtf = t - sb.flashAt;
  if (markerEnt && markerEnt.w > 0 && dtf >= 0 && dtf < PLAY_HP_FLASH_MS) {
    const k = dtf / PLAY_HP_FLASH_MS;
    const out = 1 - Math.pow(1 - k, 2);                            // Easing.Out
    const sc = 1 + ((hp >= PLAY_HP_EPIC ? 2 : 1.6) - 1) * out;     // ScaleTo(1).Then().ScaleTo(…, 120, Out)
    const mw = markerEnt.w * sc, mh = markerEnt.h * sc;
    g.save();
    g.globalAlpha = Math.pow(1 - k, 2);                            // FadeOutFromOne(120, Out)
    if (hp >= PLAY_HP_EPIC) g.globalCompositeOperation = "lighter"; // Blending.Additive
    g.drawImage(markerEnt.img, mcx - mw / 2, mcy - mh / 2, mw, mh);
    g.restore();
  }

  // 整体逆时针旋转 90°：容器 (px, py) → 画布 (rightX + py·s, bottomY - px·s)，
  // 即 bg 左上角（px=0）落在血条底端，长度沿竖直方向向上延伸
  ctx.save();
  ctx.translate(rightX, bottomY);
  ctx.scale(s, s);
  ctx.rotate(-Math.PI / 2);
  ctx.drawImage(buf.main, 0, 0);
  ctx.restore();

  // 命中区域（供皮肤文件定位）：血条整体 + 当前 marker
  _pick("scorebar-colour", rightX, bottomY - cw * s, ch * s, cw * s);
  if (markerEnt && markerEnt.w > 0) {
    const mw = markerEnt.w * bulge * s, mh = markerEnt.h * bulge * s;
    _pick("scorebar-marker", rightX + mcy * s - mw / 2, bottomY - mcx * s - mh / 2, mw, mh);
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

/** 舞台底部：不拉伸，尺寸 = 图片 1x 逻辑尺寸 × scale，锚点 Bottom。缺失时不画默认方块。 */
function _drawStageBottom(path, centerX, bottomY, scale, upside, tag) {
  const ent = path ? _imgEntLoaded(path) : null;
  if (!ent) return;
  const tw = Math.max(1, Math.round(ent.w * scale));
  const th = Math.max(1, Math.round(ent.h * scale));
  const x = centerX - tw / 2;
  const y = upside ? bottomY : bottomY - th;
  _drawEl(ent.img, x, y, tw, th);
  _pick(tag, x, y, tw, th);
}

/**
 * NoteBodyStyle → 平铺锚点表（osu!stable / wiki 语义）。
 *
 * wiki（skin.ini，Version ≥ 2.5 起生效）：0 = Stretch / 1 = Cascade from top /
 * 2 = Cascade from bottom，默认 1；stable 枚举另含 3 = RepeatBottom、
 * 4 = RepeatTopAndBottom（wiki 未描述，此处按枚举字面含义补全）。
 * 对齐关系按「上 = 面尾（远端）、下 = 面头（判定线侧）」的逻辑朝向给出；
 * 倒置舞台时由 flipV 整体垂直镜像（见 _drawHoldBody）。
 *
 * @returns {Array<{fromTop:boolean, texBottom:boolean}>} 平铺起点；空数组 = 值不合法
 */
function _holdBodyAnchors(style) {
  switch (style) {
    case 1: // Cascade from top：从面尾起铺，贴图顶端(v=0)贴住面尾
      return [{ fromTop: true, texBottom: false }];
    case 2: // Cascade from bottom：从面头起铺，贴图底端(v=1)贴住面头
      return [{ fromTop: false, texBottom: true }];
    case 3: // RepeatBottom：从面头起铺，贴图顶端(v=0)贴住面头
      return [{ fromTop: false, texBottom: false }];
    case 4: // RepeatTopAndBottom：面尾、面头两端同时起铺
      return [
        { fromTop: true, texBottom: false },
        { fromTop: false, texBottom: true },
      ];
    default:
      return [];
  }
}

/**
 * 在像素区间 [top, bottom] 内把长条身体贴图按 tile 高度平铺一次。
 * @param {boolean} fromTop   true：从 top 端起铺；false：从 bottom 端起铺
 * @param {boolean} texBottom true：贴图底端(v=1)对齐起点；false：贴图顶端(v=0)对齐起点
 */
function _tileBodyInto(ctx, ent, dx, dw, top, bottom, tile, fromTop, texBottom) {
  if (!(tile > 0)) return;
  const n = Math.ceil((bottom - top) / tile);
  for (let i = 0; i < n; i++) {
    const y0 = fromTop ? top + i * tile : bottom - (i + 1) * tile; // 该张平铺的上边界
    const y1 = y0 + tile;
    const vt = Math.max(top, y0);
    const vb = Math.min(bottom, y1);
    if (vb <= vt) continue;
    // 起点到可见区两端的距离（0 = 起点所在边）→ 贴图内的归一化纵向坐标
    const dB = fromTop ? vt - y0 : y1 - vb;
    const dT = fromTop ? vb - y0 : y1 - vt;
    const vB = texBottom ? 1 - dB / tile : dB / tile;
    const vT = texBottom ? 1 - dT / tile : dT / tile;
    const srcH = ent.h * Math.abs(vT - vB);
    if (!(srcH > 0)) continue;
    // 目的矩形上下边界取整：相邻两片的边界由同一组网格位置递推得出，取整后仍严丝合缝，
    // 可避免亚像素定位产生的 1px 抗锯齿接缝（原实现即按整数 step 平铺）。
    const ya = Math.round(vt);
    const yb = Math.max(ya + 1, Math.round(vb));
    ctx.drawImage(ent.img, 0, ent.h * Math.min(vB, vT), ent.w, srcH, dx, ya, dw, yb - ya);
  }
}

/**
 * 把长条身体贴图绘制到像素区间 [top, bottom]（左边界 dx、宽 dw）。
 * style 0 = 整张贴图拉伸；1~4 = 按 _holdBodyAnchors 平铺；其余值退化为拉伸。
 * flipV = true 时整体垂直镜像（倒置舞台）；镜像轴取区间中点，而区间关于中点对称，
 * 故镜像后的可见区间仍是 [top, bottom]，内部平铺算式无需改动。
 *
 * @param {number} tile 单张平铺高度（像素，按 WidthForNoteHeightScale 等比换算）
 */
function _drawHoldBody(ctx, ent, dx, dw, top, bottom, tile, style, flipV) {
  const h = bottom - top;
  if (h <= 0 || !ent || ent.w <= 0 || ent.h <= 0) return;
  const anchors = _holdBodyAnchors(style);
  if (style === 0 || anchors.length === 0) {
    ctx.drawImage(ent.img, 0, 0, ent.w, ent.h, dx, top, dw, h);
    return;
  }
  if (flipV) {
    ctx.save();
    ctx.translate(0, top + bottom);
    ctx.scale(1, -1);
  }
  for (const a of anchors) _tileBodyInto(ctx, ent, dx, dw, top, bottom, tile, a.fromTop, a.texBottom);
  if (flipV) ctx.restore();
}

/** 合成长条 body 图（带缓存）。样式 0~4 语义见 _holdBodyAnchors。
 * 画布按「上 = 面尾、下 = 面头」的下落朝向生成，绘制时再由 flipNotes 决定是否镜像。
 * 长条身体颜色由贴图本身决定（ColourHold 在官方语义中是连击计数器颜色，不作用于身体）。 */
function _buildHoldBody(bodyPath, noteBodyStyle, bodyW, targetH, noteRefW, scale) {
  const key = `${bodyPath}|${noteBodyStyle}|${Math.round(bodyW)}|${Math.round(targetH)}|${noteRefW}|${scale}`;
  const hit = _p.holdCache.get(key);
  if (hit) return hit;
  const ent = _imgEntLoaded(bodyPath);
  if (!ent || ent.w <= 0 || ent.h <= 0) return null;
  const iw = ent.w;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bodyW));
  c.height = Math.max(1, Math.round(targetH));
  const g = c.getContext("2d");
  // 单张平铺高度 = 贴图按基准宽(noteRefW)等比缩放后的高度 × 像素倍率
  const tile = Math.max(1, (ent.h * noteRefW / iw) * scale);
  _drawHoldBody(g, ent, 0, c.width, 0, c.height, tile, noteBodyStyle, false);
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
// 动态预览：按时间驱动的动态下落渲染
// ---------------------------------------------------------------------------

function _playReset() {
  _p.play = {
    bm: null,        // 解析后的谱面
    keys: 4,         // 谱面键数（Clamp 到 [1,18]）
    audio: null,     // HTMLAudioElement
    audioUrl: null,
    playing: false,
    raf: 0,
    last: undefined, // 上一帧时间（手动时钟用）
    manualMs: 0,     // 无音频时的节目时间（ms）
    clock: null,     // 音频主时钟锚点 {raw, at}（见 _playTimeMs）
    actx: null,      // 仅用于测量输出延迟的 AudioContext
    latencyMs: 0,    // 输出延迟（ms）
    latencyDone: false, // 是否已探测过输出延迟（一次性）
    events: null,    // 判定事件流（见 _playBuildEvents）
    roll: null,      // HUD 滚动计数器状态（分数 / 准确率，见 _playRoll）
    sb: null,        // 血条动画状态（见 _scorebarStep）
    sbSnap: false,   // 血条下次建状态时是否跳过启动填充动画（seek 用）
    judgeKey: null,  // 生成 events 时用的判定权重快照（权重变化时据此重建）
    bgPath: null,    // 谱面自带背景图（游玩时替换皮肤 bg）
    speed: state.settings.play_speed, // 下落速度（1~40，越大下落越快；随设置持久化）
    rate: state.settings.play_rate,   // 播放倍速（整条时间轴与音乐同步变速；随设置持久化）
    // 进度条缓存（避免每帧重建）
    playBtn: null, progress: null, speedSel: null, speedVal: null, timeLbl: null, titleLbl: null, ctl: null,
    rateSel: null,    // 播放倍速选择框
    fsBtn: null,      // 全屏播放按钮
  };
  return _p.play;
}

/**
 * 输出延迟（ms）：让画面与「听到」的声音对齐。
 * HTMLAudioElement 不提供时间戳，退而用 AudioContext.outputLatency 估算；
 * 不支持时返回 0（不补偿）。
 */
function _playLatencyMs() {
  const p = _p.play;
  if (!p || p.latencyDone) return p ? p.latencyMs : 0;
  p.latencyDone = true;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      p.actx = p.actx || new AC();
      const v = p.actx.outputLatency || p.actx.baseLatency;
      if (isFinite(v) && v > 0) p.latencyMs = v * 1000;
    }
  } catch (e) { /* 不支持则不补偿 */ }
  return p.latencyMs || 0;
}

/**
 * 当前音乐绝对时间（ms）——音频主时钟（参考 SkinDeck）：
 * 以 audio.currentTime 为锚点、帧间用 performance.now() 单调插值，
 * 避免 currentTime 量化步进（4~16ms）造成的音符抖动；再扣除输出延迟。
 * 无音频时退回手动时钟。
 */
function _playTimeMs() {
  const p = _p.play;
  if (!p) return 0;
  const a = p.audio;
  if (!a || !isFinite(a.currentTime)) return p.manualMs;

  const raw = a.currentTime * 1000;
  if (a.paused || a.ended) { p.clock = null; return raw; }

  const now = performance.now();
  const rate = p.rate;
  const c = p.clock;
  // 首次、倍速变化、或与插值偏差过大（seek / 缓冲卡顿）→ 重新锚定
  if (!c || c.rate !== rate || Math.abs(raw - (c.raw + (now - c.at) * c.rate)) > 60) {
    p.clock = { raw, at: now, rate };
  } else {
    // 帧间按倍速外推：倍速播放时音频时间推进得更快，插值速率须同步放大
    const smooth = c.raw + (now - c.at) * c.rate;
    return Math.max(0, Math.min(smooth, raw + 120) - _playLatencyMs());
  }
  return Math.max(0, raw - _playLatencyMs());
}


function _playDurMs() {
  const p = _p.play;
  if (!p || !p.bm) return 0;
  const audioDur = p.audio && isFinite(p.audio.duration) ? p.audio.duration * 1000 : 0;
  return Math.max(audioDur, p.bm.durationMs, 1);
}

/** 音符下落线速度（unit/ms）：只由下落速度决定，与判定线高度无关。
 *  官方 DrawableManiaRuleset.updateTimeRange() 以 (768 - hitPosition) / (768 - DEFAULT_HIT_POSITION)
 *  缩放 TimeRange，从而让「判定线到屏幕顶端的距离」与可见时间同比例变化，速度保持恒定；
 *  本工具坐标系为 480 高、判定线距顶端 hitY，故基准距离取 402。 */
function _playScrollVel() {
  const p = _p.play;
  const sp = p && p.speed ? p.speed : 1;
  return PLAY_REF_HIT_Y * sp / PLAY_BASE_MS_VISIBLE;
}

/** 音频扩展名 -> MIME（Blob 无类型时 WebView2 可能拒绝解码）。 */
function _audioMime(path) {
  const ext = (path.match(/\.([^.\\/]+)$/) || [])[1];
  switch (ext && ext.toLowerCase()) {
    case "mp3": return "audio/mpeg";
    case "ogg": case "oga": return "audio/ogg";
    case "wav": return "audio/wav";
    case "flac": return "audio/flac";
    case "m4a": case "mp4": case "aac": return "audio/mp4";
    default: return "audio/mpeg";
  }
}

// ---- 判定事件流（预览用）---------------------------------------------------
// 预览没有真实输入，按「确定性伪随机」模拟一份判定分布，用来同时预览
// 判定图 / 打击爆炸 / 连击 / 分数 / 准确率。同一物件每帧结果一致。
// 权重可在设置中调整（judge_weights），总和不必为 1000 —— 内部按总和归一。

/** 当前判定权重表（顺序见 JUDGE_KEYS）；非法值按 0 处理。 */
function _judgeWeights() {
  const w = state.settings.judge_weights || {};
  const out = [];
  for (const k of JUDGE_KEYS) {
    const v = Number(w[k]);
    out.push([k, Number.isFinite(v) && v > 0 ? v : 0]);
  }
  if (!out.some(([, v]) => v > 0)) out[0] = [out[0][0], 1]; // 全 0 → 视为全 Perfect，避免除零
  return out;
}

/** 权重表快照（用于判断是否需要重建事件流）。 */
function _judgeKey() {
  return JUDGE_KEYS.map((k) => state.settings.judge_weights?.[k] ?? "").join("/");
}
/**
 * 官方 mania 计分（osu.Game.Rulesets.Mania.Scoring.ManiaScoreProcessor）。
 * 准确率基值 GetBaseScoreForResult：Perfect=305，其余取基类
 * （Great=300 / Good=200 / Ok=100 / Meh=50 / Miss=0）。
 */
const PLAY_BASE_SCORE = { "300g": 305, "300": 300, "200": 200, "100": 100, "50": 50, "miss": 0 };
/** 连击加成基值 getBaseComboScoreForResult：Perfect=300，其余同准确率基值。 */
const PLAY_COMBO_BASE = { "300g": 300, "300": 300, "200": 200, "100": 100, "50": 50, "miss": 0 };
/** 每判定连击加成的上限 log_4(400)（ManiaScoreProcessor.combo_base = 4）。 */
const PLAY_COMBO_LOG_MAX = Math.log(400) / Math.log(4);

/** 单个判定的连击加成分量：base × clamp(log₄(comboAfter), 0.5, log₄(400))。 */
function _playComboChange(res, comboAfter) {
  const base = PLAY_COMBO_BASE[res] || 0;
  if (base === 0) return 0;
  const v = Math.min(Math.max(0.5, Math.log(comboAfter) / Math.log(4)), PLAY_COMBO_LOG_MAX);
  return base * v;
}

/** 按权重表取该物件的判定结果（确定性：同 seed 恒同结果）。 */
function _playJudge(seed, table) {
  let total = 0;
  for (const [, w] of table) total += w;
  const h = (Math.imul(seed + 1, 2654435761) >>> 0) % total;
  let acc = 0;
  for (const [res, w] of table) {
    acc += w;
    if (h < acc) return res;
  }
  return table[0][0];
}

/**
 * mania 单次判定的血量变化（官方 ManiaHealthProcessor.GetHealthIncreaseFor）。
 * DrainRate 即编辑器里的 HP；HpMultiplierNormal 需跑官方那套迭代收敛算法才能得到，
 * 这里取 1 —— 它只作用于回血项（Meh / Miss 的掉血本来就不乘它），对 mania 影响很小。
 * @param {string} res 判定结果（300g/300/200/100/50/miss）
 * @param {boolean} isLn 该物件是否为长条（头/尾），miss 时长条只扣一半
 * @param {number} dr DrainRate（0~10）
 */
function _playHpDelta(res, isLn, dr) {
  switch (res) {
    case "300g": return 0.0055 - dr * 0.0005;
    case "300": return 0.005 - dr * 0.0005;
    case "200": return 0.004 - dr * 0.0004;
    case "100": return 0;
    case "50": return -(dr + 1) * 0.0016;
    case "miss": return -(dr + 1) * (isLn ? 0.00375 : 0.0075);
    default: return 0;
  }
}

/**
 * 构建判定事件流：普通音符 1 个事件；长条头/尾各 1 个（与官方一致，分别计连击）。
 * 同时预算前缀状态（连击 / 分数 / 准确率权重和 / 血量），渲染时二分取用，O(log n)。
 */
function _playBuildEvents(bm, keys) {
  const objs = bm.hitObjects;
  const jt = _judgeWeights(); // 权重表取一次，避免逐物件重复构造
  const dr = Number.isFinite(bm.drainRate) ? bm.drainRate : 5;
  const raw = [];
  for (let k = 0; k < objs.length; k++) {
    const o = objs[k];
    const i = Math.floor(o.x * keys / 512);
    if (i < 0 || i >= keys) continue;
    const isLn = !!(o.type & 128);
    raw.push({ t: o.time, i, tail: false, ln: isLn, r: _playJudge(k, jt) });
    if (isLn && o.endTime > o.time) {
      raw.push({ t: o.endTime, i, tail: true, ln: isLn, r: _playJudge(k + 1000003, jt) });
    }
  }
  raw.sort((a, b) => a.t - b.t);

  const n = raw.length;
  const t = new Array(n), i = new Array(n), r = new Array(n), tail = new Array(n), ln = new Array(n);
  const pCombo = new Array(n + 1).fill(0);
  const pBase = new Array(n + 1).fill(0);          // currentBaseScore
  const pComboPortion = new Array(n + 1).fill(0);  // currentComboPortion
  const pHp = new Array(n + 1).fill(1);            // 血量前缀（HealthProcessor.Health 初始 1）
  const breaks = [];                               // 断连点 {t, combo}（供连击 pop-out）
  for (let k = 0; k < n; k++) {
    t[k] = raw[k].t; i[k] = raw[k].i; r[k] = raw[k].r; tail[k] = raw[k].tail; ln[k] = raw[k].ln;
    const res = r[k];
    // IncreasesCombo = AffectsCombo && IsHit；miss 断连
    const combo = res === "miss" ? 0 : pCombo[k] + 1;
    if (res === "miss" && pCombo[k] > 0) breaks.push({ t: t[k], combo: pCombo[k] });
    pCombo[k + 1] = combo;
    pBase[k + 1] = pBase[k] + (PLAY_BASE_SCORE[res] || 0);
    pComboPortion[k + 1] = pComboPortion[k] + _playComboChange(res, combo);
    pHp[k + 1] = Math.max(0, Math.min(1, pHp[k] + _playHpDelta(res, ln[k], dr)));
  }
  // 官方：maximumComboPortion 由「全 Perfect 的自动播放」模拟得出（连击 1..n）
  let maxComboPortion = 0;
  for (let c = 1; c <= n; c++) maxComboPortion += _playComboChange("300g", c);
  return { t, i, r, tail, ln, pCombo, pBase, pComboPortion, pHp, maxComboPortion, n, breaks };
}

/** 判定权重变化后重建事件流（权重未变则跳过，避免每次设置变更都重算）。 */
function _syncJudgeEvents() {
  const p = _p.play;
  if (!p || !p.bm) return;
  const key = _judgeKey();
  if (p.judgeKey === key) return;
  p.judgeKey = key;
  p.events = _playBuildEvents(p.bm, p.keys);
}

/**
 * 当前时间下的连击 / 分数 / 准确率 / 血量（官方 ManiaScoreProcessor.ComputeTotalScore）：
 *   150000 × comboProgress
 * + 850000 × Accuracy^(2 + 2×Accuracy) × accuracyProgress
 * + bonusPortion（mania 无 bonus，恒为 0）
 * Accuracy = currentBaseScore / currentMaximumBaseScore，其中每判定 MaxResult=Perfect(305)。
 */
function _playStatsAt(ev, t) {
  const k = bisectLeft(ev.t, t);
  const maxBase = 305 * k;
  const acc = maxBase > 0 ? ev.pBase[k] / maxBase : 1;
  const comboProgress = ev.maxComboPortion > 0 ? ev.pComboPortion[k] / ev.maxComboPortion : 1;
  const accuracyProgress = ev.n > 0 ? k / ev.n : 1;
  const score = k > 0
    ? Math.round(150000 * comboProgress + 850000 * Math.pow(acc, 2 + 2 * acc) * accuracyProgress)
    : 0;
  return { combo: ev.pCombo[k], score, acc: acc * 100, hp: ev.pHp[k], k };
}

/**
 * 滚动计数器状态（对应官方 RollingCounter 的 DisplayedCount 变换）。
 * 官方 RollingCounter.TransformCount 用 TransformTo 把显示值从当前值缓动到新值，
 * 且以框架时钟为驱动——故此处同样用谱面时间 t：暂停 / 拖动进度条时动画随之冻结，
 * 与官方暂停时动画冻结的行为一致（seek 时由调用方清空状态直接对齐）。
 */
function _playRollState(key) {
  const p = _p.play;
  p.roll = p.roll || {};
  return p.roll[key] || (p.roll[key] = { target: null, from: 0, start: 0 });
}

/** 滚动插值：官方 RollingCounter.RollingEasing 默认 Easing.OutQuad。 */
function _playRollAt(st, dur, t) {
  const k = (t - st.start) / dur;
  if (!(k > 0)) return st.from;
  if (k >= 1) return st.target;
  return st.from + (st.target - st.from) * (1 - Math.pow(1 - k, 2));
}

/** 目标值变化时重启动画（起点取打断瞬间的显示值），返回 t 时刻的显示值。 */
function _playRoll(key, target, dur, t) {
  const st = _playRollState(key);
  if (st.target !== target) {
    st.from = st.target == null ? target : _playRollAt(st, dur, t);
    st.target = target;
    st.start = t;
  }
  return _playRollAt(st, dur, t);
}


/** 导入铺面（选择 .osu，音频按 AudioFilename 自动在谱面目录查找；未找到才用多选的音频）。 */
async function _importBeatmap() {
  let files = [];
  try {
    // 起始目录用上次导入铺面的目录（设置记忆，无需重新翻文件夹）
    files = await invoke("pick_files", { initialDir: _lastBeatmapDir() });
  } catch (e) {
    toast(`导入铺面失败：${e.message || e}`, "error");
    return;
  }
  const osuPath = files.find((f) => /\.osu$/i.test(f));
  if (!osuPath) { toast("未选择 .osu 谱面文件", "error"); return; }
  await _loadBeatmap(osuPath, files, false);
}

/** 上次导入铺面的目录（设置记忆；兼容旧版仅记 last_beatmap 的情况，取其所在目录）。 */
function _lastBeatmapDir() {
  if (state.settings.last_beatmap_dir) return state.settings.last_beatmap_dir;
  const b = state.settings.last_beatmap;
  return b ? b.replace(/[\\/][^\\/]*$/, "") : "";
}

/**
 * 载入谱面（「导入铺面」按钮与启动恢复共用）。
 * @param {string} osuPath .osu 路径
 * @param {string[]} files 同一对话框内选中的其它文件（可能含音频；恢复时为 []）
 * @param {boolean} restore 启动恢复：失败静默（由调用方清除记录）、不写记录、不强制切页
 * @returns {Promise<boolean>} 是否载入成功
 */
async function _loadBeatmap(osuPath, files, restore) {
  const fail = (msg) => { if (!restore) toast(msg, "error"); return false; };
  let osuText;
  try {
    const r = await invoke("read_text", { path: osuPath });
    osuText = r && r.text;
  } catch (e) { return fail(`读取谱面失败：${e.message || e}`); }
  if (!osuText || !osuText.includes("[HitObjects]")) return fail("谱面文件无效（缺少 [HitObjects]）");

  let bm;
  try { bm = parseOsuBeatmap(osuText); }
  catch (e) { return fail(`解析谱面失败：${e.message || e}`); }
  if (bm.mode !== 3) return fail("非 osu!mania 谱面（未支持其他模式）");

  const p = _p.play || _playReset();
  // 释放旧音频
  if (p.audio) { p.audio.pause(); p.audio = null; }
  if (p.audioUrl) { URL.revokeObjectURL(p.audioUrl); p.audioUrl = null; }
  p.bm = bm;
  p.keys = Math.max(1, Math.min(18, bm.circleSize));
  p.playing = false;
  p.manualMs = 0;
  p.last = undefined;
  p.clock = null;
  p.sb = null;     // 新谱面从头开始 → 血条重播启动填充动画
  p.sbSnap = false;
  p.judgeKey = null; // 判定权重可能已被修改 → 强制重建事件流
  _syncJudgeEvents();
  p.lnSpan = undefined; // 本谱面的最长长条时长（首帧惰性统计）

  // 音频：优先按 AudioFilename 在谱面目录（递归）查找；找不到则用文件对话框里一并选的
  let audioPath = null;
  const dir = osuPath.replace(/[\\/][^\\/]*$/, "");
  if (bm.audioFilename) {
    try { audioPath = await invoke("find_file_by_name", { folder: dir, name: bm.audioFilename }); }
    catch (e) { audioPath = null; }
  }
  if (!audioPath) {
    audioPath = files.find((f) => /\.(mp3|ogg|wav|mp4|m4a|flac|aac)$/i.test(f)) || null;
  }
  if (audioPath) {
    try {
      const bytes = await invoke("read_file_bytes", { path: audioPath });
      if (bytes && bytes.byteLength) {
        p.audioUrl = URL.createObjectURL(new Blob([bytes], { type: _audioMime(audioPath) }));
        const a = new Audio(p.audioUrl);
        a.preload = "auto";
        a.playbackRate = p.rate; // 新音频元素需重新套用当前倍速
        a.addEventListener("ended", _playOnEnded);
        p.audio = a;
      }
    } catch (e) { toast(`音频加载失败：${e.message || e}`, "error"); }
  }

  // 背景：官方游玩界面显示歌曲背景（谱面自带图），而非皮肤 menu-background
  p.bgPath = null;
  if (bm.backgroundFilename) {
    try { p.bgPath = await invoke("find_file_by_name", { folder: dir, name: bm.backgroundFilename }); }
    catch (e) { p.bgPath = null; }
  }

  toast(`${restore ? "已恢复上次谱面" : "已导入"}：${bm.title}（${p.keys}K / ${Math.round(bm.bpm)}BPM / ${bm.noteCount} 音符${bm.lnCount ? " +" + bm.lnCount + " 长条" : ""}${audioPath ? "，已带音频" : "，无音频"}）`);
  if (!restore) {
    state.settings.last_beatmap = osuPath; // 记住谱面，下次启动自动恢复
    state.settings.last_beatmap_dir = dir; // 记住所在目录，下次导入铺面对话框定位到这里
    persistSettings();
    _playSwitchTo("动态游玩预览");
    emit("beatmap:imported", { keys: p.keys }); // 通知 skin.ini 编辑器跳转到该铺面的键数
  }
  _schedulePlayLoop();
  return true;
}

/** 启动时恢复上次载入的谱面；文件已被删除/移走则清除记录（避免每次启动都白试一次）。 */
async function _restoreLastBeatmap() {
  const path = state.settings.last_beatmap;
  if (!path) return;
  if (await _loadBeatmap(path, [], true)) {
    _syncPlayCtl(); // 恢复流程不切页，需按当前页同步控制行显隐
  } else {
    state.settings.last_beatmap = "";
    persistSettings();
  }
}

function _playToggle() {
  const p = _p.play;
  if (!p || !p.bm) return;
  if (p.playing) _playPause();
  else _playStart();
}

function _playStart() {
  const p = _p.play;
  if (!p || !p.bm) return;
  p.playing = true;
  p.clock = null; // 重新锚定主时钟
  if (p.audio) {
    p.audio.play().then(() => {
      if (!p) return;
      p.playing = true;
    }).catch((e) => {
      p.playing = false;
      toast(`音频播放失败：${e.message || e}`, "error");
    });
  }
  _schedulePlayLoop();
}

function _playPause() {
  const p = _p.play;
  if (!p) return;
  p.playing = false;
  p.clock = null;
  if (p.audio) p.audio.pause();
}

function _playOnEnded() {
  const p = _p.play;
  if (!p) return;
  p.playing = false;
}

function _playSeek(ms) {
  const p = _p.play;
  if (!p || !p.bm) return;
  ms = Math.max(0, Math.min(ms, _playDurMs()));
  p.manualMs = ms;
  p.clock = null; // 跳转后重新锚定主时钟
  p.roll = null;  // 跳转后分数/准确率直接对齐（官方 SetCountWithoutRolling：不播滚动动画）
  p.sb = null;    // 跳转后血条直接对齐当前血量，不重播启动填充动画
  p.sbSnap = true;
  if (p.audio) {
    try { p.audio.currentTime = ms / 1000; } catch (e) { /* ignore */ }
  }
}

function _playSetSpeed(sp) {
  const p = _p.play;
  if (!p) return;
  // 下落速度（1~40）：决定音符线速度（unit/ms，见 _playScrollVel），不影响音乐播放速度
  const n = parseInt(sp, 10);
  p.speed = Math.max(PLAY_SPEED_MIN, Math.min(PLAY_SPEED_MAX, isNaN(n) ? 25 : n));
  state.settings.play_speed = p.speed; // 记住下落速度（松手时由 change 事件持久化）
  if (p.speedSel) p.speedSel.value = String(p.speed);
  if (p.speedVal) p.speedVal.textContent = String(p.speed);
}

function _playSetRate(rate) {
  const p = _p.play;
  if (!p) return;
  // 播放倍速：整条时间轴与音乐同步变速（audio.playbackRate + 主时钟插值速率）
  const n = Number(rate);
  p.rate = PLAY_RATES.includes(n) ? n : 1;
  state.settings.play_rate = p.rate; // 记住倍速（change 事件里持久化）
  if (p.audio) p.audio.playbackRate = p.rate;
  p.clock = null; // 倍速变化后重新锚定主时钟
  if (p.rateSel) p.rateSel.value = String(p.rate);
}

function _schedulePlayLoop() {
  if (!_p.play) return;
  if (_p.play.raf) return;
  cancelAnimationFrame(_p.play.raf);
  _p.play.raf = 0;
  _p.play.last = undefined;
  _playLoop();
}

function _stopPlayLoop() {
  if (_p.play && _p.play.raf) { cancelAnimationFrame(_p.play.raf); _p.play.raf = 0; }
}

/** 对局循环：推进时间、刷新进度 UI、逐帧重绘。 */
function _playLoop() {
  const p = _p.play;
  if (!p || !_p.canvas) return;
  if (_pv("page", "静态游玩预览") !== "动态游玩预览") {
    p.raf = 0; // 页面已离开动态预览，停止循环
    return;
  }

  // 推进时间（下落速度只影响音符线速度；播放倍速按 rate 缩放时钟推进）
  if (p.playing) {
    const now = performance.now();
    if (p.last !== undefined) {
      if (!p.audio) p.manualMs += (now - p.last) * p.rate;
      if (_playTimeMs() >= _playDurMs()) {
        p.playing = false;
        if (p.audio) p.audio.pause();
      }
    }
    p.last = now;
  } else {
    p.last = undefined;
  }

  _updatePlayUI();
  _doDraw();
  if (p.raf) p.raf = 0;
  p.raf = requestAnimationFrame(_playLoop);
}

function _fmtMs(ms) {
  ms = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(ms / 60)}:${String(ms % 60).padStart(2, "0")}`;
}

function _updatePlayUI() {
  const p = _p.play;
  if (!p) return;
  const cur = Math.min(_playTimeMs(), _playDurMs());
  if (p.progress) {
    p.progress.max = String(_playDurMs());
    p.progress.value = String(cur);
  }
  if (p.timeLbl) p.timeLbl.textContent = `${_fmtMs(cur)} / ${_fmtMs(_playDurMs())}`;
  if (p.playBtn) p.playBtn.textContent = p.playing ? "⏸ 暂停" : "▶ 播放";
  if (p.titleLbl && p.bm) {
    p.titleLbl.textContent = `${p.bm.title} ｜ ${p.bm.creator ? p.bm.creator + " / " : ""}${p.bm.version}（${p.bm.keys}K, BPM ${Math.round(p.bm.bpm)}）`;
  }
}

function _playIsActive() {
  return !!(_p.play && _p.play.bm && _pv("page", "静态游玩预览") === "动态游玩预览");
}

// ---- 打击反馈动画曲线（官方 LegacyManiaJudgementPiece / LegacyHitExplosion）----

/** 判定图不透明度：FadeIn 20 (Easing.Out) → 保持 160 → FadeOut 40 (Easing.In)。 */
function _playJudgeAlpha(dt) {
  if (dt < PLAY_JUDGE_IN) {
    const k = dt / PLAY_JUDGE_IN;
    return 1 - Math.pow(1 - k, 2);        // FadeInFromZero(20, Easing.Out)
  }
  if (dt < PLAY_JUDGE_IN + PLAY_JUDGE_HOLD) return 1;
  const k = (dt - PLAY_JUDGE_IN - PLAY_JUDGE_HOLD) / PLAY_JUDGE_OUT;
  return k >= 1 ? 0 : 1 - k * k;          // FadeOutFromOne(40, Easing.In)
}

/** 判定图的二次缓出进度（官方 Easing.Out），用于 miss 的缩放/旋转。 */
function _playJudgeOut(dt) {
  return dt >= PLAY_JUDGE_MISS_MS ? 1 : 1 - Math.pow(1 - dt / PLAY_JUDGE_MISS_MS, 2);
}

/** miss 判定图的旋转角（度）：官方 RotateTo(RNG.NextSingle(-5.73, 5.73), 100, Easing.Out)。
 *  用事件下标做确定性伪随机，保证同一判定每帧角度一致。 */
function _playJudgeRot(k) {
  const h = (Math.imul(k + 7919, 2654435761) >>> 0) / 4294967296;
  return PLAY_JUDGE_MISS_ROT * (h * 2 - 1);
}

/** 判定图缩放（官方 LegacyManiaJudgementPiece.PlayAnimation）：
 *  miss：1.2 → 1（100ms Out）；
 *  其余：0.8 → 1(40) → 0.85 → 0.7(40) → 停 100 → 0.4(40, In)。 */
function _playJudgeScale(dt, res) {
  if (res === "miss") {
    if (dt >= PLAY_JUDGE_MISS_MS) return 1;
    return 1 + (PLAY_JUDGE_MISS_SCALE - 1) * (1 - _playJudgeOut(dt));
  }
  if (dt < 40) return 0.8 + 0.2 * (dt / 40);
  if (dt < 80) return 0.85 - 0.15 * ((dt - 40) / 40);
  if (dt < 180) return 0.7;
  const k = Math.min(1, (dt - 180) / 40);
  return Math.max(0.4, 0.7 - 0.3 * k * k);   // ScaleTo(0.4f, 40, Easing.In)
}

/** 打击爆炸不透明度：FadeIn 80 → FadeOut 120。 */
function _playExplodeAlpha(dt) {
  if (dt < PLAY_EXPLODE_IN) return dt / PLAY_EXPLODE_IN;
  const k = (dt - PLAY_EXPLODE_IN) / PLAY_EXPLODE_OUT;
  return k >= 1 ? 0 : 1 - k;
}

/**
 * 动态对局渲染：接收器、下落音符、长条与打击反馈。
 *
 * 坐标：游戏区域恒为 480 unit，Y(u) 负责像素换算与倒置；
 * 时刻 τ 的「前沿」位于 unit y = hitY - (τ - t) · v。
 *
 * 长条按官方 DrawableHoldNote 的三段几何拼接（Hh/Th = 头/尾图高）：
 *   头    [pos(T) - Hh, pos(T)]        前沿贴判定线，向后（远离判定线）展开
 *   身体  [pos(E) - Th/2, pos(T) - Hh/2]  两端各伸到头的中线 / 尾的中线
 *   尾    [pos(E) - Th, pos(E)]        位于远端外侧，纹理垂直翻转（"倒扣"）
 * 按住时头部钉在判定线，头中线以下的部分被遮罩（等同官方 maskingContainer）。
 */
function _drawPlayNotes(P) {
  const { ctx, X, Y, scale, cols, keys, vals, layout, flipKeys, flipNotes,
          upside, hitY, refW, noteBodyStyle, split, drawHitTarget } = P;
  const half = keys >> 1; // 分离舞台时的左右分界（与 _draw 一致）
  const play = _p.play;
  const bm = play.bm;
  const ev = play.events;
  const t = _playTimeMs();
  const v = _playScrollVel();  // unit/ms：仅由下落速度决定（与判定线高度无关）
  const leadMs = hitY / v;     // 可见提前量：判定线越高越短
  const colWpx = (i) => (cols[i][1] - cols[i][0]) * scale;
  const colX = (i) => X(cols[i][0]);
  const cxpx = (i) => X((cols[i][0] + cols[i][1]) / 2);
  const posAt = (tau) => hitY - (tau - t) * v; // 时刻 τ 的「前沿」unit 坐标
  const keysUnder = _bool(vals.get("KeysUnderNotes")); // 按键是否绘制在音符之下

  // ---- 贴图解析：官方回退链（layout[i] 即 FallbackColumnIndex）----
  // 每帧按「ini 值 + 候选名」记忆化，避免同一列在一帧内反复查文件
  const imgMemo = new Map();
  const pickImg = (ini, ...bases) => {
    const key = `${ini || ""}|${bases.join("|")}`;
    let hit = imgMemo.get(key);
    if (hit === undefined) {
      const path = _resolvePath(ini, ...bases);
      hit = path ? _imgEntLoaded(path) : null;
      imgMemo.set(key, hit);
    }
    return hit;
  };
  const lb = (i) => layout[i];
  // 音符贴图为动画序列（官方 LegacyNotePiece：GetAnimation(name, ClampToEdge, ClampToEdge,
  // true, true)）→ 帧长 SIXTY_FRAME_TIME、循环播放，计时原点见 PLAY_ANIM_LIFETIME_OFFSET
  // （下落中的音符 elapsed 为正，动画持续推进）
  const animMemo = new Map();
  const pickAnim = (elapsed, ini, ...bases) => {
    const key = `${ini || ""}|${bases.join("|")}`;
    let paths = animMemo.get(key);
    if (paths === undefined) { paths = _animPathsAny(ini, ...bases); animMemo.set(key, paths); }
    return _animEnt(paths, elapsed, PLAY_ANIM_60FPS_MS, true);
  };
  const animClock = (startTime) => t - startTime + PLAY_ANIM_LIFETIME_OFFSET;
  const noteImg = (i, o) => pickAnim(animClock(o.time), vals.get(`NoteImage${i}`), `mania-note${lb(i)}`);
  const headImg = (i, o) => pickAnim(animClock(o.time), vals.get(`NoteImage${i}H`), `mania-note${lb(i)}H`, `mania-note${lb(i)}`);
  const tailImg = (i, o) => pickAnim(animClock(o.time), vals.get(`NoteImage${i}T`), `mania-note${lb(i)}T`, `mania-note${lb(i)}H`, `mania-note${lb(i)}`);
  // 长条身体动画官方固定 IsPlaying = false（LegacyBodyPiece）→ 恒显示第 0 帧
  const bodyImg = (i) => _animEnt(_animPathsAny(vals.get(`NoteImage${i}L`), `mania-note${lb(i)}L`), 0, 1, false);
  // 贴图高 -> unit 高（Height = 纹理高 × WidthForNoteHeightScale / 纹理宽）
  const unitH = (e) => (e && e.w > 0 ? Math.max(1, e.h * refW / e.w) : 44);
  const keyH = (e) => (e && e.h > 0 ? Math.max(1, Math.round(e.h * scale / 1.6)) : 0);

  const hitIndex = bm.hitIndex;
  const objs = bm.hitObjects;
  if (play.lnSpan === undefined) {
    let m = 0;
    for (const ln of hitIndex.lnEnds) m = Math.max(m, ln.end - ln.t);
    play.lnSpan = m;
  }

  // ---- 每列按键状态：长条按住 / 最近命中（含长条头尾）----
  const colHeld = new Array(keys).fill(false);
  const colHit = new Array(keys).fill(-Infinity);
  {
    // 只扫 [t - max(最长长条, 闪光时长), t] 窗口内的长条（滑动窗口，避免全量遍历）
    const a = bisectLeft(hitIndex.lnEnds, t - Math.max(play.lnSpan, PLAY_HIT_FLASH), "t");
    const b = bisectLeft(hitIndex.lnEnds, t, "t");
    for (let k = a; k < b; k++) {
      const ln = hitIndex.lnEnds[k];
      const i = Math.floor(objs[ln.idx].x * keys / 512);
      if (i < 0 || i >= keys) continue;
      if (ln.end > t) { colHeld[i] = true; colHit[i] = Math.max(colHit[i], ln.t); }
      else colHit[i] = Math.max(colHit[i], ln.end);
    }
    if (ev) {
      const a2 = bisectLeft(ev.t, t - PLAY_HIT_FLASH);
      const b2 = bisectLeft(ev.t, t);
      for (let k = a2; k < b2; k++) colHit[ev.i[k]] = Math.max(colHit[ev.i[k]], ev.t[k]);
    }
  }
  // 是否有长条处于按住状态（官方 stable：按住 LN 期间连击计数器用 ColourHold 着色）
  play.anyHeld = colHeld.some((v) => v);
  const colPressed = new Array(keys).fill(false);
  const colDown = new Array(keys).fill(false); // 按下图可见性（官方松开后额外延迟 80ms）
  for (let i = 0; i < keys; i++) {
    const dt = t - colHit[i];
    colPressed[i] = colHeld[i] || dt < PLAY_HIT_FLASH;
    colDown[i] = colPressed[i] || dt < PLAY_HIT_FLASH + PLAY_KEY_RELEASE_DELAY;
  }

  // ═══════════════════════ 舞台灯光（列背景层，恒在音符之下） ═══════════════════════
  // 官方 LegacyColumnBackground：灯光属于列背景（BackgroundContainer），
  // 恒位于音符之下，不随 KeysUnderNotes 变化。按下瞬间 FadeIn + ScaleTo(1)，
  // 松开后 250ms FadeTo(0) 且 ScaleTo(1, 0)（纵向压扁到 LightPosition 那条线）；
  // 贴图为动画序列，帧长 1000 / LightFramePerSecond。
  const lightPos = _num(vals.get("LightPosition"), 413);
  const lightFpsRaw = _num(vals.get("LightFramePerSecond"), PLAY_LIGHT_FPS_DEFAULT);
  const lightFrameLen = 1000 / (lightFpsRaw > 0 ? lightFpsRaw : 24);
  const lightPaths = _animPaths(vals.get("StageLight"), "mania-stage-light");
  const drawKeyLights = () => {
    if (!_showDefaultOn() || !lightPaths.length) return;
    const lightEnt = _animEnt(lightPaths, t, lightFrameLen, true);
    if (!lightEnt || lightEnt.w <= 0) return;
    for (let i = 0; i < keys; i++) {
      let alpha = 1, kScale = 1;
      if (!colPressed[i]) {
        const r = (t - colHit[i] - PLAY_HIT_FLASH) / PLAY_LIGHT_OUT;
        if (!(r >= 0) || r >= 1) continue; // 未到松开时刻或已淡出完毕
        alpha = 1 - r;
        kScale = 1 - r;
      }
      const wpx = colWpx(i);
      const rgb = _parseRgba(vals.get(`ColourLight${i + 1}`), [55, 255, 255, 255]).slice(0, 3);
      const tinted = _tintEl(lightEnt.img, rgb);
      if (!tinted) continue;
      // 官方：灯光 Width = 1（列宽），高度 = 贴图逻辑高（768 空间 → 480 空间 ÷1.6），
      // 不按贴图宽高比缩放（原项目按列宽等比算高，与官方不符）。
      const lh = Math.max(1, lightEnt.h * scale / 1.6) * kScale;
      // 官方：BottomCentre 锚在 LightPosition（自下往上生长；倒置时镜像为自顶向下）
      ctx.save();
      ctx.globalAlpha = alpha;
      _drawEl(tinted, colX(i), upside ? Y(lightPos) : Y(lightPos) - lh, wpx, lh);
      ctx.restore();
    }
  };

  // ═══════════════════════ 接收器（基键 / 按下键） ═══════════════════════
  // KeysUnderNotes（按键被音符覆盖）：官方把 KeyArea 移入 HitObjectArea.UnderlayElements
  // （音符之下）；默认 0 时 KeyArea 位于 Column 子级末尾 = 音符之上。
  // 按下/松开为瞬时切换（官方 FadeTo 时长 0），但松开要晚 80ms 才切回抬起图。
  const drawKeys = () => {
    for (let i = 0; i < keys; i++) {
      const wpx = colWpx(i);
      const x = colX(i);
      const baseEnt = pickImg(vals.get(`KeyImage${i}`), `mania-key${lb(i)}`);
      const downEnt = pickImg(vals.get(`KeyImage${i}D`), `mania-key${lb(i)}D`, `mania-key${lb(i)}`);

      if (baseEnt && baseEnt.h > 0) {
        const kh = keyH(baseEnt);
        _drawEnt(baseEnt, x, upside ? Y(480) : Y(480) - kh, wpx, kh, false, flipKeys);
      }
      if (colDown[i] && downEnt && downEnt.h > 0) {
        const kh = keyH(downEnt);
        _drawEnt(downEnt, x, upside ? Y(480) : Y(480) - kh, wpx, kh, false, flipKeys);
      }
      if (!baseEnt && _showDefaultOn()) {
        ctx.fillStyle = colDown[i] ? "#5a5a66" : "#3a3a44";
        ctx.strokeStyle = "#ffffff";
        const y0 = Y(hitY), y1 = Y(480);
        ctx.fillRect(x, y0, wpx, y1 - y0);
        ctx.strokeRect(x, y0, wpx, y1 - y0);
      }
    }
  };

  drawKeyLights();
  if (keysUnder) drawKeys();
  // 命中检测器：官方位于 UnderlayElements 之后、音符之前（见 ColumnHitObjectArea）
  if (drawHitTarget) drawHitTarget();

  // ═══════════════════════ 音符（下落 / 按住） ═══════════════════════
  // 单个长条的完整绘制（身体 → 头 → 尾）
  const drawLn = (i, o, headEdge, tailEdge, held) => {
    const wpx = colWpx(i);
    const x = colX(i);
    const H = headImg(i, o), T = tailImg(i, o), L = bodyImg(i);
    const hh = unitH(H);            // 头高（unit）
    const th = unitH(T);            // 尾高（unit）
    const hBottom = held ? hitY : headEdge; // 按住时头部前沿钉在判定线
    const hCentre = hBottom - hh / 2;
    // 按住的遮罩：头中线以下的部分不绘制（官方 maskingContainer）
    const tEdge = held ? Math.min(tailEdge, hCentre) : tailEdge;
    const tCentre = tEdge - th / 2;
    const drawColor = NOTE_COLORS[i % NOTE_COLORS.length];

    // 身体：头中线 -> 尾中线（像素区间用 min/max，兼容倒置）
    if (tCentre < hCentre) {
      const ya = Y(tCentre), yb = Y(hCentre);
      const tp = Math.min(ya, yb), bt = Math.max(ya, yb);
      if (L && L.w > 0) {
        // 单张平铺高度按 WidthForNoteHeightScale（refW）等比换算
        const tile = Math.max(1, (L.h * refW / L.w) * scale);
        _drawHoldBody(ctx, L, x, wpx, tp, bt, tile, noteBodyStyle, upside);
      } else if (_showDefaultOn()) {
        ctx.fillStyle = "rgba(150,180,220,0.35)";
        ctx.fillRect(x, tp, wpx, bt - tp);
      }
    }

    // 头：贴图向后展开（倒置时方向相反）
    if (H && H.w > 0) {
      const hpx = hh * scale;
      _drawEnt(H, x, upside ? Y(hBottom) : Y(hBottom) - hpx, wpx, hpx, false, flipNotes);
    } else if (_showDefaultOn()) {
      const hpx = 44 * scale;
      ctx.fillStyle = drawColor;
      ctx.fillRect(x, upside ? Y(hBottom) : Y(hBottom) - hpx, wpx, hpx);
    }

    // 尾：位于远端外侧，纹理垂直翻转（"倒扣"）
    if (T && T.w > 0) {
      const tpx = th * scale;
      _drawEnt(T, x, upside ? Y(tEdge) : Y(tEdge) - tpx, wpx, tpx, false, !flipNotes);
    } else if (_showDefaultOn()) {
      const tpx = Math.max(2, 4 * scale);
      ctx.fillStyle = drawColor;
      ctx.fillRect(x, upside ? Y(tEdge) : Y(tEdge) - tpx, wpx, tpx);
    }
  };

  // ── 裁剪到游戏画面框：音符只允许在游玩区域内下落 ──
  // 画面比例拟合后，画布上下会留出信箱边（游戏画面框外）。若不裁剪，音符贴图会
  // 在其前沿（unit 0 = 画面框上沿）之上最多溢出一个贴图高，看起来像在游玩区域外下落。
  // 纵向限 480 unit（Y(0)~Y(480)，天然兼容倒置），横向限舞台列区。
  const clipT = Math.min(Y(0), Y(480));
  const clipB = Math.max(Y(0), Y(480));
  const clipL = X(cols[0][0]);
  const clipR = X(cols[cols.length - 1][1]);
  ctx.save();
  ctx.beginPath();
  ctx.rect(clipL, clipT, clipR - clipL, clipB - clipT);
  ctx.clip();

  const winS = t - leadMs * 0.2;
  const winE = t + leadMs;
  const si = bisectLeft(hitIndex.starts, winS, "t");
  const ei = bisectLeft(hitIndex.starts, winE, "t");
  for (let k = si; k < ei; k++) {
    const o = objs[hitIndex.starts[k].idx];
    const i = Math.floor(o.x * keys / 512);
    if (i < 0 || i >= keys) continue;
    const headEdge = posAt(o.time);
    if (!(o.type & 128) || !(o.endTime > o.time)) {
      if (o.time <= t) continue;            // 已越过判定线 → 消失
      if (headEdge < 0 || headEdge > hitY + 20) continue;
      const e = noteImg(i, o);
      const wpx = colWpx(i), x = colX(i);
      if (e && e.w > 0) {
        const nh = unitH(e) * scale;
        _drawEnt(e, x, upside ? Y(headEdge) : Y(headEdge) - nh, wpx, nh, false, flipNotes);
      } else if (_showDefaultOn()) {
        const nh = 44 * scale;
        ctx.fillStyle = NOTE_COLORS[i % NOTE_COLORS.length];
        ctx.fillRect(x, upside ? Y(headEdge) : Y(headEdge) - nh, wpx, nh);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x, Y(headEdge) - 1, wpx, Math.max(2, 2 * scale));
      }
      continue;
    }
    // 长条：头部未到判定线 → 随下落；已到则由下方「按住」通道绘制
    if (o.time <= t) continue;
    const tailEdge = posAt(o.endTime);
    if (headEdge < -4 || tailEdge > 484) continue; // 整条仍在屏幕上/下边之外
    drawLn(i, o, headEdge, tailEdge, false);
  }

  // 按住中的长条（头已过判定线、尾未到）：头部钉在判定线
  {
    const a = bisectLeft(hitIndex.lnEnds, t - play.lnSpan, "t");
    const b = bisectLeft(hitIndex.lnEnds, t, "t");
    for (let k = a; k < b; k++) {
      const ln = hitIndex.lnEnds[k];
      if (ln.end <= t) continue;
      const o = objs[ln.idx];
      const i = Math.floor(o.x * keys / 512);
      if (i < 0 || i >= keys) continue;
      drawLn(i, o, hitY, posAt(ln.end), true);
    }
  }
  ctx.restore(); // 结束音符裁剪

  // 按键默认绘制在音符之上（官方 KeyArea 位于 Column 子级末尾，晚于 HitObjectArea），
  // 但仍低于舞台（Stage）的判定图与最顶层（TopLevel）的打击爆炸。
  if (!keysUnder) drawKeys();

  // ═══════════════════════ 打击反馈：判定图 + 打击爆炸 ═══════════════════════
  if (ev && ev.n) {
    // 打击爆炸动画（官方 LegacyHitExplosion：每次命中 GotoFrame(0)，
    // 帧长 = max(SIXTY_FRAME_TIME, 170 / 帧数)，不循环，播完停在末帧）
    const explPaths = _animPathsAny(vals.get("LightingN"), "lightingN");
    const explFrameLen = Math.max(PLAY_ANIM_60FPS_MS, PLAY_ANIM_EXPLODE_SPAN / Math.max(1, explPaths.length));
    const nWidths = _num_list(vals.get("LightingNWidth"), 0, keys);
    const scorePosU = _num(vals.get("ScorePosition"), 300);
    const span = Math.max(PLAY_EXPLODE_IN + PLAY_EXPLODE_OUT, PLAY_JUDGE_TOTAL);
    const a = bisectLeft(ev.t, t - span);
    const b = bisectLeft(ev.t, t);

    // 判定图（mania-hit* / hit*，官方 LegacyManiaJudgementPiece）：
    // 官方 Stage.OnNewResult 先 judgements.Clear 再 Add，同一时刻只显示最新一次判定
    if (b > a) {
      const k = b - 1;
      // 判定图水平位置：官方每个 Stage 各有一个判定容器（Top/BottomCentre 锚点），
      // 固定在所属舞台水平中央；分离舞台且 SeparateScore=1 时取命中所属舞台的中心
      const stageCols = split && !_boolFalse(vals.get("SeparateScore"))
        ? (ev.i[k] >= half ? [half, cols.length - 1] : [0, half - 1])
        : [0, cols.length - 1];
      const judgeCx = X((cols[stageCols[0]][0] + cols[stageCols[1]][1]) / 2);
      // 判定图纵向位置（官方 LegacyManiaJudgementPiece.onDirectionChanged）：
      //   hitPositionFromTop = 480×1.6 - HitPosition（768 空间，即本坐标系下的 hitY）
      //   ScorePosition > hitPositionFromTop / 2 → 锚点取「远端」，y = 480 - hitY + scorePos
      //   否则锚点取「近端」，y = scorePos
      // 倒置时官方的锚点/符号整体镜像，换算回本坐标系（Y() 已负责镜像）后结果相同。
      const judgeY = scorePosU > hitY / 2 ? 480 - hitY + scorePosU : scorePosU;
      const dt = t - ev.t[k];
      if (dt < PLAY_JUDGE_TOTAL) {
        const res = ev.r[k];
        const files = HIT_LOOKUP[res];
        const iniPath = HIT_INI_KEYS[res] ? vals.get(HIT_INI_KEYS[res]) : null;
        // 判定图动画：mania-hit* 走官方 ManiaLegacySkinTransformer.getResult
        // （GetAnimation(filename, true, true, frameLength: 1000/20)，命中时 GotoFrame(0)，
        // 循环播放）；回退到旧式 hit* 时走 LegacySkin.GetDrawableComponent
        // （GetAnimation(name, true, false) → SIXTY_FRAME_TIME、不循环、播完停在末帧）
        let jEnt = null;
        if (files) {
          for (const base of files) {
            const paths = _animPathsAny(iniPath, base);
            if (!paths.length) continue;
            const isMania = base.startsWith("mania-hit");
            jEnt = _animEnt(paths, dt, isMania ? PLAY_ANIM_JUDGE_MS : PLAY_ANIM_60FPS_MS, isMania);
            if (jEnt) break;
          }
        }
        if (jEnt && jEnt.w > 0) {
          const sc = _playJudgeScale(dt, res);
          const h = (jEnt.h / 1.6) * scale * sc;
          const w = Math.max(1, jEnt.w * h / jEnt.h);
          const py = Y(judgeY);
          ctx.save();
          ctx.globalAlpha = Math.max(0, Math.min(1, _playJudgeAlpha(dt)));
          // miss 额外绕 Centre 旋转到随机角（官方 RotateTo 0 → ±5.73°, 100ms Out）
          const rot = res === "miss" ? _playJudgeRot(k) * _playJudgeOut(dt) : 0;
          if (rot) {
            ctx.translate(judgeCx, py);
            ctx.rotate(rot * Math.PI / 180);
            ctx.drawImage(jEnt.img, -w / 2, -h / 2, w, h);
          } else {
            ctx.drawImage(jEnt.img, judgeCx - w / 2, py - h / 2, w, h);
          }
          ctx.restore();
        }
      }
    }

    // 打击爆炸（LightingN / ExplosionImage，官方 LegacyHitExplosion：Additive，按列显示）
    if (explPaths.length) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let k = a; k < b; k++) {
        const dt = t - ev.t[k];
        if (dt < 0 || dt >= PLAY_EXPLODE_IN + PLAY_EXPLODE_OUT) continue;
        const explEnt = _animEnt(explPaths, dt, explFrameLen, false);
        if (!explEnt || explEnt.w <= 0) continue;
        const i = ev.i[k];
        const ew = (nWidths[i] > 0 ? nWidths[i] : (cols[i][1] - cols[i][0])) * scale;
        const eh = Math.max(1, explEnt.h * ew / explEnt.w);
        ctx.globalAlpha = Math.max(0, Math.min(1, _playExplodeAlpha(dt)));
        ctx.drawImage(explEnt.img, cxpx(i) - ew / 2, Y(hitY) - eh / 2, ew, eh);
      }
      ctx.restore();
    }
  }
}

/** 动态预览 HUD：血条 / 分数 / 准确率 / 连击（数值随时间推进）。 */
function _drawPlayHud(sx, sy, screenW, scale, X, Y, vals, cols) {
  const ctx = _p.ctx;
  const ev = _p.play.events;
  const t = _playTimeMs();
  const stat = ev && ev.n ? _playStatsAt(ev, t) : { combo: 0, score: 0, acc: 100, hp: 1, k: 0 };
  const stageLeft = cols[0][0], stageRight = cols[cols.length - 1][1];
  _drawScorebar(X(stageRight), sy + 480 * scale, scale, stat, ev, t);

  const scorePrefix = _fontPrefix("ScorePrefix", "score");
  const comboPrefix = _fontPrefix("ComboPrefix", "combo");
  const scoreImg = _imgEntLoaded(_digitPath(scorePrefix, "1"));
  const scoreH = (scoreImg ? scoreImg.h : 26) / 1.6 * scale;
  const scoreOverlap = _num(state.ini.get("Fonts", "ScoreOverlap"), 0) / 1.6 * scale;
  const hudRight = 14 / 1.6 * scale;
  // 官方 RollingCounter：分数 1000ms / 准确率 375ms 滚动到新值，不随判定瞬间跳变
  const scoreShown = Math.round(_playRoll("score", stat.score, PLAY_ROLL_SCORE_MS, t));
  const accShown = _playRoll("acc", stat.acc, PLAY_ROLL_ACC_MS, t);
  // 官方 LegacyScoreCounter / LegacyAccuracyCounter 的 LegacySpriteText 均为 FixedWidth：
  // 数字等宽步进，否则数值滚动时整串宽度会随数字（如 7 比其他数字窄）来回伸缩
  _drawNumber(String(scoreShown).padStart(8, "0"), scorePrefix,
    sx + screenW - hudRight, sy + 10 / 1.6 * scale, "right", scoreH, scoreOverlap, "score-0", null, 1, true);
  _drawNumber(`${accShown.toFixed(2)}%`, scorePrefix,
    sx + screenW - hudRight, sy + 45 / 1.6 * scale, "right", scoreH * 0.6, scoreOverlap, null, null, 1, true);

  // 连击计数（场地水平居中，ComboPosition 为数字中心 Y；0 连不显示）
  const comboY = _num(vals.get("ComboPosition"), 111);
  const comboImg = _imgEntLoaded(_digitPath(comboPrefix, "1"));
  const comboH = (comboImg ? comboImg.h : 44) / 1.6 * scale;
  const comboOverlap = _num(state.ini.get("Fonts", "ComboOverlap"), 0) / 1.6 * scale;
  const comboCx = X((stageLeft + stageRight) / 2);
  const comboCy = Y(comboY);

  // 断连（官方 LegacyManiaComboCounter.updateCount(rolling: combo==0)）：
  // popOutCountText 用 ColourBreak（默认红）着色，alpha 立即 0.8 后 200ms 淡出到 0，
  // 同时 scale 1 → 4；被断掉的连击数由 displayedCountText 在 diff×20ms 内滚动到 0（alpha 0.5）。
  const cb = _parseRgba(vals.get("ColourBreak"), [255, 0, 0, 255]);
  const brkIdx = ev && ev.breaks ? bisectLeft(ev.breaks, t, "t") : 0;
  const brk = ev && ev.breaks && brkIdx > 0 ? ev.breaks[brkIdx - 1] : null;
  if (brk) {
    const dt = t - brk.t;
    if (cb[3] > 0 && dt < 200) {
      const p = dt / 200;
      const h = comboH * (1 + 3 * p);
      ctx.globalAlpha = Math.max(0, 0.8 * (1 - p));
      _drawNumber(String(brk.combo), comboPrefix, comboCx, comboCy - h / 2, "center", h, comboOverlap, null, cb.slice(0, 3));
      ctx.globalAlpha = 1;
    }
    const rollDur = brk.combo * 20;
    if (stat.combo === 0 && dt < rollDur) {
      const roll = Math.round(brk.combo * (1 - dt / rollDur));
      if (roll > 0) {
        ctx.globalAlpha = 0.5;
        _drawNumber(String(roll), comboPrefix, comboCx, comboCy - comboH / 2, "center", comboH, comboOverlap);
        ctx.globalAlpha = 1;
      }
    }
  }

  if (stat.combo > 0) {
    // 官方 onCountIncrement：连击 +1 时数字瞬时纵向拉伸到 1.4，再 300ms 缓动回 1
    const punch = _playComboPunchScale(ev, t, stat.combo);
    // 官方 stable：按住长条（LN）期间连击计数器用 ColourHold 着色（默认橙金 255,191,51），
    // 松开恢复贴图原色；alpha = 0 时视为完全透明（不着色）。
    let holdTint = null;
    if (_p.play.anyHeld) {
      const hrgb = _parseRgba(vals.get("ColourHold"), [255, 191, 51, 255]);
      if (hrgb[3] > 0) holdTint = hrgb.slice(0, 3);
    }
    _drawNumber(String(stat.combo), comboPrefix,
      comboCx, comboCy - comboH / 2, "center", comboH, comboOverlap, "combo-0", holdTint, punch);
  }
}

/** 连击数字的官方跳动系数（LegacyManiaComboCounter.onCountIncrement）：
 * 连击 +1 时瞬时 ScaleTo(1, 1.4)，随后 300ms Easing.Out（二次）回到 (1, 1)。
 * 仅当正在显示的连击数就是最近一次判定加出来的连击时生效，其余情况为 1。 */
function _playComboPunchScale(ev, t, combo) {
  if (!ev || !ev.n || combo <= 0) return 1;
  const k = bisectLeft(ev.t, t);
  if (k <= 0 || ev.pCombo[k] !== combo) return 1;
  const dt = t - ev.t[k - 1];
  if (dt < 0 || dt >= PLAY_COMBO_PUNCH_MS) return 1;
  const ease = 1 - Math.pow(1 - dt / PLAY_COMBO_PUNCH_MS, 2);
  return 1 + (PLAY_COMBO_PUNCH_SCALE_Y - 1) * (1 - ease);
}

// ---------------------------------------------------------------------------
// 主绘制流程（移植自 Python _draw）
// ---------------------------------------------------------------------------

function _draw(ctx, cw, ch) {
  const page = _pv("page", "静态游玩预览");
  const play = !!(_p.play && _p.play.bm) && page === "动态游玩预览";
  const playKeys = play ? Math.max(1, Math.min(18, _p.play.keys)) : null;
  const vals = _collectValues(playKeys);
  const keys = playKeys || Math.max(1, Math.min(18, parseInt(_num(vals.get("Keys"), 4), 10) || 4));
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
  // NoteBodyStyle（osu!stable / wiki 语义，见 _holdBodyAnchors）：
  // 0=Stretch、1=Cascade from top（默认）、2=Cascade from bottom；
  // stable 枚举另含 3=RepeatBottom、4=RepeatTopAndBottom。
  // 官方 LegacySkin：skin.ini 显式设置的值始终生效，与 [General] Version 无关；
  // Version 只决定「未设置时」的默认值（< 2.5 → Stretch），故分两种情形处理。
  const bodyStyleRaw = vals.get("NoteBodyStyle");
  const bodyStyleVal = bodyStyleRaw == null ? null : _choice(bodyStyleRaw, 1);
  const noteBodyStyle =
    bodyStyleVal == null
      ? (_skinVersion() >= 2.5 ? 1 : 0)
      : bodyStyleVal >= 0 && bodyStyleVal <= 4
        ? bodyStyleVal
        : 0;
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

  // 屏幕背景：动态预览用谱面自带背景（官方游玩界面显示歌曲背景），
  // 其余页面用皮肤 menu-background / menu-bg（等比覆盖铺满、居中裁掉溢出），否则纯黑
  let bgPath = null;
  if (_pv("bg", true)) {
    if (play && _p.play && _p.play.bgPath) bgPath = _p.play.bgPath;
    else bgPath = _mgrPath("menu-background") || _mgrPath("menu-bg");
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
  if (_pv("page", "静态游玩预览") === "失败界面") {
    _drawFail(sx, sy, screenW, screenH, scale);
    return;
  }

  // 列底（倒置时 Y(0) 在画面框底部，取两端较小者为上沿，否则会画到画面框外）
  const fieldTop = Math.min(Y(0), Y(480));
  const fieldH = Math.abs(Y(480) - Y(0));
  for (let i = 0; i < cols.length; i++) {
    const [x0, x1] = cols[i];
    const rgba = _parseRgba(vals.get(`Colour${i + 1}`), [0, 0, 0, 255]);
    // 官方 LegacyStageBackground：列底色走 ApplyWithDoubledAlpha → 最终 alpha = (A/255)²，
    // A = 0 时完全不可见（原项目在此丢弃 alpha，且给 A = 0 兜底了 #1c1c22，均与官方不符）。
    const bgAlpha = _doubledAlpha(rgba);
    if (bgAlpha <= 0) continue;
    ctx.save();
    ctx.globalAlpha = bgAlpha;
    ctx.fillStyle = rgb_to_hex(rgba.slice(0, 3));
    ctx.fillRect(X(x0), fieldTop, (x1 - x0) * scale, fieldH);
    ctx.restore();
  }

  // 血条（屏幕级 HUD）：移至舞台装饰之后绘制，避免被舞台底部/左右边框遮挡，
  // 与官方一致（HUD 位于 StageForeground 层之上）。贴屏幕底边、锚定最右轨道右侧，
  // 倒置时不随舞台翻转。绘制位置见下方 HUD 区块（与分数/连击同层）。
  // 列分隔线（xK 共 x+1 条）
  // 官方 LegacyStageBackground 的列线 Container：Scale = (0.740, 1)（宽度 ×0.740，纵向不缩），
  // 且包在 HitTargetInsetContainer 内（Down 时底边内缩到判定线、Up 时顶边内缩到判定线）
  // → 纵向只画到判定线，不铺满全高。颜色同样走 ApplyWithDoubledAlpha（最终 alpha = (A/255)²）。
  const colLineAlpha = _doubledAlpha(colLine);
  const lineXs = [cols[0][0]].concat(cols.map((c) => c[1]));
  for (let j = 0; j < lineXs.length; j++) {
    const lw = Math.max(0, lineWidths[j]) * PLAY_COL_LINE_SCALE * scale;
    if (!colLineColor || colLineAlpha <= 0 || lw <= 0) continue;
    ctx.save();
    ctx.globalAlpha = colLineAlpha;
    ctx.strokeStyle = colLineColor;
    ctx.lineWidth = Math.max(1, Math.round(lw));
    ctx.beginPath();
    ctx.moveTo(X(lineXs[j]), Y(0));
    ctx.lineTo(X(lineXs[j]), Y(hitY));
    ctx.stroke();
    ctx.restore();
  }

  // 小节线（barline）：官方 LegacyBarLine 用 Height = BarlineHeight ?? 1.2、Colour = ColourBarline ?? 白，
  // RelativeSizeAxes = X（每列各一条），位置即该小节时刻的滚动位置（随谱面下落）。
  // 动态预览按谱面小节时刻滚动；其余页面保留舞台中部 y=240 的静态示意线。
  const barlineRgba = _parseRgba(vals.get("ColourBarline"), [255, 255, 255, 255]);
  const barlineH = Math.max(0, _num(vals.get("BarlineHeight"), 1.2)) * scale;
  const drawBarLine = (u) => {
    // 官方 LegacyBarLine：Colour = ColourBarline（不经 DoubledAlpha，alpha 直接生效）、
    // Height = BarlineHeight。故 A = 0 时颜色完全透明、Height = 0 时高度为 0，均不可见。
    if (barlineRgba[3] <= 0 || barlineH <= 0) return;
    const y = Y(u);
    ctx.strokeStyle = rgb_to_hex(barlineRgba.slice(0, 3));
    ctx.lineWidth = Math.max(1, Math.round(barlineH));
    for (let i = 0; i < cols.length; i++) {
      ctx.beginPath();
      ctx.moveTo(X(cols[i][0]), y);
      ctx.lineTo(X(cols[i][1]), y);
      ctx.stroke();
    }
  };
  const bmLines = play && _p.play.bm ? _p.play.bm.barLines : null;
  if (bmLines && bmLines.length) {
    const tNow = _playTimeMs();
    const vBar = _playScrollVel();
    for (const bl of bmLines) {
      const u = hitY - (bl.t - tNow) * vBar;
      if (u < -4 || u > 484) continue;
      drawBarLine(u);
    }
  } else {
    drawBarLine(240);
  }

  // 舞台灯光（静态预览演示：右半列模拟按下，颜色按 ColourLight 着色）
  // 动态预览由 _drawPlayNotes 按真实按键状态绘制，故此处只在非动态预览时绘制，
  // 否则动态预览的右半列会一直亮着这层“假灯光”。
  // 按需求纳入“显示默认组件”开关：关闭则隐藏按压灯光效果
  if (!play) {
  const lightPath = _resolvePath(vals.get("StageLight"), "mania-stage-light");
  if (lightPath && _showDefaultOn()) {
    const lightEnt = _imgEntLoaded(lightPath);
    for (let i = 0; i < cols.length; i++) {
      if (i < half) continue;
      const [x0, x1] = cols[i];
      const colLight = _parseRgba(vals.get(`ColourLight${i + 1}`), [55, 255, 255, 255]);
      const tinted = lightEnt ? _tintEl(lightEnt.img, colLight.slice(0, 3)) : null;
      if (tinted) {
        // 官方 LegacyColumnBackground：灯光 RelativeSizeAxes = X / Width = 1（宽 = 列宽）、
        // 高度 = 贴图逻辑高（768 空间 → 480 空间 ÷1.6），容器锚在 LightPosition 向上生长。
        const lw = (x1 - x0) * scale;
        const lh = Math.max(1, lightEnt.h * scale / 1.6);
        const ly = upside ? Y(lightY) : Y(lightY) - lh;
        _drawEl(tinted, X(x0), ly, lw, lh);
        _pick("mania-stage-light", X(x0), ly, lw, lh);
      }
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

  // 判定线（mania-stage-hint；分离模式每个舞台各画一条）
  // 官方层级：命中检测器属于 HitObjectArea.hitTarget，位于 UnderlayElements 之后、
  // 音符 content 之前 → 音符会盖住判定线，而按键（KeyArea）盖住判定线。
  // 故动态预览在音符之前调用；静态预览仍在音符之后绘制（便于查看/点选演示音符下的判定线）。
  // 选中信息单独收集，最后统一登记，避免打乱「绘制顺序 = 可点选层级」的约定。
  const hintPath = _resolvePath(vals.get("StageHint"), "mania-stage-hint");
  const stageRanges = split
    ? [[cols[0][0], cols[half - 1][1]], [cols[half][0], cols[cols.length - 1][1]]]
    : [[stageLeft, stageRight]];
  const hintPicks = [];
  const drawHitTarget = () => {
    for (const [sl, sr] of stageRanges) {
      const sw = sr - sl;
      const hEnt = hintPath ? _imgEntLoaded(hintPath) : null;
      // 官方 LegacyHitTarget：提示线贴图 RelativeSizeAxes = X（宽 = 舞台宽，不按比例），
      // Scale = (1, 0.9 × 1.6025)（768 空间 → 480 空间再 ÷1.6）；
      // 其容器 Origin = CentreLeft + Anchor = BottomLeft（下）/ TopLeft（上）、AutoSizeAxes = Y，
      // 即贴图以判定线为**垂直中心**（不是底边贴线），上方向再整体纵向镜像（Scale = (1, -1)）。
      // 原项目按舞台宽等比算高（1x1 占位图会撑成巨大方块）并额外加了 20% 上限，均与官方不符。
      const th = hEnt && hEnt.w > 0 ? Math.max(1, hEnt.h * PLAY_HINT_SCALE_Y * scale) : 0;
      const cx = X((sl + sr) / 2) - sw * scale / 2;
      const cy = Y(hitY) - th / 2;
      if (th > 0) {
        _drawEnt(hEnt, cx, cy, sw * scale, th, false, upside);
        hintPicks.push({ cx, cy, w: sw * scale, h: th });
      } else {
        ctx.strokeStyle = judgeLineColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(X(sl), Y(hitY));
        ctx.lineTo(X(sr), Y(hitY));
        ctx.stroke();
      }
      // 判定提示线（JudgementLine 命令）——与提示线贴图同容器、Anchor = CentreLeft
      // （竖直方向与贴图中心对齐 = 判定线本身）；Height = 1（768 空间 → 480 空间 0.625）、
      // Alpha = 0.9，颜色经 DisallowZeroAlpha（A = 0 时按 1 处理，仍按 0.9 显示）。
      // 官方 LegacyManiaSkinConfiguration.ShowJudgementLine 默认 true（缺省也显示判定线），
      // 因此只有字段存在且值非 "1"（如 JudgementLine: 0 / 留空）时才隐藏。
      const showJL = vals.has("JudgementLine") ? _bool(vals.get("JudgementLine")) : true;
      if (showJL) {
        const jlA = judgeLine[3] === 0 ? 1 : judgeLine[3] / 255;
        ctx.save();
        ctx.globalAlpha = PLAY_JUDGE_LINE_ALPHA * jlA;
        ctx.strokeStyle = judgeLineColor;
        ctx.lineWidth = Math.max(1, PLAY_JUDGE_LINE_H * scale);
        ctx.beginPath();
        ctx.moveTo(X(sl), Y(hitY));
        ctx.lineTo(X(sr), Y(hitY));
        ctx.stroke();
        ctx.restore();
      }
    }
  };

  if (play) {
    _drawPlayNotes({ ctx, scale, cols, keys, vals, layout, flipKeys, flipNotes, upside, hitY, refW, noteBodyStyle, split, X, Y, drawHitTarget });
  } else {
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

  // 身体（颜色由贴图本身决定，ColourHold 不作用于身体）
  const bodyPath = _resolvePath(vals.get(`NoteImage${ln}L`), `mania-note${layout[ln]}L`);
  const bodyOut = bodyPath
    ? _buildHoldBody(bodyPath, noteBodyStyle, lnW, lnLen * scale, refW, scale)
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

  drawHitTarget();
  } // 结束对局/静态音符分支

  // 判定线绘制在上面各分支内完成（动态预览在音符之前，见 drawHitTarget），
  // 这里统一补登选中信息，保持它在点击层级里的位置与原实现一致。
  for (const p of hintPicks) _pick("mania-stage-hint", p.cx, p.cy, p.w, p.h);

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

  if (play) {
  // ---- 动态预览 HUD：血条 / 分数 / 准确率 / 连击（随音乐推进） ----
  _drawPlayHud(sx, sy, screenW, scale, X, Y, vals, cols);
  } else {
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
  if (split && !_boolFalse(vals.get("SeparateScore"))) {
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

  if (!play) {
    // 页面切换：游玩界面在 HUD 之上绘制“跳过”按钮；暂停界面绘制覆盖层
    if (page === "静态游玩预览") _drawPlaySkip(sx, sy, screenW, screenH, scale);
    if (page === "暂停界面") _drawPause(sx, sy, screenW, screenH, scale);
  }
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

/**
 * skin.ini 的 [General] Version（官方 LegacySkinDecoder / LegacySkinDecoder.CreateTemplateObject）：
 * 缺省 1.0；"latest" → SkinConfiguration.LATEST_VERSION（2.7）；非法值回落 1.0。
 * 用于 NoteBodyStyle 的生效门限（官方：该命令自 2.5 起加入，低版本忽略 → Stretch）。
 */
function _skinVersion() {
  const raw = state.ini ? state.ini.get("General", "Version") : null;
  const s = raw == null ? "" : String(raw).trim();
  if (s === "") return 1.0;
  if (s.toLowerCase() === "latest") return 2.7;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : 1.0;
}

/** 预览字段：键数跟随编辑器选择，字段取该键数对应的 [Mania] 段
 * （与原项目一致：vals 来自编辑器 UI，键数切换即切换所绘制的段）。
 * 注意与 Python 版 sec.get 一致：同一键出现多次时取第一个匹配值，
 * 而非最后覆盖（否则编辑第一个值后预览仍取旧值，表现为"改位置没反应"）。 */
function _collectValues(keysOverride) {
  const keys = keysOverride || _currentKeys();
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
  sel.value = _pv("page", "静态游玩预览");
  sel.addEventListener("change", () => _onPageChange(sel.value));
  bar.appendChild(sel);
  _p.pageSel = sel;

  // 导入铺面（动态预览）
  const importBtn = document.createElement("button");
  importBtn.className = "btn btn-tool preview-btn-sm";
  importBtn.textContent = "导入铺面";
  importBtn.title = "选择一张 .osu 谱面（可一并选择其音频）进行动态预览";
  importBtn.addEventListener("click", _importBeatmap);
  bar.appendChild(importBtn);

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

/** 构建动态预览控制行（歌曲名 / 播放 / 进度条 / 倍速 / 下落速度）。
 * 由 renderPreview 按设置 play_bar_pos 放到工具栏内（画布上方）或画布下方。 */
function _buildPlayCtl() {
  const playCtl = document.createElement("div");
  playCtl.className = "preview-play";
  playCtl.hidden = true;
  playCtl.innerHTML = `
    <span class="preview-play-title"></span>
    <button class="btn btn-tool preview-btn-sm preview-play-btn">▶ 播放</button>
    <input type="range" class="preview-progress" min="0" max="1" step="1" value="0">
    <span class="preview-play-time">0:00 / 0:00</span>
    <label class="preview-speed"><span>倍速</span>
      <select class="preview-rate-sel">${PLAY_RATES.map((r) => `<option value="${r}">${r}×</option>`).join("")}</select>
    </label>
    <label class="preview-speed"><span>下落速度</span>
      <input type="range" class="preview-speed-sel" min="${PLAY_SPEED_MIN}" max="${PLAY_SPEED_MAX}" step="1">
      <span class="preview-speed-val"></span>
    </label>
    <button class="btn btn-tool preview-btn-sm preview-fs-btn" title="全屏播放（F11）">⛶ 全屏</button>
  `;
  const t = _p.play || _playReset();
  t.ctl = playCtl;
  t.titleLbl = playCtl.querySelector(".preview-play-title");
  t.playBtn = playCtl.querySelector(".preview-play-btn");
  t.progress = playCtl.querySelector(".preview-progress");
  t.timeLbl = playCtl.querySelector(".preview-play-time");
  t.speedSel = playCtl.querySelector(".preview-speed-sel");
  t.speedVal = playCtl.querySelector(".preview-speed-val");
  t.rateSel = playCtl.querySelector(".preview-rate-sel");
  t.fsBtn = playCtl.querySelector(".preview-fs-btn");
  t.speedSel.value = String(t.speed);
  t.speedVal.textContent = String(t.speed);
  t.rateSel.value = String(t.rate);
  t.playBtn.addEventListener("click", () => _playToggle());
  t.progress.addEventListener("input", () => { if (t.progress.value !== "") _playSeek(Number(t.progress.value)); });
  t.speedSel.addEventListener("input", () => _playSetSpeed(t.speedSel.value));
  t.speedSel.addEventListener("change", () => persistSettings()); // 松手时把下落速度写进设置
  t.rateSel.addEventListener("change", () => { _playSetRate(t.rateSel.value); persistSettings(); });
  t.fsBtn.addEventListener("click", () => _togglePlayFullscreen());
  return playCtl;
}

/** 页面切换统一处理：状态、调度、控制行显隐、对局循环启停。 */
function _onPageChange(page) {
  state.preview.page = page;
  _commitPreview();
  emit("preview:page-changed");
  const playMode = page === "动态游玩预览";
  const p = _p.play;
  // 控制行（歌曲名 / 播放 / 进度条 / 倍速 / 下落速度）：仅动态预览且有谱面时显示
  if (p && p.ctl) p.ctl.hidden = !(playMode && p.bm);
  if (playMode && p && p.bm) {
    _schedulePlayLoop();
  } else if (!playMode) {
    _stopPlayLoop();
    if (p) _playPause();
  }
  _scheduleDraw();
}

/** 切到动态预览（导入成功后调用）。 */
function _playSwitchTo(page) {
  if (_p.pageSel) _p.pageSel.value = page;
  _onPageChange(page);
}

function _syncBar() {
  if (_p.pageSel) _p.pageSel.value = _pv("page", "静态游玩预览");
  if (_p.aspectSel) {
    _p.aspectSel.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.val === state.preview.aspect);
    });
  }
}

/** 恢复动态预览控制行显隐（画布重渲染后调用）；仅动态预览且有谱面时显示。 */
function _syncPlayCtl() {
  const p = _p.play;
  if (!p || !p.ctl) return;
  const onPlay = _pv("page", "静态游玩预览") === "动态游玩预览" && !!p.bm;
  p.ctl.hidden = !onPlay;
  if (onPlay && !p.raf) _schedulePlayLoop();
  // 离开动态预览（或谱面被清空）时自动退出全屏播放：否则工具栏被隐藏、无退出入口
  if (!onPlay && _p.fullscreen) _setPlayFullscreen(false);
}

/** 把控制行放到设置 play_bar_pos 指定的位置（工具栏内 / 画布下方）。
 * 设置变更时也可直接调用，无需重建整个预览。 */
function _applyPlayBarPos() {
  const p = _p.play;
  if (!p || !p.ctl) return;
  const target = state.settings.play_bar_pos === "bottom" ? _p.host : _p.bar;
  if (target && p.ctl.parentElement !== target) target.appendChild(p.ctl);
}

// ---------------------------------------------------------------------------
// 全屏播放（F11 快捷键 / 控制行按钮）：窗口原生全屏 + 隐藏工具栏与右侧面板
// ---------------------------------------------------------------------------

/** 参与全屏的元素（浏览器调试环境退回 DOM 全屏时使用）。 */
function _fsTarget() {
  return _p.host || document.getElementById("preview-pane");
}

/** 仅动态预览（有谱面、控制行可见）时允许进入全屏播放，避免无退出按钮。 */
function _canFullscreen() {
  const p = _p.play;
  return !!p && !!p.ctl && !p.ctl.hidden;
}

/** 同步全屏播放的界面状态：body class + 按钮文案。 */
function _syncFullscreenUi() {
  document.body.classList.toggle("play-fullscreen", !!_p.fullscreen);
  const b = _p.play && _p.play.fsBtn;
  if (b) {
    b.textContent = _p.fullscreen ? "⛶ 退出全屏" : "⛶ 全屏";
    b.title = _p.fullscreen ? "退出全屏播放（F11）" : "全屏播放（F11）";
  }
}

async function _setPlayFullscreen(on) {
  if (on === _p.fullscreen) return;
  _p.fullscreen = on;
  _p.fsDom = false;
  const handled = await setWindowFullscreen(on);
  if (!handled) {
    // 非 Tauri 环境（浏览器调试）：退回 DOM 全屏
    try {
      if (on) { await _fsTarget().requestFullscreen(); _p.fsDom = true; }
      else if (document.fullscreenElement) await document.exitFullscreen();
    } catch (e) {
      _p.fullscreen = false;
      _syncFullscreenUi();
      return toast("无法切换全屏：" + (e.message || e), "error");
    }
  }
  _syncFullscreenUi();
  _resize(); // 全屏切换后可用尺寸变化，立即重算一次画布
}

function _togglePlayFullscreen() {
  return _setPlayFullscreen(!_p.fullscreen);
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
  // 兼容旧设置：页面旧名（对局预览 / 动态预览 / 游玩界面）迁移到新名，否则旧 settings.json 的旧值会与下拉失配
  const PAGE_ALIAS = { "对局预览": "动态游玩预览", "动态预览": "动态游玩预览", "游玩界面": "静态游玩预览" };
  if (PAGE_ALIAS[state.preview.page]) state.preview.page = PAGE_ALIAS[state.preview.page];
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

  // 动态预览控制行（歌曲名 / 播放 / 进度条 / 下落速度），位置由设置 play_bar_pos 决定
  _buildPlayCtl();

  _p.bar = bar;
  _p.wrap = wrap;
  _p.host = host;
  _p.canvas = canvas;
  _p.ctx = canvas.getContext("2d");
  _p.aspectSel = bar.querySelector(".preview-aspect");
  _syncBar();
  _applyPlayBarPos();
  _syncPlayCtl();

  canvas.addEventListener("click", _onCanvasClick);
  canvas.addEventListener("dblclick", _onCanvasDblClick);
  window.addEventListener("resize", _resize);
  if (!_p.resizeObs && typeof ResizeObserver !== "undefined") {
    _p.resizeObs = new ResizeObserver(_resize);
  }
  if (_p.resizeObs) _p.resizeObs.observe(wrap);

  _resize();

  // 全屏播放：F11 快捷键（只绑定一次，renderPreview 会因换皮肤等原因重复调用）
  if (!_p.fsKeysBound) {
    _p.fsKeysBound = true;
    window.addEventListener("keydown", (e) => {
      if (e.key !== "F11") return;
      e.preventDefault(); // 阻止 WebView2 默认行为，统一走我们的全屏播放
      if (_p.fullscreen || _canFullscreen()) _togglePlayFullscreen();
    });
    // 浏览器调试环境退回 DOM 全屏时，用户按 Esc 退出 → 同步界面状态
    document.addEventListener("fullscreenchange", () => {
      if (!_p.fsDom || document.fullscreenElement) return;
      _p.fsDom = false;
      _p.fullscreen = false;
      _syncFullscreenUi();
      _resize();
    });
  }
  _syncFullscreenUi();

  // 恢复上次载入的谱面（已有谱面时不重复导入，避免换皮肤/重扫时重置播放进度）
  if (state.settings.last_beatmap && !(_p.play && _p.play.bm)) _restoreLastBeatmap();

  // 数据联动
  on("skin:reloaded", () => {
    // 文件清单可能变化（重扫描/覆盖素材）：清空图片缓存并回收 Blob URL，重新加载
    for (const ent of _p.imgCache.values()) {
      if (ent && ent.url) URL.revokeObjectURL(ent.url);
    }
    _p.imgCache.clear();
    // 派生缓存均引用旧 Image 对象，必须一并清空，否则素材被覆盖后仍显示旧合成图
    _p.tintCache.clear();
    _p.animCache.clear();
    _p.holdCache.clear();
    _scheduleDraw();
  });
  on("skin:opened", () => {
    // 换皮肤时回收旧皮肤的 Blob URL，并清空图片缓存
    for (const ent of _p.imgCache.values()) {
      if (ent && ent.url) URL.revokeObjectURL(ent.url);
    }
    _p.imgCache.clear();
    _p.tintCache.clear();
    _p.animCache.clear();
    _p.holdCache.clear();
    _scheduleDraw();
  });
  on("ini:changed", _scheduleDraw);
  on("settings:changed", () => { _applyPlayBarPos(); _syncJudgeEvents(); _scheduleDraw(); });
  on("preview:element-selected", () => { /* 元素面板会自行处理 */ });
}

/** 触发预览重绘（防抖）。 */
export function refreshPreview() {
  _scheduleDraw();
}

/** 退出全屏播放（若处于全屏）；供关窗前调用，避免把全屏尺寸写进窗口状态。 */
export async function exitPlayFullscreen() {
  if (_p.fullscreen) await _setPlayFullscreen(false);
}

/** 挂载预览控制栏（兼容旧调用；控制栏在 renderPreview 中已构建）。 */
export function mountPreviewActions() {
  /* 控制栏交互已在 renderPreview 中绑定 */
}
