// skin.ini 解析、序列化与命令 schema（与 Python 版 skin_ini.py 逻辑一致）

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

export class Entry {
  constructor({ key = "", value = "", isComment = false } = {}) {
    this.key = key;
    this.value = value;
    this.isComment = isComment;
  }
}

export class Section {
  constructor(name, entries = []) {
    this.name = name;
    this.entries = entries;
  }

  get(key) {
    for (const e of this.entries) {
      if (!e.isComment && e.key === key) return e.value;
    }
    return null;
  }

  set(key, value) {
    for (const e of this.entries) {
      if (!e.isComment && e.key === key) {
        e.value = value;
        return;
      }
    }
    this.entries.push(new Entry({ key, value }));
  }

  // 删除指定键；不存在则无操作。用于"留空保存→删除该行"（osu 报 Value is empty 的规避）
  del(key) {
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (!e.isComment && e.key === key) {
        this.entries.splice(i, 1);
        return;
      }
    }
  }

  keys() {
    return this.entries.filter((e) => !e.isComment).map((e) => e.key);
  }
}

export class SkinIni {
  constructor(sections = []) {
    this.sections = sections;
  }

  static parse(text) {
    const ini = new SkinIni();
    let current = null;
    for (const rawLine of String(text).split("\n")) {
      const raw = rawLine.replace(/\r$/, "");
      const line = raw.trim();
      if (!line) {
        if (current) current.entries.push(new Entry({ isComment: true, value: "" }));
        continue;
      }
      if (line.startsWith("[")) {
        const name = line.endsWith("]") ? line.slice(1, -1).trim() : line.slice(1).trim();
        current = new Section(name);
        ini.sections.push(current);
      } else if (line.startsWith("//") || line.startsWith("#")) {
        // osu! 注释以 // 开头；行首 # 也视为注释（与 mania 列命令名不冲突）
        if (current) current.entries.push(new Entry({ isComment: true, value: raw }));
      } else {
        const idx = line.indexOf(":");
        if (idx >= 0) {
          const key = line.slice(0, idx).trim();
          let value = line.slice(idx + 1);
          // 行尾 // 到末尾皆为注释，须从值中剥离
          const cidx = value.indexOf("//");
          value = (cidx >= 0 ? value.slice(0, cidx) : value).trim();
          if (current) current.entries.push(new Entry({ key, value }));
        } else {
          // 无法识别的行保留原文作为注释
          if (current) current.entries.push(new Entry({ isComment: true, value: raw }));
        }
      }
    }
    return ini;
  }

  serialize() {
    const lines = [];
    for (const sec of this.sections) {
      lines.push(`[${sec.name}]`);
      for (const e of sec.entries) {
        if (e.isComment) {
          // 丢弃纯空行条目：原文件空行被 parse 记为 comment，若照原样输出
          // 再叠加 section 结尾的 push("")，保存后会出现"空出一大行"。
          // 注释文本（// 等）保留。
          if (e.value === "") continue;
          lines.push(e.value);
        } else {
          lines.push(`${e.key}: ${e.value}`);
        }
      }
      lines.push("");
    }
    return lines.join("\n").replace(/\n+$/, "") + "\n";
  }

  section(name) {
    return this.sections.find((s) => s.name === name) || null;
  }

  sectionsNamed(name) {
    return this.sections.filter((s) => s.name === name);
  }

  get(sectionName, key, deflt = null) {
    const sec = this.section(sectionName);
    if (!sec) return deflt;
    const v = sec.get(key);
    return v === null ? deflt : v;
  }

  set(sectionName, key, value) {
    let sec = this.section(sectionName);
    if (!sec) {
      sec = new Section(sectionName);
      this.sections.push(sec);
    }
    sec.set(key, String(value));
  }

  // 删除某 section 的键（section 不存在则无操作）
  del(sectionName, key) {
    const sec = this.section(sectionName);
    if (sec) sec.del(key);
  }
}

