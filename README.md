# 音乐bot · 每日推荐

音乐bot 是一个纯静态的中文网页：先选喜欢的流派、歌手和歌曲（也可以读取 Apple Music Replay 2026），之后每天推荐约 10 首歌。

每首歌都可以：
- 试听 30 秒
- 喜欢或不喜欢
- 打 1–5 星
- 「不想听这位歌手」：之后不再推荐这位歌手，可随时撤销（提示里的「撤销」，或在「口味」页移除）。合作曲（如 `21 Savage, Offset & Metro Boomin`）会弹出小菜单，按歌手单独选择

搜歌时如果美区 Apple Music 没有原唱版本，结果上方会提示，翻唱或同名歌曲会标「非原唱 / 同名」，每一行都显示歌手名。
- 直接在 Apple Music（美国区，music.apple.com/us/…）打开

不使用 Spotify，也不需要本地音乐文件。界面是简约的古典黑胶风格：唱片随试听旋转，切歌时有唱片接力动画，还有统计条和动态时间线。系统开启「减少动态效果」时，所有动画都会关闭。

## 文件与分工

| 文件 | 负责方 | 说明 |
|---|---|---|
| `recommender.js` | 算法 bot | 推荐引擎 `window.MusicRec`；种子、反馈、历史等数据都存在这里 |
| `storage.js` | 算法 bot | 账号存储 `window.YYBStorage`：把 `yinyuebot.v1` 同步到 Supabase 表 `user_state` |
| `supabase/schema.sql` | 算法 bot | 建表和行级安全策略，在 Supabase SQL 编辑器里运行一次（不打包） |
| `index.html` / `style.css` / `ui.js` | 前端 bot | 页面和交互，只调用 `window.MusicRec` / `window.YYBStorage` |
| `config.js` | 前端 bot | Supabase 项目地址和 anon key（公开值）；留空则账号功能关闭 |
| `API_CONTRACT.md` | 双方 | 接口约定 |
| `app.js` | 早期原型 | 旧版独立实现，页面不再加载 |
| `replay-2026.json`、`taste-profile.json/.md` | 数据 | Apple Music Replay 2026 歌单和口味画像 |
| `raw-us.json`、`page-*.html` | 数据 | 抓取的原始数据 |
| `recs-2026-11-01.json` | 早期产物 | 早期生成的一份样例推荐，链接还是旧的 `/cn/` 中国区地址，已过时；网页不读取它，只是留作参考，不要删除 |
| `*.bak-*`、`screenshot-*.png` | — | 旧文件备份和测试截图 |
| `qa/` | 测试 | 冒烟测试脚本和测试用例文件（见下方「测试」） |
| `build.sh` → `dist/music-recs.zip` | 打包 | 只打包运行需要的文件（见下方「打包与部署」） |

## 本地打开

```bash
cd /workspace/music-recs && python3 -m http.server 8765
```

然后在浏览器打开 http://localhost:8765 。

- `http://localhost:8765/?mock=1`：用模拟数据测试界面，不联网，也不影响真实数据。
- 请通过 http 打开，不要用 `file://`。

## 测试（冒烟测试）

```bash
cd /workspace/music-recs && ./qa/smoke.sh            # 默认端口 8797
PORT=8800 ./qa/smoke.sh                               # 换端口
KEEP_OUT=1 ./qa/smoke.sh                              # 保留日志和截图（路径会打印出来）
```

- 脚本会在项目根目录用 `python3 -m http.server $PORT` 起一个临时服务，跑完自动关闭（trap）。
- 依次运行：`qa/node4.js`（引擎，Node 内存存储）、`qa/unit-ui.js`（界面里的歌手拆分）、`qa/mock.js`（`?mock=1` 界面）、`qa/acct.js`（账号：注册 / 登录 / 退出、导入、多账号隔离、恢复登录、未配置和 CDN 失败）、`qa/run4.js`（真实引擎完整流程，需要联网，约 2–3 分钟）。
- 结尾会打印实际的检查数：`[smoke] checks: 总数 total, 通过 passed, 失败 failed`。检查数会随用例增减，以脚本输出为准。
- 测试**不会访问真实的 Supabase 项目，也不会注册任何真实账号**：`qa/net-guard.js` 拦截所有 `*.supabase.co` 和 supabase-js CDN 请求，并改写 `config.js`；账号测试用 `qa/fx/fake-supabase.js` 假装 Supabase（登录和 `user_state` 表都放在临时浏览器里），`storage.js` 和 `recommender.js` 用的是真文件。上线后的真实验收由 监工 负责。
- 引擎改了 `KEEP_WHOLE` 后运行 `node qa/sync-keep.js`，把 ui.js 里的备用歌手拆分同步过来。
- 浏览器测试每次都用**全新的临时 Chrome 用户目录**，不会读写你真实浏览器里的 localStorage，也不会动你今天已经生成的推荐。
- 任一检查失败时退出码非 0；`[check] FAIL(engine)` 表示问题在推荐引擎一侧。
- 需要 Node 18+ 和 Chrome（`CHROME=/path/to/chrome` 可改路径）；第一次运行会在 `qa/` 里安装 `puppeteer-core`。
- 环境变量：`PORT`、`CHROME`、`SF`（期望的商店地区，默认 `us`）、`KEEP_OUT`。

