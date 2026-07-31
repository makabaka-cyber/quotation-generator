# Logo 配置指南

## 概述

系统通过飞书图标表自动查询并下载保险公司logo。图标表ID已内置配置，无需手动设置。

## 支持的公司（8家）

| 文件名 | 对应公司 | 匹配关键词 |
|--------|----------|-----------|
| `pingan.png` | 中国平安 | 平安、平安产险、平安财产、平安保险、中国平安 |
| `chinalife.png` | 中国人寿 | 人寿、人寿财险、人寿财产、人寿保险、中国人寿、人保寿 |
| `cpic.png` | 中国太平洋 | 太平洋、太保、太平洋产险、太平洋财产、CPIC |
| `picc.png` | 中国人保 | 人保、人民财产、人保财险、人保财产、PICC、中国人保 |
| `taiping.png` | 太平保险 | 太平、太平产险、太平财产、太平保险、中国太平 |
| `chinaunion.png` | 中华联合 | 中华联合、中华保、中华财险、中华财产、CIC |
| `aito.png` | 问界 | 问界、AITO、aito、华为汽车、赛力斯 |
| `hongmeng.png` | 鸿蒙 | 鸿蒙、HarmonyOS、harmonyos |

## Logo 加载方式（自动）

### 方式1：飞书图标表查询（主要方式）✅

系统已内置图标表ID（`tblqZ84MplpY2sTr`），自动通过飞书API查询：

1. 根据保险公司名称匹配LOGO_MAP关键词
2. 在图标表中查找匹配的记录
3. 从附件字段获取标准file_token
4. 通过飞书OpenAPI下载图片
5. 自动缓存到本地`logos/`目录

**前提条件：**
- `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 已配置
- `BASE_TOKEN` 已配置（图标表与报价单表在同一个多维表格）
- 飞书应用有 `bitable:app:readonly` 和 `drive:drive:readonly` 权限
- 应用已被添加为多维表格的协作者

### 方式2：本地文件（缓存）

图标表下载的logo会自动缓存到`logos/`目录，后续请求直接使用本地文件。

也可手动添加：将logo图片重命名为上表文件名，放入`logos/`目录。

## Logo 加载优先级

```
1. 本地 logos/ 目录（按公司名关键词匹配，最快）
2. 飞书图标表查询（通过API下载，最可靠）
3. 环境变量 URL（INSURANCE_LOGO_URL / CAR_BRAND_LOGO_URL）
4. 环境变量 URL 列表（INSURANCE_LOGO_URLS / CAR_BRAND_LOGO_URLS）
5. 飞书字段值（报价单表中的logo字段）
6. 文字降级显示（显示公司名称文字）
```

## 诊断工具

部署后访问以下地址检查logo配置状态：

```
GET /debug/logos         # 查看logo映射、环境变量、文件列表
GET /debug/icon-table    # 查看图标表结构和字段（重要！）
GET /debug/logos/test    # 测试logo下载（本地+图标表）
```

**排查步骤：**
1. 先访问 `/debug/icon-table` 确认图标表能正常查询
2. 再访问 `/debug/logos/test` 测试logo下载
3. 如果图标表查询失败，检查飞书应用权限和协作者设置

## PDF 渲染规范

- Logo 高度：32pt（约 11mm）
- 最大宽度：160pt（保持原始比例）
- 位置：左上角并排显示
- 间距：24pt
- 当图片加载失败时，自动降级为文字显示