// ---------------------------------------------------------------------------
// 命令 schema
// ---------------------------------------------------------------------------
// type: text / image / int / number / bool / rgb / rgba / list / choice / keys / fontprefix

class Command {
  constructor(key, type, label, deflt = "", choices = [], help = "") {
    this.key = key;
    this.type = type;
    this.label = label;
    this.default = deflt;
    this.choices = choices;
    this.help = help;
  }
}

export const GENERAL_COMMANDS = [
  new Command("Name", "text", "皮肤名称", ""),
  new Command("Author", "text", "作者", ""),
  new Command("Version", "text", "皮肤版本", "latest", [], "1.0/2.x/latest；缺省为 1.0"),
  new Command("AnimationFramerate", "int", "动画帧率", "-1", [], "-1 表示一秒播放完所有帧"),
  new Command("SliderBallFlip", "bool", "滑条球翻转", "1"),
  new Command("AllowSliderBallTint", "bool", "滑条球着色", "0"),
  new Command("CursorRotate", "bool", "光标旋转", "1"),
  new Command("CursorExpand", "bool", "光标点击放大", "1"),
  new Command("CursorCentre", "bool", "光标居中原点", "1"),
  new Command("CursorTrailRotate", "bool", "光标拖尾旋转", "1"),
  new Command("HitCircleOverlayAboveNumber", "bool", "圈覆盖层在数字上方", "1"),
  new Command("LayeredHitSounds", "bool", "叠加打击音", "1"),
  new Command("SpinnerFadePlayfield", "bool", "转盘黑边", "0"),
  new Command("SpinnerFrequencyModulate", "bool", "转盘音调变化", "1"),
  new Command("SpinnerNoBlink", "bool", "转盘进度条不闪烁", "0"),
  new Command("ComboBurstRandom", "bool", "连击图随机顺序", "0"),
  new Command("CustomComboBurstSounds", "text", "自定义连击爆发音效连击数", "", [], "逗号分隔的连击数列表"),
];

export const COLOUR_COMMANDS = [
  new Command("Combo1", "rgb", "连击色 1", "255,192,0"),
  new Command("Combo2", "rgb", "连击色 2", "0,202,0"),
  new Command("Combo3", "rgb", "连击色 3", "18,124,255"),
  new Command("Combo4", "rgb", "连击色 4", "242,24,57"),
  new Command("Combo5", "rgb", "连击色 5", ""),
  new Command("Combo6", "rgb", "连击色 6", ""),
  new Command("Combo7", "rgb", "连击色 7", ""),
  new Command("Combo8", "rgb", "连击色 8", ""),
  new Command("SliderBorder", "rgb", "滑条边框", "255,255,255"),
  new Command("SliderTrackOverride", "rgb", "滑条轨道统一色", "", [], "留空则使用连击色"),
  new Command("SliderBall", "rgb", "滑条球颜色", "2,170,255"),
  new Command("MenuGlow", "rgb", "主菜单光谱条颜色", "0,78,155"),
  new Command("SongSelectActiveText", "rgb", "选中曲目文字色", "0,0,0"),
  new Command("SongSelectInactiveText", "rgb", "未选曲目文字色", "255,255,255"),
  new Command("InputOverlayText", "rgb", "输入覆盖层文字色", "255,255,255"),
  new Command("SpinnerBackground", "rgb", "转盘背景色", "100,100,100"),
  new Command("StarBreakAdditive", "rgb", "休息段 star2 附加色", "255,182,193"),
];

export const FONT_COMMANDS = [
  new Command("HitCirclePrefix", "fontprefix", "打击圈数字前缀", "default"),
  new Command("HitCircleOverlap", "int", "打击圈数字重叠", "-2", [], "负数产生间隔"),
  new Command("ScorePrefix", "fontprefix", "分数数字前缀", "score"),
  new Command("ScoreOverlap", "int", "分数数字重叠", "0"),
  new Command("ComboPrefix", "fontprefix", "连击数字前缀", "score"),
  new Command("ComboOverlap", "int", "连击数字重叠", "0"),
];

