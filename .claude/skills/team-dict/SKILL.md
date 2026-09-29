---
name: team-dict
description: 补齐球队中文译名。当用户说「更新球队译名 / 补充译名 / 哪些球队没翻译 / 缺译名 / 球队名还是英文」时用它：扫当前挂盘的比赛列出没有中文译名的队名 → 译好 → 合并进 src/data/teams.zh.json。
---

# 补齐球队中文译名

词条在 `src/data/teams.zh.json`（英文队名 → 中文），查表逻辑在 `src/lib/dict.ts`。
这个技能就是：**扫出缺的 → 译 → 合并**。

## 口径：宁可不加，不可译错

词典顶部那句注释是这一节的全部理由，照做：

- 译名是**渐进增强**：查不到就显示英文，这**好过显示错的译名**。所以拿不准的一律留空。
- 键是 **Gamma 返回的原始英文名**（带 `FC` / `CF` 后缀那些），查表时会逐级剥离后缀
  （`lib/dict.ts` 的 `normalizeTeamKey`），所以「Everton FC」和「Everton」只需一条 ——
  别为同一支球队加变体。脚本已经按归一化查过一遍，它报出来的都是真没有的。
- 用**大陆通行译名**（央视 / 懂球帝 / 中文维基口径）：`Wolverhampton Wanderers` → 狼队、
  `Borussia Mönchengladbach` → 门兴格拉德巴赫、`Internazionale` → 国际米兰、
  `Tottenham Hotspur` → 托特纳姆热刺。别加「队」后缀除非常用（狼队、汉堡这类是特例）。
- **同名不同队要看清**：`Barcelona SC` 是厄瓜多尔那支，不是巴塞罗那；`Manchester City`
  和 `Manchester United` 不能混。脚本会给出该队出现的联赛代码，拿不准就按它判断，
  仍不确定就留空。
- **只动球队**。联赛名在 `src/data/leagues.zh.json`，是另一套词典，用户没要求时别碰。

## 1. 扫出缺译名

```bash
node scripts/dict/missing-teams.mjs --json tmp/missing.json
```

它按 app 同一个时间窗（北京时区今天+明天）和同一个 soccer tag 口径拉 Gamma 赛事，
逐队名查词典，列出缺译名的（带出现场次和联赛代码），并写一份待填骨架
`{"Team Name": ""}` 到 `tmp/missing.json`。

- 想看更远的比赛（这周晚些时候才开的）加 `--days 7`。
- 连不上 Polymarket 会明确报错（某些网络要代理 / VPN），**别**把网络问题当成「没有缺译名」。
- 「缺译名」只覆盖**还能下注的比赛**。窗口外有仓位的历史比赛不在其中，这是刻意的：
  补译名先补用户会看到的。

## 2. 翻译（你自己译）

球队译名是常识性知识，**直接用你自己的知识填，不要装翻译库、不要调翻译 API、不要上网查**。

- 填进 `tmp/missing.json` 的值，只填有把握的；没把握的**留空**（脚本会跳过空值并报出来）。
- 一个名字一行，别顺手加别的键、别改键名（键就是 Gamma 的原始英文名，改了对不上）。

## 3. 合并进词典

```bash
node scripts/dict/missing-teams.mjs --merge tmp/missing.json
```

它把填好的词条**追加成文件末尾一段**（带 `_added_<日期>` 标记，按英文名排序），
不动已有内容 —— 所以 git diff 永远是末尾一块纯新增，而不是散在几千行里的插入。
合并前会跳过：空值、已有译名（含归一化命中的）、与英文相同的、没译成中文或疑似乱码的
（批量导入那次踩过 mojibake）。写完先 `JSON.parse` 自检条数，对不上就不落盘。

## 4. 验证

```bash
npx vitest run src/lib/dict.test.ts          # 词典与查表口径的测试
git diff --stat src/data/teams.zh.json       # 应该只多出末尾那一段
node scripts/dict/missing-teams.mjs          # 再扫一次：应只剩你故意留空的
```

再扫一次是真的验证：报 0 说明这一批都进词典且查得到了。若还报同样的名字，
说明合并时被跳过了 —— 看 `--merge` 那步的输出，别跳过这条检查。

## 5. 收尾

报告三件事：加了几条（列出）、哪些**没加**以及原因（没把握留空 / 已有 / 乱码）、
还剩几个缺译名（如果还有）。然后：

- **不提交、不部署**，除非用户说提交 —— 提交和上线是 `/ship` 的事。
- `tmp/missing.json` 是草稿，已被 `.gitignore` 忽略，别 stage 它。
- 用户如果问「怎么还没变」，先确认他刷新了页面（词典是随构建打进包的，改完要重新构建 /
  部署才生效；本地 `npm run dev` 热更新即可）。
