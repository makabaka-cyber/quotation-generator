# 保险报价单生成系统 - 云端版

手机飞书一键生成报价单，**部署后彻底摆脱电脑**。

## 架构

```
手机飞书 → 点"生成报价单"按钮 → Render云端服务 → 飞书OpenAPI → 报价单写入附件字段
```

- 后端：Node.js 零依赖（仅用 Node 18+ 内置 fetch/FormData/Blob）
- 部署：Render.com 免费版
- 数据源：飞书多维表格（通过 OpenAPI 直接调用，不依赖 lark-cli）

## 需要上传到 GitHub 的文件

| 文件 | 必须 | 说明 |
|------|------|------|
| `server.js` | ✅ | 后端服务主文件 |
| `feishu-api.js` | ✅ | 飞书OpenAPI封装层 |
| `package.json` | ✅ | 部署配置（启动命令） |
| `.gitignore` | 推荐 | 忽略临时文件 |
| `quotation.html` | 可选 | 电脑端页面（手机端不需要） |

**不要上传**：`server.py`、`启动服务器.bat`、`.trae/` 目录

## 部署步骤

### 1. 创建飞书自建应用（获取凭证）

1. 浏览器打开 https://open.feishu.cn → 登录
2. 「开发者后台」→「创建企业自建应用」
   - 名称：报价单生成
3. 记录 **App ID** 和 **App Secret**
4. 「权限管理」→ 开启：
   - `bitable:app`（多维表格）
   - `bitable:record`（记录读写）
   - `drive:media:upload`（文件上传）
5. 「版本管理与发布」→ 创建版本 → 申请发布 → 管理员审核

### 2. 上传代码到 GitHub

1. 登录 GitHub → 新建仓库（如 `quotation-generator`）
2. 上传 4 个文件：`server.js`、`feishu-api.js`、`package.json`、`.gitignore`

### 3. 部署到 Render.com

1. 打开 https://render.com → 用 GitHub 登录
2. 「New +」→「Web Service」→ 选择上面的仓库
3. 配置：
   - Name: `quotation-generator`
   - Runtime: Node
   - Build Command: 留空（零依赖）
   - Start Command: `node server.js`
4. 环境变量：
   | Key | Value |
   |-----|-------|
   | `FEISHU_APP_ID` | 你的 App ID |
   | `FEISHU_APP_SECRET` | 你的 App Secret |
   | `BASE_TOKEN` | `Dt4kbDdd1a6OtkstVLXcLJjlneG` |
   | `TABLE_ID` | `tbluIyiU5i19TeqH` |
5. 「Create Web Service」→ 等待部署 → 获取 URL：`https://quotation-generator-xxxx.onrender.com`

### 4. 配置飞书表格按钮字段

1. 手机飞书打开保险多维表格
2. 新增字段 → 类型「按钮」
   - 字段名：生成报价单
   - 动作：打开网页
   - URL：`https://quotation-generator-xxxx.onrender.com/api/generate?record_id={{记录ID}}`

## 日常使用（纯手机）

1. 飞书上传保单图片 → 自动OCR识别
2. 点该行「生成报价单」按钮
3. 等待结果页（首次冷启动约30秒，之后3-5秒）
4. 返回飞书 → 下拉刷新 → 「报价单附件」字段查看报价单