export const MANIA_COMMANDS = [
  new Command("Keys", "keys", "键数", "4"),
  new Command("ColumnStart", "number", "左列起点", "136", [], "第一列左缘距舞台左缘的距离（480px 高坐标系）"),
  new Command("ColumnRight", "number", "右边界", "19", [], "最后一列右缘距舞台右缘的距离（480px 高坐标系）"),
  new Command("ColumnWidth", "list", "每列宽度", "30", [], "逗号分隔，可每列不同；效果随 NoteBodyStyle 而定"),
  new Command("ColumnSpacing", "list", "列间距", "0"),
  new Command("ColumnLineWidth", "list", "列分隔线宽", "2"),
  new Command("HitPosition", "int", "判定线高度", "402", [], "音符落到该高度时判定；480px 高坐标系"),
  new Command("LightPosition", "int", "灯光高度", "413", [], "stage-light 的显示位置，一般低于判定线"),
  new Command("LightFramePerSecond", "int", "舞台灯光动画帧率", "", [], "stage-light 贴图的动画帧率；缺省 60"),
  new Command("ScorePosition", "int", "判定提示高度", "300", [], "hitburst/判定评分在场地中的垂直位置（0=顶，480=底）"),
  new Command("ComboPosition", "int", "连击计数高度", "111", [], "连击数字在场地中的垂直位置（0=顶，480=底）"),
  new Command("BarlineHeight", "number", "小节线厚度", "1.2"),
  new Command("ColourBarline", "rgb", "小节线颜色", "255,255,255"),
  new Command("JudgementLine", "bool", "显示判定线", "1"),
  new Command("ColourJudgementLine", "rgb", "判定线颜色", "255,255,255"),
  new Command("ColourColumnLine", "rgba", "列分隔线颜色", "255,255,255,255"),
  new Command("ColourHold", "rgba", "长条身体着色", "255,255,255,255", [], "覆盖长条身体颜色（RGBA）"),
  new Command("ColourBreak", "rgba", "休息段音符着色", "255,255,255,255", [], "覆盖休息段音符颜色（RGBA）"),
  new Command("ColourKeyWarning", "rgb", "按键警告颜色", "255,255,255", [], "按键未按时提示覆盖色（RGB）"),
  new Command("SpecialStyle", "choice", "特殊样式", "0", ["0=无", "1=左/外", "2=右/内"]),
  new Command("ComboBurstStyle", "choice", "连击图位置", "1", ["0=左", "1=右", "2=两侧"]),
  new Command("SplitStages", "bool", "分离为两个舞台", "0", [], "上下分割；1 时特效/连击图分别显示在下/上舞台"),
  new Command("StageSeparation", "number", "舞台间距", "40", [], "SplitStages=1 时两舞台之间的间隔"),
  new Command("SeparateScore", "bool", "判定只显示在对应舞台", "1"),
  new Command("KeysUnderNotes", "bool", "按键被音符覆盖", "0"),
  new Command("UpsideDown", "bool", "始终倒置", "0"),
  new Command("KeyFlipWhenUpsideDown", "bool", "倒置时翻转按键", "1"),
  new Command("NoteFlipWhenUpsideDown", "bool", "倒置时翻转音符", "1"),
  new Command("NoteBodyStyle", "choice", "长条身体样式", "1", ["0=拉伸", "1=从顶", "2=从底"]),
  new Command("WidthForNoteHeightScale", "number", "音符高度缩放基准宽", "", [], "列宽不同时以最窄列为准"),
  new Command("StageLeft", "image", "左舞台贴图", "", [], "mania-stage-left.png"),
  new Command("StageRight", "image", "右舞台贴图", "", [], "mania-stage-right.png"),
  new Command("StageBottom", "image", "底部舞台贴图", "", [], "mania-stage-bottom.png"),
  new Command("StageHint", "image", "判定线贴图", "", [], "mania-stage-hint.png"),
  new Command("StageLight", "image", "舞台灯光贴图", "", [], "mania-stage-light.png"),
  new Command("LightingN", "image", "单点灯光贴图", "", [], "lightingN.png"),
  new Command("LightingL", "image", "长条灯光贴图", "", [], "lightingL.png"),
  new Command("LightingNWidth", "number", "单点灯光宽度", "", [], "灯光贴图拉伸到的宽度"),
  new Command("LightingLWidth", "number", "长条灯光宽度", "", [], "灯光贴图拉伸到的宽度"),
  new Command("WarningArrow", "image", "警告箭头贴图", "", [], "mania-warningarrow.png"),
  new Command("Hit0", "image", "Hit0 贴图", ""),
  new Command("Hit50", "image", "Hit50 贴图", ""),
  new Command("Hit100", "image", "Hit100 贴图", ""),
  new Command("Hit200", "image", "Hit200 贴图", ""),
  new Command("Hit300", "image", "Hit300 贴图", ""),
  new Command("Hit300g", "image", "Hit300g 贴图", ""),
];

