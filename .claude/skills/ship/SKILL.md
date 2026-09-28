---
name: ship
description: 提交代码并发布到 Cloudflare。当用户说「提交代码 / 发布 / 上线 / 部署 / commit / deploy / ship / 提交并部署」时用它，把本地改动提交推到 GitHub，再 npm run deploy 发到 Cloudflare Workers。只提交不发布，或只发布不提交，也走这套流程的对应步骤。
---

# 提交代码 + 发布到 Cloudflare

这个项目的固定「上线」流程：提交到 GitHub `main`，再发布到 Cloudflare Workers
（线上 https://polysoccer.zhangsanfengzhsh.workers.dev ）。默认两步都做；用户只说
「提交」就停在第 4 步，只说「发布/部署」就跳过 1–4 直接第 5 步。

## 1. 先确认改动是绿的

发布脚本 `npm run deploy` = `tsc -b && vite build && wrangler deploy`，只挡类型错，
**不跑 lint / 测试**。所以提交前自己先跑，别把红的推上去：

```bash
npx tsc -b        # 类型
npx oxlint        # lint
npx vitest run    # 416+ 用例，全过再提交
```

任一不过：停下修好，别硬提交。修不动就如实告诉用户哪里红，别跳过验证。

## 2. 看清楚要提交什么

```bash
git status
git diff --stat
```

逐个判断，**别用 `git add -A` 一把梭**：

- 源码改动（`src/**`、`server/**`、配置、文档）→ 提交。
- **探针 / 调试产物**如 `.probe-*.json`（`probe-slots.test.ts` 会吐这种）→ **不提交**，留着 untracked。
- `.env` / `.env.*` / `.dev.vars*` → 已在 .gitignore 里，本就不该出现；真出现了绝不提交。
- 拿不准的新文件 → 先 `git diff` 看内容，或问用户，别默认带上。

用**显式路径** stage：`git add src/lib/foo.ts src/pages/bar.tsx …`。

## 3. 写提交信息（本仓库口径）

- **中文**，`feat: / fix: / refactor: / chore:` 前缀（对齐现有 git log）。
- 首行一句话说清「做了什么」，正文用 `-` 列要点：改了哪、为什么。
- 结尾**必须**留归属行（当前会话的署名要求）：

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

用 heredoc 提交，避免多行转义踩坑：

```bash
git commit -F - <<'EOF'
feat: 一句话标题

- 要点一
- 要点二

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

（`LF will be replaced by CRLF` 的 warning 是换行符归一化，无害，忽略。）

## 4. 推到 GitHub

```bash
git push origin main
```

本仓库一直往 `main` 走（远程 `github.com/jimidetiana/polymarket-dapp`），用户叫「提交/发布」
即视为授权推 main。**但破坏性操作**（`push --force`、`reset --hard`、删分支）仍要先问。

## 5. 发布到 Cloudflare

```bash
npm run deploy
```

看输出确认成功：末尾应有 `✨ Success!`、`Deployed polysoccer triggers`、线上 URL
和一行 `Current Version ID: …`。把这几项报给用户。

**已知 wrangler 毛刺**（见 memory `frontend-deploy-state`）：wrangler 可能擅自加 vite 插件、
建多余 Worker。发布后扫一眼输出，只该有 `polysoccer` 这一个 Worker；冒出别的名字要提醒用户。
`> 500 kB chunk` 和 `Proxy environment variables detected` 都是老告警，不影响发布。

## 6. 收尾

一段话报告：提交了哪个 commit、推没推上去、发布是否成功 + 线上 URL 和 Version ID。
哪一步跳过了或失败了，如实说，别粉饰。
