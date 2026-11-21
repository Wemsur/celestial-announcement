# Celestial 公告源码与发布器

这里是 **GitHub 编辑源**，不是启动器直接读取的分发分支。通过 GitHub Issue 发布 Markdown 公告，GitHub Actions 自动生成索引和正文，再同步到 wemgit。

| 位置 | 职责 |
| --- | --- |
| GitHub `Wemsur/celestial-announcement` 的 `main` | Issue 表单、发布器、工作流、说明与测试源码 |
| GitHub 的 `published` | 自动生成的索引、正文、接受修订状态 |
| wemgit `celestial/celestial-announcement` 的 `main` | 与 GitHub published 同一发布历史，供启动器匿名读取 |
| 本地 `origin` | GitHub 源仓库 |
| 本地 `wemgit` | wemgit 分发仓库 |

**不要手工编辑生成分支，不要强推，也不要在 wemgit 单独制造一套历史。** 本次代码交付不等于已经上线；真实凭据、初次推送及线上验收由维护者完成。

## 首次上线

1. 准备同步到 wemgit 时，在 GitHub 公告源仓库配置 Actions Secrets；如果手动取消同步、仅发布 GitHub，可以暂不配置以下 wemgit 凭据：
   - `WEMGIT_USERNAME`：实际拥有 wemgit 公告仓库写权限的账号，不一定等于仓库命名空间 `celestial`。
   - `WEMGIT_TOKEN`：该账号的最小写入凭据。若服务不支持限定单仓，使用只对本公告仓库有写权限的专用账号。
   - 不需要另建 GitHub PAT，工作流使用自动提供的 `GITHUB_TOKEN`。
2. 允许仓库执行 GitHub 托管 Actions，并确保工作流可以写入 `published` 分支。不要绕过分支保护；若保护规则阻止机器人写入，应明确配置必要权限。
3. 本地会准备源码 `main` 与空的 `published` 初始分支。进入本公告源码仓库后一起上传，避免初始化发生两套不同历史：

```bash
git push --atomic -u origin main published
```

4. 在 GitHub 创建表单使用的 `announcement` 标签。以下命令会修改线上仓库，需由维护者主动执行：

```bash
gh label create announcement --repo Wemsur/celestial-announcement --color 7371FC --description "Celestial Launcher 公告"
```

5. 手动运行“发布 Celestial 公告”，默认勾选“同步到 wemgit”，把空索引同步到 wemgit。维护期间可取消勾选，只发布 GitHub；此步骤不会发布演示内容。
6. 确认以下地址匿名返回 JSON，而不是登录页面、仓库网页或错误页：

`https://download.celestial.byside.top/celestial/celestial-announcement/raw/branch/main/index.json`

以后正常维护只推送源码 `main`；发布分支交给机器人更新。若 Actions 抢先创建了远端 published，先获取并使用其历史，不要强推本地旧分支。

## 手动运行时选择是否同步

“发布 Celestial 公告”和“核对 Celestial 公告”的 Run workflow 弹窗都有“同步到 wemgit”勾选框，默认勾选。

- 勾选：发布到 GitHub published 后，继续同步到 wemgit main，需要 wemgit 两个 Secrets。
- 取消：只发布 GitHub，不连接 wemgit，也不要求/注入 wemgit 凭据；日志会明确说已跳过同步。维护完成后勾选并重跑即可补同步同一历史，不必重新发 Issue。
- 选择只影响本次手动运行。Issue 自动触发和定时核对仍默认同步，不会记住上一次取消选择。维护期间可在提 Issue 后手动取消同步来发布；自动运行仍可能因 wemgit 不可用而失败。
- 若未来需要自动触发也长期暂停同步，应再加仓库级控制，不通过删除 Token 或关闭 TLS/重定向检查来实现。

## 创建和编辑公告

在 https://github.com/Wemsur/celestial-announcement/issues/new/choose 选择“发布公告”。

- 标题就是公告标题。
- 等级：`info` 一般通知、`warning` 重要提醒、`critical` 紧急提醒；仅影响样式，不执行命令。
- 生效时间可留空，表示首次成功接受时立即生效。
- 到期时间必填，严格晚于生效时间。请填写秒和明确时区，如 `2026-12-01T18:00:00+08:00`。
- 正文支持 Markdown。请保留表单元数据标题，正文最后一栏可任意使用自己的 Markdown 标题。
- 需要补录已过期历史时，明确填写过去的生效时间与到期时间；不要把生效时间留空。
- 仅 GitHub 用户 `Wemsur` 的有效公告会被接受。机器人同时核对最新正文编辑者、标题变更者和关闭/重开操作者，不把作者关联标签当作权限验证。
- 标题/正文/期限编辑仍是同一公告 ID。用户选择“不再显示”后，同 ID 的编辑不会重新激活自动提示。确实需要重新提醒时新建一个公告 Issue。
- 普通 Issue、PR、评论不是公告正文。不要发布账号 Token、私钥或其他私密信息。

