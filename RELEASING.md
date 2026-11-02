# 发版流程

这个仓库同时是 **GitHub 插件源码** 和 **npm 包 `dsh-app-updater`**，两者版本必须一致。

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