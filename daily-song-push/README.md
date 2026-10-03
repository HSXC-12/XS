# 每日推歌（云端版）

每天中午 12:00（北京时间）在 **GitHub Actions 云端**自动运行，生成 5 首贴合你口味的歌，核验 B站官方链接后，**发送到你的邮箱**。无需本地电脑开机、无需打开 Cherry Studio。

## 工作原理

1. **DeepSeek API** 根据你的种子音乐与口味基准生成 5 首推荐（含语种风格、与种子的关联、推荐理由、AI 评分、听感、分类标签）。
2. **B站公开接口** 自动搜索每首歌，并通过 `view` 接口核验上传者——优先官方账号，**自动排除翻唱 / 剧情版 / 剪辑 / remix / 录音棚转载**等错误音源。
3. **nodemailer** 通过 QQ邮箱 / 163邮箱 SMTP 发送 HTML 邮件。
4. 每天把歌单写回 `history.json`（保留最近 30 天），用于去重和「悲壮抒情类每周最多 1 次」的约束。

## 你需要的三样东西

| 项目 | 说明 |
| --- | --- |
| GitHub 账号 | 免费，用来存放代码和跑定时任务 |
| DeepSeek API Key | 在 [platform.deepseek.com](https://platform.deepseek.com) 创建，按量计费，一次推荐约几分钱 |
| 邮箱 SMTP 授权码 | QQ邮箱或 163邮箱均可 |

## 部署步骤

### 1. 上传到 GitHub
新建一个 GitHub 仓库（建议 **Private** 私有），把本目录下的这些文件全部传上去：
```
daily-song-push/
├── .github/workflows/daily-song.yml
├── recommend.mjs
├── package.json
├── history.json
└── README.md
```

### 2. 配置 Secrets（密钥）
仓库页 → **Settings → Secrets and variables → Actions → New repository secret**，逐个添加：

| Secret 名称 | 值 |
| --- | --- |
| `DEEPSEEK_API_KEY` | 你的 DeepSeek API Key |
| `SMTP_HOST` | `smtp.qq.com` 或 `smtp.163.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | 你的邮箱地址（完整，如 `xxx@qq.com`） |
| `SMTP_PASS` | **SMTP 授权码**（不是登录密码，见下） |
| `MAIL_TO` | 接收邮件的地址（可和 `SMTP_USER` 相同） |

### 3. 获取邮箱 SMTP 授权码
- **QQ邮箱**：网页登录 → 设置 → 账户 → 开启「POP3/SMTP 服务」→ 按提示发短信 → 得到一串 16 位授权码。
- **163邮箱**：网页登录 → 设置 → POP3/SMTP/IMAP → 开启「SMTP 服务」→ 设置授权码。

> `SMTP_PASS` 填的是这个**授权码**，不是邮箱登录密码。

### 4. 启用并验证
- 新仓库默认启用 Actions；若页面提示，点一下「I understand my workflows, go ahead and enable them」。
- 在 **Actions** 页选中 `daily-song` workflow → **Run workflow** 手动跑一次，验证能否收到邮件。
- 跑通后即无需再管，每天 UTC 04:00（= 北京时间 12:00）自动执行。

## 常见问题

- **时间**：`daily-song.yml` 里 `cron: '0 4 * * *'` 是 UTC 时间，对应北京时间 12:00。要改时间就改这里（记得换算成 UTC）。
- **没收到邮件**：到 Actions 里看本次运行日志（`node recommend.mjs` 那一步的报错最直接）。多数是授权码填错、或 QQ邮箱 SMTP 需要先在网页端开启。
- **改口味 / 规则**：编辑 `recommend.mjs` 里的 `SYSTEM_PROMPT`（种子音乐、口味基准、硬性规则都在里面）。
- **GitHub 免费版限制**：定时任务偶尔会有几分钟延迟；若仓库 **60 天无任何活动**，定时任务可能被暂停，任意推一次 commit 即可恢复。
- **换模型**：DeepSeek 是 OpenAI 兼容接口，若想换成别的模型，只需改 `recommend.mjs` 里的 `api.deepseek.com` 地址和 `model` 字段。
