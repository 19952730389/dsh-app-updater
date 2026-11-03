# 发版流程

这个仓库同时是 **GitHub 插件源码** 和 **npm 包 `dsh-app-updater`**，两者版本必须一致。

## 0. 两台机器同时维护：先同步，再动手

这个仓库在两台 Mac 上维护（家里 / 本机）。**最容易出的事故是两边各自提交、历史分叉**，
尤其可怕的是「npm 先发了、GitHub 没推」——registry 里的 `gitHead` 指向一个
GitHub 上并不存在的提交，别人从 npm 追溯源码时找不到对应代码（实测踩过：
发布 1.3.14 时 `gitHead: bf1a34d` 在 GitHub API 返回 422）。

**每次开工前先 pull，收工前必推**：

```bash
# ① 开工：先对齐远端，别在分叉的历史上改
git pull --rebase origin main

# ② 干活、提交
git add -A && git commit -m "feat: ..."

# ③ 收工：推送，确认远端已有你的提交
git push origin main
git log --oneline -1 origin/main   # 必须能看到刚才那个提交
```

**发版顺序永远是：GitHub 推送 → 再 npm publish。** 反过来就会留下
「npm 有版本、GitHub 没有对应提交」的不一致。发版前用这条命令自检：

```bash
# 发布前最后一道检查：本地 HEAD 必须已在远端
git fetch origin
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" && echo "OK：可以发布" || echo "先推送！"
```

> 若两台机器改到同一处代码，`git pull --rebase` 会要求你解决冲突。
> 冲突时**不要**用 `git push --force` 覆盖另一台的提交 —— 那是别人已经发布过的工作。

---

## 1. 改版本号与更新日志

```bash
# package.json 的 version 改成新版本，例如 1.0.1
# CHANGELOG.md 顶部加一节（遵循 keep-a-changelog 的写法）
```

## 2. 本地自测

```bash
npm test                       # unit 36 项 + render 32 项
node test/harness.mjs --scan   # 宿主半身跑真实 HTTP（需要 Windows + winget）
```

## 3. 发布到 npm

npm 目前要求发布必须通过 2FA，或使用**开启 Bypass 2FA 的 Granular Access Token**：

```bash
# 方式 A：账号已开 2FA
npm publish --access public --otp=<6 位动态码>

# 方式 B：用带 Bypass 2FA 的 token（写入临时 userconfig，别写进仓库）
npm publish --access public --userconfig=<某个仓库外的 .npmrc>
```

> 注意：带 Bypass 2FA 的令牌可以做发布，但**不能**做 `npm unpublish` / 账号类操作，
> 那些仍然需要在网页上以 2FA 完成。

## 4. 打 GitHub Release（附预构建包）

```bash
npm pack --silent                       # 产出 dsh-app-updater-<version>.tgz
mv dsh-app-updater-*.tgz dsh-app-updater.tgz   # 资产名不要带版本号
gh release create v<version> dsh-app-updater.tgz \
  --title "v<version>" --notes-file <(sed -n '/^## \[<version>\]/,/^## \[/p' CHANGELOG.md)
```

资产名必须**不带版本号**：README 与各插件市场用的是
`releases/latest/download/dsh-app-updater.tgz`，`latest/download/` 只解析 `latest`，
文件名是按字面取的——一旦资产名带版本号，下一次发版这个链接就会 404。
如果确实想让文件名带版本号，就把链接改成钉住 tag 的形式（`releases/download/v1.0.0/…`）。

## 4.5 发版检查清单（照着勾）

```bash
# ① 同步与推送
git pull --rebase origin main
git fetch origin && test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" \
  && echo "✓ HEAD 已在远端" || echo "✗ 先 git push"

# ② 三套测试必须全绿
node test/unit.mjs && node test/render.mjs && node test/deny.mjs

# ③ 版本一致：package.json / CHANGELOG 顶部 / 即将打的 tag
grep '"version"' package.json
head -5 CHANGELOG.md | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+'

# ④ 发布 npm
npm publish --access public

# ⑤ 发布后核对 gitHead 指向的提交真实存在于 GitHub
curl -s https://registry.npmjs.org/dsh-app-updater/<version> \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('gitHead:',d['gitHead'])"
# 拿上面打印的 sha 去 GitHub 查，必须 200（422/404 说明没推）
```