// 每列命令。Colour/ColourLight 从 1 起，NoteImage/KeyImage 从 0 起。
export const MANIA_COLUMN_COMMANDS = [
  new Command("Colour{n1}", "rgba", "第{n1}列轨道颜色", "0,0,0,255"),
  new Command("ColourLight{n1}", "rgb", "第{n1}列灯光颜色", "55,255,255"),
  new Command("KeyImage{n0}", "image", "第{n1}列未按按键图", ""),
  new Command("KeyImage{n0}D", "image", "第{n1}列按下按键图", ""),
  new Command("NoteImage{n0}", "image", "第{n1}列音符图", ""),
  new Command("NoteImage{n0}H", "image", "第{n1}列长条头图", ""),
  new Command("NoteImage{n0}L", "image", "第{n1}列长条身图", ""),
  new Command("NoteImage{n0}T", "image", "第{n1}列长条尾图", ""),
];

export const NOTE_LAYOUT = {
  1: ["S"], 2: ["1", "1"], 3: ["1", "S", "1"], 4: ["1", "2", "2", "1"],
  5: ["1", "2", "S", "2", "1"], 6: ["1", "2", "1", "1", "2", "1"],
  7: ["1", "2", "1", "S", "1", "2", "1"], 8: ["1", "2", "1", "2", "2", "1", "2", "1"],
  9: ["1", "2", "1", "2", "S", "2", "1", "2", "1"], 10: ["1", "2", "1", "2", "1", "1", "2", "1", "2", "1"],
  11: ["1", "2", "1", "2", "1", "S", "1", "2", "1", "2", "1"], 12: ["1", "2", "1", "2", "1", "2", "2", "1", "2", "1", "2", "1"],
  13: ["1", "2", "1", "2", "1", "2", "S", "2", "1", "2", "1", "2", "1"], 14: ["1", "2", "1", "2", "1", "2", "1", "1", "2", "1", "2", "1", "2", "1"],
  15: ["1", "2", "1", "2", "1", "2", "1", "S", "1", "2", "1", "2", "1", "2", "1"], 16: ["1", "2", "1", "2", "1", "2", "1", "2", "2", "1", "2", "1", "2", "1", "2", "1"],
  17: ["1", "2", "1", "2", "1", "2", "1", "2", "S", "2", "1", "2", "1", "2", "1", "2", "1"], 18: ["1", "2", "1", "2", "1", "2", "1", "2", "1", "1", "2", "1", "2", "1", "2", "1", "2", "1"],
};

export function maniaSections(ini) {
  return ini.sections.filter((s) => s.name === "Mania");
}

export function findManiaSection(ini, keys) {
  for (const sec of ini.sections) {
    if (sec.name === "Mania" && sec.get("Keys") === String(keys)) return sec;
  }
  return null;
}