生效区间是 `starts_at <= 当前时间 < expires_at`。期满后自动成为历史，不需要运行机器人才能过期。所有时间输出为 UTC，启动器按自己的界面语言和本机时区显示。

## 关闭、重开与删除

- 关闭：立即结束有效展示，保留历史正文。
- 重开：重新允许有效展示，但只有未过期的公告会自动提示；原 ID 的“不再显示”记录不会被清除。
- 删除：真正撤回，移除当前分发树中的标题/正文，只保留 ID、时间和撤回状态；客户端成功获取撤回记录后删除该 ID 的正文缓存。
- Git 历史、平台缓存和离线客户端仍可能留旧内容，删除不能保证公网彻底抹除。公告不是私密通信。

事件可能有延迟或遗漏。独立兜底工作流约每 15 分钟核对一次，也可手动运行发布工作流；网络、权限错误和不完整分页不会被当作删除。

## Markdown 图片与链接

- 支持普通 HTTPS 图片，遵循启动器已有过滤和图片代理策略。
- GitHub Issue 拖入图片生成的绝对附件链接可以直接使用，不自动转存全部附件。
- 自有相对图片放在源码 `main` 的 `assets/` 目录。相对图片解析到 GitHub Raw main；相对文档解析到 GitHub 仓库 main 文件页面，不解析到启动器本地路径。
- 原始 HTML、脚本、iframe 与内部/file/javascript/data协议不执行。外链通过系统浏览器打开，不导航启动器主页面。
- 正文下载限额与浏览器图片加载不是同一边界，不声称所有图片都经过后端字节限额下载。

## 生成格式

索引协议为 `schema_version: 1`；包含递增 generation、生成时间和完整公告/历史列表。每条正常记录有稳定 ID、标题、等级、发布时间、生效/到期时间、状态、正文相对路径和 SHA256。

ID 是 `github-<GitHub Issue 数据库 ID>`，不是页面上的 Issue 编号。正文为 UTF-8 纯 Markdown，无 YAML 头，路径为：

`announcements/<ID>/<小写SHA256>.md`

正文按内容寻址，不在原路径覆盖。索引与正文同一次 Git 提交；摘要检测混用/损坏，不等同于独立发布者签名。旧修订文件保留直到该 ID 撤回；应用历史展示每个 ID 的最新已验证版本。

限额：正文 128 KiB，索引 1 MiB/2000 条。超过限制会报错，不能靠静默截断或删除历史继续发布。

## 启动器读取与回退

- 主来源是 wemgit main；备用来源是 `https://raw.githubusercontent.com/Wemsur/celestial-announcement/published/`，不是 GitHub 源码 main。
- 先尝试主源；网络/HTTP/数据校验失败，或索引代际低于本机已接受快照时尝试备用。主源成功时不同时查询两边比较版本，合法空索引也不触发回退。
- 正文优先从成功接受索引的来源获取，失败再试另一来源；两边都必须匹配索引的 SHA256，不能拿旧正文冒充新正文。
- wemgit 单次预算4秒，GitHub单次预算15秒；正文读取整体25秒，刷新总预算60秒，避免外层先截断备用请求。仍为后台任务，不阻塞启动。
- 两边都失败时不自动弹新公告，已验证缓存继续可手动查看。
- 回退不能代替修复发布同步：如果 wemgit 返回合法但尚未同步的新旧差异，本机还不知道更高代际时不会主动比对 GitHub。发布器 Git push 的301需要根据 Location确认正确地址或受控跳转，不应关闭TLS校验或随意放开所有重定向。

## 失败与恢复

- 格式错误不会把旧公告换成坏内容；错误会在 Actions 日志中指明 Issue 编号。其他合法变更若已同步，会明确报告，不能把红色运行理解成“什么都没发生”。
- 只有完整且经操作者核对的 GitHub 数据才会更新；查询期间发生修订竞争时拒绝混用，重新运行即可。
- GitHub published 成功而 wemgit 同步失败，生成产物仍保留。修复凭据/网络后重跑，会重试同一产物。
- wemgit 有独立提交导致非快进：不要强推。先确认两端历史并由维护者妥善整合。
- 调度可能延迟，长时间无活动的公开仓库定时工作流可能被 GitHub 暂停。Issue 事件发布与兜底定时核对分开，仍应检查 Actions 状态；必要时手动恢复核对任务。

## 本地验证与空产物

发布器使用 Node.js 22 内建模块，没有额外 npm 运行依赖。以下命令只生成空产物，输出目录必须为空；它不获取 Issue、不访问网络、不执行 Git 推送：

```bash
node scripts/publish-announcements.mjs --bootstrap .publish-output
```

源码单元测试只使用离线样例，不发布公告。进入本源码仓库后可自行运行：

```bash
npm test
```

本次交付未运行这些命令，也未运行启动器构建或 UI。上线后请验收：可信发布/拒绝他人、期限、关闭与不再显示的区别、同 ID 编辑、历史、离线缓存、删除撤回、同步重试和原有启动器功能。
