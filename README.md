# OsuSkinMaker v0.1.0 (Tauri)

一个集 **游玩预览**、**元素管理**、**skin.ini 编辑**于一体的 osu! mania 皮肤制作 GUI 工具。

⚠️ **使用的话要备份皮肤文件，备份，备份，备份！！！**

<img width="2047" height="1097" alt="image" src="https://github.com/user-attachments/assets/691d8a48-98d2-4be3-a350-bbe5f8e1baf2" />

> 本项目由上一代的 **Python / tkinter 版** **`OsuSkinMaker`**（[上一版 GitHub 仓库](https://github.com/fengpengGG/OsuSkinMaker)）**重写迁移**而来。
>
> 迁移到 **Rust + Tauri v2 + WebView2**，前端改用 **原生 vanilla JS/CSS**，核心逻辑（skin.ini 解析、元素分类、皮肤文件扫描）沿用迁移前的代码思路平移实现。

***

## 目录

### 使用说明

- [从何处而来 / 技术栈](#从何处而来--技术栈)
- [启动](#启动)
- [构建打包](#构建打包)
- [工具栏](#工具栏)
- [设置弹窗](#设置弹窗)
- [记忆功能](#记忆功能)
- [素材文件编码与保存安全](#素材文件编码与保存安全)
- [左侧：游玩预览](#左侧游玩预览)
- [右侧：元素管理](#右侧元素管理)
- [右侧：skin.ini 编辑](#右侧skinini-编辑)
- [注意事项（相对于原版的变化）](#注意事项相对于原版的变化)

### 项目结构

- [文件总览](#文件总览)
- [依赖关系](#依赖关系)
- [前端模块说明](#前端模块说明)
- [后端命令说明](#后端命令说明)
- [辅助文件说明](#辅助文件说明)
- [如何添加新功能](#如何添加新功能)

***

# 使用说明

## 从何处而来 / 技术栈

本工程是 `OsuSkinMaker/`（上一版，Python + tkinter）的**重写版**：

| 维度 | 旧版（OsuSkinMaker/） | 本版（根目录） |
| ------ | ------------------------ | ----------------------------------------------- |
| UI 框架 | tkinter / ttk | **Tauri v2 + WebView2**（前端 HTML/CSS/JS） |
| 语言 | Python 3 | 前端 vanilla JS；后端 **Rust** |
| 前端构建 | 无（单文件 Python） | **无打包器**，原生 JS/CSS/HTML 直出 |
| 渲染引擎 | Canvas (tkinter) | **Canvas (WebView2)** |
| 皮肤图读取 | PIL | 后端 **image crate**（非 Web 格式转 PNG），`tauri://` 协议 |
| 窗口状态恢复 | Python | Rust 侧 tao window API |
| 设置持久化 | `settings/settings.json` | 同目录 `settings/settings.json`（exe 同目录） |

> 迁移原则：**游玩预览结构、元素分类逻辑、文件操作方法、skin.ini 逻辑与官方优先级保持一致**，只是换了壳。

## 启动

前置要求：**Rust (MSVC) 工具链** 与 **Node / npm**（PATH 需包含，参考 `build_exe.ps1` 中的补位逻辑）。

```bash
npm install          # 首次
npm run tauri dev    # 启动 dev server + Rust 窗口（构建第一个窗口）
```

> 也可只起前端（调试 UI）：
>
> ```bash
> npm run dev:server  # 静态服务器，端口 5173（无后端功能，仅看布局）
> ```
>
> 或先编译一次后端 debug exe，再单独跑 `src-tauri\target\debug\OsuSkinMaker.exe`。

启动后自动恢复上次退出时的窗口大小/位置/最大化状态与面板比例，并自动打开上次编辑的皮肤。默认全屏（最大化）。

左侧为**游玩预览**，右侧为**元素管理**和**skin.ini 编辑**，可拖动中间分隔条调整比例。

<br />

**或者下载压缩包点击应用程序启动**

<img width="242" height="235" alt="image" src="https://github.com/user-attachments/assets/a3306028-f6ff-4e83-bdb8-5b41c555ba21" />

## 构建打包

```bash
# 双击 build_exe.bat 或：
powershell -ExecutionPolicy Bypass -File .\build_exe.ps1
```

- 脚本自动补齐 Rust / Node PATH、`npm install`、执行 `npm run tauri build -- --no-bundle`
- **始终 `--no-bundle`**：只产出 `src-tauri\target\release\OsuSkinMaker.exe`，跳过 WiX/MSI 安装包（避免联网下载 WiX 超时）
- 产物自动复制到 `temp\OsuSkinMaker.exe`
- 若要安装包，手动运行 `npm run tauri build`

## 工具栏

顶部工具栏提供以下操作：

- **打开皮肤**
  - 选择一个皮肤文件夹
  - 自动加载里面的图片与 skin.ini 内容
- **新建**
  - 在指定父目录下创建新的皮肤文件夹
  - 自动生成一份 skin.ini 模板
- **保存**
  - 将当前修改写回 skin.ini 文件
  - 保留原编码，中文不乱码；采用原子写入
- **文件夹**
  - 在文件资源管理器中打开当前皮肤文件夹的根目录
- **打开 skin.ini**
  - 用系统默认编辑器打开当前皮肤的 skin.ini 文件
- **设置**
  - 打开设置弹窗（含浅色/深色主题切换）
- **路径卡片**
  - 显示当前皮肤文件夹路径（悬浮可看完整路径）

## 设置弹窗

设置弹窗底部提供 **确认 / 取消** 按钮；点击弹窗外部也等同于取消（恢复为打开前的设置）。

- **主题**
  - 浅色 / 深色切换，即时生效
- **编辑方式**
  - 决定点击"浏览"选择素材后的处理方式
  - **直接导入路径**（原方式）：把素材在皮肤内的相对路径写入 skin.ini
  - **复制到文件夹**：把素材复制到皮肤根目录下的目标文件夹，再写入"文件夹名/文件名"相对路径；文件已在目标位置时跳过复制，同名冲突时询问是否覆盖
- **导入素材**
  - 添加/替换组件时对 @2x 的默认处理
  - 可选：@2x / 原图 / 每次自行确认
- **游玩预览：缺失的组件显示默认组件**
  - 开启后，缺失组件在预览中用占位样式显示
- **点击预览中的组件联动选中元素管理中的对应元素**
  - 开启后，在预览画面直接点击组件即可选中，右侧元素树同步定位
- **显示选中组件的高亮框**
  - 开启后，被点击选中的组件周围显示一个高亮虚线框
  - 可自定义高亮框的颜色（取色器）
- **元素管理按当前预览界面分类显示**
  - 开启时：只显示当前预览界面（游玩/暂停/失败/结算/选歌）对应的元素
  - 关闭时：显示全部元素（保持树状分组），任意界面都可见
- **UI 大小**
  - 整体界面缩放滑条（0.7 ~ 1.5），实时预览
  - 弹窗与 toast 会反向抵消，任意大小下都完整留在视口内可操作
- 弹窗支持缩放，内容超出时出现滚动条

## 记忆功能

程序把以下内容记录到 **`settings/`** 文件夹下的 `settings.json`（exe 版记录在 exe 同目录），下次启动自动恢复：

- **上次编辑的皮肤文件夹**
  - 打开 / 新建皮肤时记录，下次启动自动打开
- **界面设置**
  - 主题、编辑方式、导入 @2x 策略
  - 缺失组件默认显示开关、点击选中预览组件开关、"按当前预览界面分类显示"开关
- **窗口状态**
  - 窗口大小 / 位置 / 最大化状态
  - 主窗口、元素面板的分隔条比例
- **元素管理分类树状态**
  - 各分类栏的展开 / 收缩状态
  - 切换界面、导入/替换组件、重启后都会保持
- **预览状态**
  - 最后一次的界面、显示开关（背景图/连击图/警告箭头/跳过按钮）
  - 画幅比例、自定义分数/acc/连击/中间评分

> 窗口状态由 **Rust 侧（window\_state.rs，tao window API）** 保存/恢复，前端不处理窗口状态。

## 素材文件编码与保存安全

- **编码检测**
  - 打开皮肤时自动检测 skin.ini 的编码（UTF-8 / UTF-8 BOM / GBK）
  - 保存时按原编码写回，中文不会变乱码
- **原子写入**
  - 保存采用原子写入（先写临时文件再替换）
  - 即使保存失败，原 skin.ini 也不会被清空或损坏
- **非 Web 格式转码**
  - 素材图若为 TIFF 等非 Web 格式（伪装成 .png）
  - 后端会转码为 PNG 再返回前端，避免渲染黑图

***

## 左侧：游玩预览

### 控制栏

- **界面**
  - 下拉选择预览的界面：游玩 / 暂停 / 失败 / 成绩结算 / 选歌
- **比例**
  - 16:9 / 16:10 切换
- **显示**
  - 弹出小窗，勾选：背景图（menu-background）、连击图（comboburst）、警告箭头（mania-warningarrow）、跳过按钮（play-skip）
- **数值**
  - 自定义分数、准确度、连击数
  - 中间评分下拉：300g / 300 / 200 / 100 / 50 / miss
- **刷新**
  - 手动刷新预览（重新读取素材清单与 skin.ini）

### 预览内容

预览基于 skin.ini 的 `[Mania]` 区块实时渲染，图层顺序与官方 mania 一致：

- 列底、列分隔线、判定线
- 舞台灯光、左右边框、底部装饰
- 接收器（按键）、音符、长条（LN）
- 灯光命中特效、连击图、跳过按钮
- HUD：分数 / acc / 连击 / 判定评分、血条

修改右侧 skin.ini 编辑器的任何字段，预览会**实时刷新**。

### 点击选中预览组件

- 开启"点击选中游玩预览组件"后：
  - **单击**：选中最上层组件
  - **双击**：逐层向下、循环回顶层
  - 高亮虚线框指示当前选中的那一层
- 暂停界面下点击，联动界面保持不动

## 右侧：元素管理

### 筛选按钮

提供四个筛选视图：**全部 / 缺失 / @2x / 动画**

### 状态颜色

- **绿色**：存在（根目录）
- **黄绿色**：存在（skin.ini，仅由 skin.ini 指定路径）
- **红色**：缺失
- **加粗 / 高亮**：含动画帧（并标注帧数）

### 双击元素

- 双击**存在**元素 → 在文件夹中定位该文件
- 双击**缺失**元素 → 跳转到 skin.ini 对应字段
- 组件所在分类栏被收起时，会自动展开并定位该组件

### 预览交互

- 滚轮缩放（以鼠标为指针，5%~2000%）
- 左键拖动平移
- 选中自动适配居中
- 多帧元素可 **播放动画**（60fps 轮换）

### 素材操作

| 元素状态 | 按钮 | 功能 |
| ---- | ---- | ---------------------- |
| 缺失 | 添加素材 | 选图复制到根目录并按元素名命名，可 @2x |
| 存在 | 删除素材 | 确认后删除所有相关文件（含 @2x、动画帧） |
| 存在 | 替换素材 | 复制新文件、删除旧文件并按元素名命名 |
| 多帧动画 | 播放动画 | 循环播放各帧 |

## 右侧：skin.ini 编辑

- **子标签**：General / Colours / Fonts / Mania
- **Mania** 额外有 **键数选择**（1\~18K）
- 每个子标签顶部都有 **重置所有** 与 **重新扫描 skin.ini** 两个按钮：

| 按钮 | 语义 |
| ---- | ---- |
| **↺ / 重置所有** | 撤销本次编辑，复原到修改前/已保存的值（undo） |
| **重新扫描 skin.ini** | 从磁盘重读，覆盖当前编辑（reload，避免手动改了文件程序认不出） |

### 字段操作

- **直接修改**：改动实时生效，预览即时刷新
- **图片路径字段**：带 **浏览** 按钮，可选择/复制素材
- **颜色字段**：带 **色板 + 取色器**
  - 点击色板直接打开取色界面
  - rgb / rgba 处理方式一致
- **rgba 字段**：
  - 棋盘格底 + 半透明色层可视化 alpha
  - 带有 **alpha 滑条**（0\~255），拖动时实时更新，松手才提交
- **数值字段**：带 **滑块**，与文本框双向同步
- **choice 下拉字段**：存纯枚举值（如 0/1/2）

### 数字前缀匹配规则

数字前缀字段（ScorePrefix / ComboPrefix / HitCirclePrefix）按 **路径 + 文件名** 规则匹配：

- 字段**不存在** → 用官方默认前缀
- 字段**存在但留空** → 该数字不读取、预览留空
- 字段**有值**（如 `combo` 或 `combo/combo`）→ 按相对路径精确查找，不在整皮肤模糊搜索

> **留空保存语义**：字段清空后保存，会在 skin.ini 中**删除该行**（而非写空值行）。这样 text 字段正确清空，同时避免 osu! 对非文本字段空值行报 `Value is empty`。

***

## 注意事项（相对于原版的变化）

- **坐标系统**：预览基于 **x480**（游戏区域高度 480 单位），`X()`/`Y()` 做坐标变换
- **HUD 换算**：HUD 元素在官方 x768 基准中显示，预览中 **÷1.6** 换算
- **横向处理**：左右舞台垂直拉伸、底部不拉伸
- **@2x 缩放**：@2x 素材缩放到 1x 逻辑尺寸（**整数整除** `Math.floor(w/2)`）
- **读取优先级**：与 osu! 官方一致 —— skin.ini 指定路径（@2x → 原版）→ 默认文件名（@2x → 原版）
- **键数重置**：仅"打开皮肤"时重置为 4K（对齐原版行为）；"重新扫描 skin.ini"保留当前键数
- **组件扫描**：只扫皮肤根目录 + skin.ini 指定文件，不递归子目录、不因同名子目录文件产生误判
- **存在状态三态**：**存在**（根目录）/ **存在(skin.ini)**（仅由 skin.ini 指定）/ **缺失**
- **动画**：多帧动画默认显示第一帧
- **长条样式**：0=拉伸 / 1=从顶 / 2=从底
- **免责声明**：预览里的坐标、尺寸、图层顺序尽量贴近官方规范，但**预览 ≠ 实机**

***

# 项目结构

## 文件总览

```
e:\trae\osuskin_s\
├── package.json             npm 脚本（tauri / dev:server）+ CLI 依赖
├── package-lock.json
├── dev-server.mjs           极简静态服务器（端口 5173），供 Tauri dev 用，无打包器
├── build_exe.bat / .ps1     一键打包脚本（--no-bundle，只出 exe）
├── src/                     前端（原生 JS/CSS/HTML）
│   ├── index.html           页面骨架（工具栏 / 预览 / 面板 / 弹窗）
│   ├── css/style.css        全部样式（含 glassmorphism 主题、toast、色板、滑条）
│   └── js/
│       ├── app.js           入口：初始化、工具栏、标签切换、主题、事件接线
│       ├── api.js           Tauri invoke / convertFileSrc 封装
│       ├── state.js         全局状态 + 事件总线 + 设置持久化 + 皮肤加载/重扫
│       ├── components.js    通用 UI 组件（toast、对话框、可拖分割条、取色器）
│       ├── manager.js       皮肤文件扫描（存在判定、@2x、根目录+ini 索引）
│       ├── skin_ini.js      skin.ini 解析 / 序列化 + 命令 schema
│       ├── catalog.js       元素目录（分类、界面归属、数字/判定配置）
│       ├── preview.js       游玩预览渲染（坐标变换、HUD、图层、点击选中）
│       ├── ini_tab.js       skin.ini 编辑页（表单引擎、色板、滑条、重置/重扫、素材浏览）
│       ├── panel.js         元素管理面板（树、筛选、预览缩放、增删替换、动画）
│       └── utilities.js     通用纯函数（颜色/数值解析等）
└── src-tauri/               Rust 后端
    ├── Cargo.toml           依赖：tauri v2、dialog 插件、image（PNG/TIFF 转码）
    ├── tauri.conf.json      WebView 配置（assetProtocol 允许预览读皮肤图）
    └── src/
        ├── main.rs / lib.rs 入口 + 命令注册
        ├── commands.rs      后端命令（文件 IO / 编码 / 原子写 / 打开资源管理器）
        └── window_state.rs  窗口状态保存/恢复（tao window API）
```

另有不入版本库（.gitignore）的目录：`settings/`、`temp/`、`src-tauri/target/`、`src-tauri/gen/`、`node_modules/`、`OsuSkinMaker/`（旧版源码备份）。

## 依赖关系

```
src/js/app.js ──► state.js   components.js   panel.js   ini_tab.js   preview.js
                   │            │              │            │            │
                   ├──► api.js（invoke / convertFileSrc）                 │
                   ├──► manager.js ──► (文件存在判定)                       │
                   ├──► skin_ini.js ──► catalog.js (schema)               │
                   └──────────────────────────────────────────────────────┘
                              │  invoke
                              ▼
src-tauri/src/commands.rs（list_images / read_text / write_text_atomic / copy_file /
                        delete_file / create_folder / open_in_explorer / open_with_default_app /
                        pick_folder / pick_files / read_file_bytes / path_exists / load_settings / save_settings）
```

- `api.js` 是前后端唯一边界：所有 `invoke` 走这里
- `state.js` 是事件中枢（`on` / `emit`），皮肤加载、重扫、状态持久化集中在这
- `preview.js`、`panel.js`、`ini_tab.js` 通过事件总线联动、互不直接持有对方实例

## 前端模块说明

| 模块 | 职责 |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `api.js` | 封装 `invoke`（调用后端）与 `convertFileSrc`（皮肤图走 `tauri://` 协议）；非 Tauri 环境降级 |
| `state.js` | 全局 `state`、事件总线、`loadSettings/persistSettings`、`openSkinFolder`、`loadIni`、`rescanSkin`、`createNewSkin` |
| `skin_ini.js` | `SkinIni.parse/serialize`、`Entry/Section/SkinIni` 数据模型、命令 schema（General/Colours/Fonts/Mania 各段命令列表） |
| `catalog.js` | 元素目录：模式分组 → 功能分类，元素的中文名、建议尺寸、混合模式、界面归属；数字前缀默认值 |
| `manager.js` | `SkinManager` 索引图片（根目录 + skin.ini 指定），`hasBase/status/pathForStem` 做存在判定与 @2x 优先 |
| `preview.js` | 游玩/暂停/失败界面渲染：坐标 `X()/Y()`、图层顺序、HUD、血条、点击选中、倒置 |
| `ini_tab.js` | 表单引擎：按 schema 渲染字段（文本/图片浏览/数值滑块/rgb(a)色板+alpha滑条/下拉）；重置、重置所有、重新扫描；素材浏览复制 |
| `panel.js` | 元素树（分组展示、三态徽章）、筛选、预览缩放平移、增删替换、多帧动画播放 |
| `components.js` | toast、confirm/prompt 对话框、可拖分割条、取色器等复用件 |
| `utilities.js` | 通用纯函数（如颜色解析） |

## 后端命令说明

`src-tauri/src/commands.rs`（Rust）：

| 命令 | 说明 |
| --------------------------------------------- | ---------------------------- |
| `list_images` | 列出皮肤目录图片，建立索引 |
| `read_text` | 按编码读取文本（含编码检测） |
| `read_file_bytes` | 读取文件原始字节（大图/素材用 Blob） |
| `write_text_atomic` | 原子写入文本（临时文件 + 替换） |
| `copy_file` / `delete_file` / `create_folder` | 文件/目录操作 |
| `path_exists` | 判断路径是否存在（复制时覆盖判定用） |
| `open_in_explorer` | 资源管理器打开/选中（Windows explorer） |
| `open_with_default_app` | 系统默认程序打开文件 |
| `pick_folder` / `pick_files` | 对话框选择文件夹/文件 |
| `load_settings` / `save_settings` | 设置持久化 |

> 新增后端命令时，需同时在前端 `api.js` 提供封装，保持两端一一对应。

## 辅助文件说明

- **dev-server.mjs**
  - Tauri dev 用的极简静态文件服务器（端口 5173）
  - 只服务 `src/` 目录，无任何打包器、无前端框架，前端即为原生 JS/CSS/HTML
- **build\_exe.bat / build\_exe.ps1**
  - 一键打包脚本
  - 自动补 PATH、`npm install`、`tauri build --no-bundle`、复制 exe 到 `temp\`
- **Cargo.toml**
  - `protocol-asset` 特性启用 `tauri://` 皮肤图访问
  - `image` crate（png/tiff）做非 Web 素材转码

***

## 如何添加新功能

### 添加新的 skin.ini 字段

1. 在 `skin_ini.js` 对应段的命令列表加一条 `Command(...)`
2. `ini_tab.js` 的表单引擎会自动渲染对应控件
3. 字段若影响预览，再到 `preview.js` 处理

### 修改预览绘制逻辑

改 `preview.js` 的渲染方法；坐标变换由其中的 `X()`/`Y()` 与 `scale` 控制。

### 修改素材读取优先级

`preview.js` 的路径解析（skin.ini 指定路径优先）+ `manager.js` 的 `pathForStem` / 存在判定。

### 修改元素目录

编辑 `catalog.js` 的分组/元素定义。

### 修改编码处理

`commands.rs` 的 `read_text` / `write_text_atomic`；规则：保存必须原子写入，否则编码失败会清空原文件。

### 修改窗口状态

`window_state.rs`（Rust 侧，tao window API），前端不处理窗口状态。

***

# 悄悄话

2026.9 由 Python/tkinter 版迁移到 Tauri v2 + WebView2 的重写版。

- 仍是「一个很糙的 AI 生成的小玩意」，优化可能不是很好，还有一堆神秘 bug
- 只做了 mania 相关的 skin.ini 编辑与游玩预览；对其他模式不太了解
- 选歌界面/成绩结算预览的摆放较难，尚未完善
- 如发现问题或有什么建议，欢迎提出，非常感谢