> **别只看 npm view 就以为没发出去**：国内默认 registry 常是
> `registry.npmmirror.com`，镜像有缓存延迟，刚发布时它仍显示旧版本。
> 核对用官方源：`npm view dsh-app-updater version --registry=https://registry.npmjs.org`。

---

## 5. 市场收录怎么更新

- **dsh-plugin.org / dshopen.org / awesome-dsh-plugin**：仓库更新后它们按各自刷新周期同步，
  一般不需要重新提交；条目信息（版本、Star、更新时间）会自动跟上。
  已 closed 的收录 issue 下可以补一条版本更新评论（如 1.3.5 的准入增强），方便复核者跟进。
- **dsh.works / DSH.SO / DSH STORE / dsh-market（读 awesome 目录）/ deepseek1024 自动侧**：全部自动抓取，无需任何操作。
- **DSH Plugin Index（realoiyo.github.io）**：只抓 npm 包，`npm publish` 后下次重建即更新。
- **deepseek.club Plugin Hub：暂不上架（1.3.7 起维持原名）**。该站的插件 slug
  `dsh-app-updater` 已被另一个同名插件占用（m1452700576/dsh-app-updater，检测并更新 DSH 自身用的），
  要上架只能改名；npm 防混淆规则又拒绝同作者发相似名（`dsh-appupdater` 发不出去），
  1.3.6 曾把 GitHub 仓库改成 dsh-appupdater，**1.3.7 已改回**，一切维持原名。
  入口 https://deepseek.club/plugins/submit（tRPC `plugin.submit`，需站内账号登录；
  表单字段 name/slug/summary/description/categorySlug(tool)/currentVersion/sourceUrl/websiteUrl/installCommand/authorName/license，
  提交还会带附件上传 createPendingUploadSession/completePendingUpload）。将来若决定改名上那家，字段资料是现成的。
- 提交入口（首次收录用）：
  - dsh-plugin.org → https://github.com/dshplugin/dsh-plugin-hub/issues （模板见其 submit 页）
  - dshopen.org → https://github.com/polang233/dsh-plugin-index/issues/new?template=plugin-add.yml
  - awesome-dsh-plugin → 向仓库提 PR，新增 `data/plugins/<owner>__<repo>.yml`（见其 contributing.md）
  - deepseek1024.com（人工目录）→ PR 新增 `catalog/plugins/<owner>--<repo>.json` 一个文件
    （schema 见 `catalog/schema/plugin.schema.json`；描述 ≤1000 字符、中立措辞；
    通过 static-review 的**单一新增**条目由机器人自动 squash-merge，无人工环节）

> 版本号缺口备忘：**1.3.3 发过 GitHub Release 但没有发 npm**（registry 序列是
> 1.3.2 → 1.3.4 → 1.3.5）。npm 用户不会漏内容（直接跳版即可），这里注明是为了后来人别以为 registry 少了一版。

### 刚发版时别人可能装到旧版本

pnpm 默认有 `minimumReleaseAge`（新发布的包先观察一段时间才参与解析）。profile 里若没写
`minimumReleaseAge: 0`，`dsh plugin add <包名>` 在发版后的一段时间内可能仍解析到上一个版本：

```bash
# 立刻拿到刚发布的版本：显式指定版本号
dsh plugin --profile web add dsh-app-updater@<version>
```

这不是包的问题，是消费端的供应链策略；等宽限期过去后不带版本号也会解析到新版。
（排查时看 profile 的 `pnpm-workspace.yaml`：`minimumReleaseAge` 与 `minimumReleaseAgeExclude`。）

## 6. 本地开发时的桌面端安装

Electron 托管的 `desktop` profile 不接受 `dsh plugin` 写入。做法是在
`<profile>/node_modules` 下建立指向本仓库的目录 junction，并把包名加进 profile
`package.json` 的 `dsh.profile.bundles` 与 `dependencies`，重启 DSH 生效。