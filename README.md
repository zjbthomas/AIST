# 明日方舟集成战略记录器

一个本地优先、无需账号和后端服务器的《明日方舟》集成战略时间轴记录与统计工具。

项目使用 React、TypeScript 和 Vite。运行记录默认保存在用户自己的浏览器中，也可以导出为 JSON，在其他浏览器或设备中重新导入。

## 功能

### 单局记录

- 选择集成战略主题和分队
- 按楼层添加、删除关卡节点
- 从 PRTS 数据中搜索和添加干员
- 记录普通招募或临时招募
- 记录干员精英化一、精英化二状态
- 记录每场战斗是否上场及使用技能
- 使用干员头像、精英化图标和技能图标显示状态
- 使用时间线连接招募后的连续节点
- 自动统计单局干员出场次数和技能使用次数
- 支持干员筛选和排序

### 记录管理

- 新建多个记录
- 切换、读取和删除记录
- 自动保存到 `localStorage`
- 导出全部记录为 JSON
- 从 JSON 导入记录

### 综合统计

综合统计页面可以同时分析：

- 任意多个本地记录
- 一次导入的多个 JSON 文件
- 不同集成战略主题

统计内容包括：

- 普通招募次数
- 临时招募次数
- 普通招募干员出场次数
- 临时招募干员出场次数
- 总出场次数
- 出现记录数

支持按干员名称、星级、主题、招募类型进行筛选，并按抓取次数、出场次数、出现记录数、星级或名称排序。

导入到综合统计区域的 JSON 仅用于当前分析，不会覆盖浏览器中的本地记录。

## 本地运行

需要 Node.js 20 或更新版本。

```bash
npm install
npm run dev
```

Vite 会在终端中显示本地访问地址，通常为：

```text
http://localhost:5173
```

## 构建

```bash
npm run build
npm run preview
```

构建结果位于：

```text
dist/
```


### 干员头像全部显示占位图

旧版本将头像保存为 `Special:Redirect/file` 跳转地址，浏览器可能无法直接加载。更新代码后强制重新同步：

```bash
npm run sync:prts
```

新同步器通过 MediaWiki `imageinfo` API 保存真实的 `media.prts.wiki` 图片地址，并会校验至少 90% 的干员成功获得头像。同步后请硬刷新页面；若浏览器仍使用旧数据，可在开发者工具中清除站点缓存后重试。

## PRTS 数据同步

项目通过 PRTS MediaWiki API 获取干员、头像、技能图标和集成战略关卡数据。

完整同步：

```bash
npm run sync:prts
```

只同步关卡：

```bash
npm run sync:stages
```

同步结果写入：

```text
public/data/operators.json
public/data/stages.json
public/data/manifest.json
```

同步脚本位于：

```text
scripts/sync-prts.mjs
```

`npm run dev` 和 `npm run build` 执行前也会运行数据检查。已有数据仍然较新时，脚本可以跳过重复同步。

### 同步失败排查

先检查 PRTS API 是否可以从当前网络访问：

```bash
curl -I https://prts.wiki/api.php
curl "https://prts.wiki/api.php?action=query&meta=siteinfo&format=json"
```

如关卡页面可以下载但解析失败，调试 HTML 会保存在：

```text
public/data/debug/
```

这些调试文件已被 `.gitignore` 忽略。

## 数据保存说明

应用目前没有后端数据库。每个用户的记录保存在该浏览器、该域名对应的 `localStorage` 中。

因此：

- 清理浏览器站点数据可能删除记录
- 更换浏览器或设备不会自动同步
- 建议定期导出 JSON 备份
- GitHub Pages 域名或仓库路径变化后，旧地址的数据不会自动迁移

## 无服务器公开发布

该项目适合发布为静态网页，不需要自行维护服务器。

推荐使用 GitHub Pages。项目已包含：

```text
.github/workflows/deploy-pages.yml
```

发布步骤：

1. 创建 GitHub 仓库并推送项目。
2. 打开仓库的 **Settings → Pages**。
3. 将 Source 设置为 **GitHub Actions**。
4. 推送到 `main` 分支，或手动运行部署工作流。
5. GitHub Actions 构建并发布 `dist/`。

每位使用者打开网页后，记录仍然只保存在自己的浏览器中。

## 为什么不是 Chrome Extension

当前功能不需要读取或修改其他网页，也不依赖浏览器扩展权限。因此静态网页更合适：

- Chrome、Edge、Firefox、Safari 都可以使用
- 手机浏览器也能访问
- 用户不需要安装插件
- 不需要 Chrome Web Store 审核
- 可直接使用 GitHub Pages 免费托管

以后若要从 PRTS 页面或直播页面一键导入内容，可以再单独增加一个轻量浏览器扩展，与现有网页共用 JSON 数据格式。

## 项目结构

```text
.
├── public/
│   ├── data/              # PRTS 同步结果
│   └── icons/             # 精英化和后备技能图标
├── scripts/
│   └── sync-prts.mjs      # PRTS 数据同步脚本
├── src/
│   ├── App.tsx            # 主界面和业务逻辑
│   ├── main.tsx
│   ├── styles.css
│   ├── types.ts
│   └── data/              # 内置后备数据
├── .github/workflows/     # GitHub Pages 部署
├── .gitignore
├── package.json
└── vite.config.ts
```

## 技术栈

- React
- TypeScript
- Vite
- Lucide React
- Browser `localStorage`

## 数据来源与声明

干员、技能、关卡名称和相关图片信息来自 PRTS Wiki。项目与鹰角网络、Hypergryph 和 PRTS Wiki 无官方关联。

公开发布或重新分发相关数据和图片前，请自行确认 PRTS Wiki 的许可条款以及游戏素材的版权要求。建议在应用中保留数据来源和跳转到 PRTS 的链接。

## 当前限制

- 没有云同步或多人协作
- 浏览器数据需要用户自行备份
- PRTS 页面结构变化时，同步解析器可能需要更新
- 当前仍属于早期版本，建议先用少量记录验证数据格式后再大规模录入

### 同步显示 `0/427` 个干员头像

旧同步器假设头像文件名一定是 `头像_<干员名>.png`，但 PRTS 的文件名、重定向和别名并不统一。当前版本会：

1. 使用 MediaWiki `pageimages` 查询干员页面主图；
2. 若页面没有主图，从该页面实际引用的图片文件中筛选头像；
3. 再通过 `imageinfo` 获取真实媒体 URL。

更新项目后请强制重新同步：

```bash
npm run sync:prts
```

## 分队数据

同步脚本会从每个集成战略主题页面的分队表格提取分队，并生成 `public/data/squads.json`。前端切换主题时，只显示该主题实际拥有的分队。运行：

```bash
npm run sync:prts
```

或仅刷新关卡与分队：

```bash
npm run sync:stages
```

## 技能图标同步

技能文件链接采用 PRTS 干员页实际使用的百分号编码格式解析，并按 MediaWiki 文件 MD5 路径生成 `media.prts.wiki` 地址。同步日志中的 `Skills:` 应不再为 0。机器人及部分特殊干员没有普通技能属于正常情况。