## 打包与部署

```bash
./build.sh      # 生成 dist/music-recs.zip 并列出内容
```

压缩包只含运行需要的文件：`index.html`、`style.css`、`config.js`、`ui.js`、`recommender.js`、`storage.js`、`taste-descriptors.json`（引擎读取）、`replay-2026.json`（「读取 Replay」按钮）、`seed-profile-2026.json`（`applySeedProfile` 默认文件）和本 README。不含 `app.js`、`supabase/`、`page-*.html`、`raw-*.json`、备份、截图、`qa/`、`dist/`。

以下是手动步骤，脚本不会替你发布任何东西：

**账号（Supabase，部署前做一次）**
1. 在 Supabase 项目的 SQL Editor 里粘贴并运行 `supabase/schema.sql`（可重复运行），会建好 `public.user_state` 表和「每人只能读写自己那一行」的策略。
2. 填 `config.js`：`SUPABASE_URL` 和 `SUPABASE_ANON_KEY`（Project Settings → API；anon key 是公开的，可以放前端；**不要**放 service_role key）。两项都留空时账号功能关闭，网站以纯游客模式运行。
3. Authentication → URL Configuration：Site URL 填 `https://jiahaofu-music.github.io/music-bot/`，Redirect URLs 也加上 `https://jiahaofu-music.github.io/music-bot/`。
4. Authentication → Providers → Email：保持开启。「Confirm email」目前是关闭的，所以注册成功就直接登录；如果以后打开它，注册后会提示「注册成功，请登录」，用户要先点邮件里的链接再登录。
5. 网页会从 jsDelivr 加载 supabase-js v2；这个 CDN 或 `*.supabase.co` 被屏蔽时只影响登录，游客模式照常可用。

**GitHub Pages**
1. 新建一个仓库（可以设为私有，但 Pages 免费版需要公开仓库）。
2. 解压 `dist/music-recs.zip`，把里面的文件放到仓库根目录，提交并推送到 `main`。
3. 仓库 Settings → Pages → Build and deployment：Source 选「Deploy from a branch」，Branch 选 `main` / `/ (root)`，保存。
4. 一两分钟后访问 `https://<用户名>.github.io/<仓库名>/`。

**Netlify**
1. 登录 https://app.netlify.com ，进入 Sites → 「Add new site」→「Deploy manually」。
2. 把解压后的文件夹（不是 zip 本身）拖进上传区域。
3. 部署完成后会得到 `https://<随机名>.netlify.app`，可在 Site settings 里改名或绑定域名。
4. 以后更新：重新运行 `./build.sh`，在该站点的 Deploys 页再拖一次文件夹。

两种方式都是纯静态托管，不需要构建命令或自己的后端（账号数据存在 Supabase）。游客数据只保存在访问者自己的浏览器里，换了网址（域名）就是一份新的 localStorage，可先在旧地址「导出 JSON」，再到新地址「导入」。

### 托管注意

- 推荐和搜索请求由浏览器直接发往 `itunes.apple.com`、`api.deezer.com`（JSONP）和 `musicbrainz.org`，不需要后端，也不需要 API Key。
- iTunes 接口有限流（约 20 次/分钟），第一次生成大约需要十几秒，之后有缓存。
- 网络环境如果屏蔽了这些域名，推荐会失败。

## 数据

- 游客（未登录）的数据保存在当前浏览器的 localStorage 里，由推荐引擎 MusicRec 统一管理：
  - `yinyuebot.v1`：种子、评分、历史、设置
  - `yinyuebot.reccache.v1`：请求缓存
- 登录后，数据存在 Supabase 的 `user_state` 表（每个账号一行，换设备也能用），本机另有缓存 `yinyuebot.u.<用户id>.v1`；修改约 0.8 秒后自动上传，账号弹窗里显示「保存中… / 已保存 / 同步失败」（失败会自动重试）。游客数据和各账号互不影响；退出登录后回到本机游客数据。
- 第一次在这台设备登录一个空账号、而本机游客有数据时，会问「把本机访客数据导入这个账号吗？」；选不导入就从空账号开始。游客数据两种情况下都保留。
- 界面只用 `yinyuebot.ui.v1` 记住当前标签页、屏蔽歌手时用到的 id，以及哪些账号已经问过导入。
- 「设置 → 导出 JSON」：导出 `MusicRec.exportData()` 返回的完整引擎 JSON。
- 「导入 JSON」：用 `MusicRec.importData()` 恢复。导入前会提示「将替换现有 N 条反馈、M 天历史，确定导入？」。也能导入旧版界面导出的文件；文件格式不对时会提示错误，原来的数据逐字节保持不变。
- 「清空全部」：只清当前数据——登录时只清这个账号（并上传），未登录时只清本机游客数据。确认后调用引擎的 `reset()`，并清掉界面设置 `yinyuebot.ui.v1`（保留「已问过导入」的记录），然后刷新页面。
- 「导出 / 导入 JSON」作用于当前数据（登录时是账号数据）。
