# GitHub Pages 部署说明

本项目已改造为**可纯静态托管**。页面所有内容都能在 GitHub Pages 上运行，
实时价格由浏览器直接向交易所公开接口获取（这些接口允许跨域）。

## 一、部署步骤

### 1. 创建仓库并推送

```bash
cd btc-cycle-heatmap
git init
git add -A
git commit -m "feat: BTC 四年周期热力图"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

### 2. 开启 Pages

仓库页面 → **Settings** → **Pages** → **Build and deployment** → Source 选 **GitHub Actions**

### 3. 配置 Telegram（可选）

仓库页面 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

添加两个：

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | 从 @BotFather 获取 |
| `TELEGRAM_CHAT_ID` | 你的 chat id |

不配置也不影响部署，只是不会发通知。

### 4. 手动触发一次

**Actions** 标签 → 左侧「更新 BTC 数据并部署」→ **Run workflow**

几分钟后访问 `https://<你的用户名>.github.io/<仓库名>/`

## 二、工作流程

`.github/workflows/update-and-deploy.yml` 每小时执行：

```
检出代码 → 安装 Node → node server/update.js（抓数据+重算+雷达检查）
   ↓
有变化则提交 public/data.json 等 → 上传 public/ 作为 Pages 产物 → 部署
```

**零依赖**：项目没有 npm 包，CI 里不需要 `npm install`。

## 三、架构变化

| 部分 | 本地服务模式 | GitHub Pages 模式 |
|---|---|---|
| 历史数据 | `/api/snapshot` 接口 | `public/data.json` 静态文件 |
| 数据更新 | 服务端每小时定时器 | GitHub Actions 每小时跑一次 |
| 实时价格 | 服务端抓取后经 `/api/price` 下发 | **浏览器直连交易所**（分钟级） |
| 买点雷达通知 | 服务端检查后推 Telegram | Actions 里检查后推 Telegram |

前端会自动探测：先试 `/api/snapshot`，404 则回退到 `./data.json`。
所以**同一份代码本地和线上都能跑**，无需改配置。

## 四、实时价格说明

浏览器按 `Binance → OKX → Coinbase` 顺序尝试，任一成功即可。
每 60 秒刷新一次，价格变动时数字会闪绿/闪红。

已验证三个源都返回 `access-control-allow-origin: *`，允许跨域。

如果你所在网络访问 Binance 受限，代码会自动降级到 OKX / Coinbase，无需干预。

## 五、限制

| 项目 | 说明 |
|---|---|
| 数据更新频率 | **每小时**（GitHub cron 最小粒度 5 分钟，实际常有延迟） |
| 实时价格 | 分钟级，由浏览器直接获取，不受 Actions 频率限制 |
| Actions 额度 | 公开仓库免费无限；私有仓库每月 2000 分钟（本项目每次约 10 秒，足够） |
| 提交频率 | 每小时一次提交，一年约 8760 次；如嫌多可把 cron 改为每 6 小时 |

## 六、调整更新频率

编辑 `.github/workflows/update-and-deploy.yml`：

```yaml
on:
  schedule:
    - cron: '3 * * * *'      # 每小时
    # - cron: '3 */6 * * *'  # 每 6 小时（提交更少）
    # - cron: '3 0 * * *'    # 每天一次
```

## 七、只想要纯静态、不需要自动更新？

如果你不想用 Actions，也可以本地手动更新后推送：

```bash
node server/update.js     # 重新抓数据，写入 public/data.json
git add public/data.json
git commit -m "docs: 更新数据"
git push
```

页面会读到最新数据。缺点是不会自动刷新。
