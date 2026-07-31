#!/usr/bin/env node
/**
 * 报价单生成系统 - 云端版（Node.js，零 npm 依赖）
 * 直接调用飞书OpenAPI（不依赖 lark-cli），可部署到 Render.com 等云平台
 *
 * 启动方式：node server.js
 * 环境变量：
 *   FEISHU_APP_ID     — 飞书自建应用 App ID
 *   FEISHU_APP_SECRET — 飞书自建应用 App Secret
 *   BASE_TOKEN        — 多维表格 app_token
 *   TABLE_ID          — 表格ID
 *   PORT              — 端口（默认 8000，Render 自动注入）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const feishu = require('./feishu-api');

// 环境变量
const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const BASE_TOKEN = process.env.BASE_TOKEN;
const TABLE_ID = process.env.TABLE_ID;
// 图标表ID：默认使用用户提供的图标表（存储各公司logo附件）
// 该表与报价单表在同一个多维表格中，tableId=tblqZ84MplpY2sTr
const ICON_TABLE_ID = process.env.ICON_TABLE_ID || 'tblqZ84MplpY2sTr';

// Logo 直接 URL（优先使用，绕过图标表查询）
const INSURANCE_LOGO_URL = process.env.INSURANCE_LOGO_URL || '';
const CAR_BRAND_LOGO_URL = process.env.CAR_BRAND_LOGO_URL || '';

// ============================================================
// 保险公司 Logo 映射表（关键词 → 本地文件名 / file_token）
// 支持多种关键词匹配，确保100%识别率
// ============================================================
const LOGO_MAP = [
    {
        keywords: ['平安', '平安产险', '平安财产', '平安保险', '中国平安'],
        file: 'pingan.png',
        fileToken: 'UcThbqazko298wxaij6cTVmbnGh',
        name: '中国平安',
        shortName: '平安',
    },
    {
        keywords: ['人寿', '人寿财险', '人寿财产', '人寿保险', '中国人寿', '人保寿'],
        file: 'chinalife.png',
        fileToken: 'DJ4EboKu4o9nAVxrrMic0F4cnPb',
        name: '中国人寿',
        shortName: '人寿',
    },
    {
        keywords: ['太平洋', '太保', '太平洋产险', '太平洋财产', '太平洋保险', 'CPIC'],
        file: 'cpic.png',
        fileToken: 'CPUQbuJwLolECkxVLKIcCwUOnef',
        name: '中国太平洋',
        shortName: '太平洋',
    },
    {
        keywords: ['人保', '人民财产', '人保财险', '人保财产', '人保保险', 'PICC', '中国人保'],
        file: 'picc.png',
        fileToken: 'DvFfbGTMBogwxQxcnXQckVO3nMh',
        name: '中国人保',
        shortName: '人保',
    },
    {
        keywords: ['太平', '太平产险', '太平财产', '太平保险', '中国太平'],
        file: 'taiping.png',
        fileToken: 'VMeWbGVaSo9Gh4xa6Ksc0cqInNc',
        name: '太平保险',
        shortName: '太平',
    },
    {
        keywords: ['中华联合', '中华保', '中华财险', '中华财产', '中华保险', 'CIC'],
        file: 'chinaunion.png',
        fileToken: 'HrAqbCBYToyLJHxQxdFcvF5mnRe',
        name: '中华联合',
        shortName: '中华',
    },
    {
        keywords: ['问界', 'AITO', 'aito', '华为汽车', '赛力斯'],
        file: 'aito.png',
        fileToken: 'MOBrbHGpmol1A9xbkoCc3OoinWb',
        name: '问界',
        shortName: '问界',
    },
    {
        keywords: ['鸿蒙', 'HarmonyOS', 'harmonyos'],
        file: 'hongmeng.png',
        fileToken: 'UgCGbGqnXokPypxs7fncZACSnwe',
        name: '鸿蒙',
        shortName: '鸿蒙',
    },
];

/**
 * 根据公司名称匹配logo映射（返回匹配的映射对象，不加载文件）
 * @param {string} companyName 公司名称
 * @returns {object|null}
 */
function findLogoMapping(companyName) {
    if (!companyName) return null;
    const normalizedName = String(companyName).toLowerCase().trim();
    
    // 精确匹配优先
    for (const mapping of LOGO_MAP) {
        for (const keyword of mapping.keywords) {
            if (normalizedName === keyword.toLowerCase()) {
                console.log(`[PDF] 精确匹配: "${companyName}" → ${mapping.name}`);
                return mapping;
            }
        }
    }
    
    // 包含匹配（最长关键词优先）
    const sortedMapings = [...LOGO_MAP].sort((a, b) => {
        const aMax = Math.max(...a.keywords.map(k => k.length));
        const bMax = Math.max(...b.keywords.map(k => k.length));
        return bMax - aMax;
    });
    
    for (const mapping of sortedMapings) {
        for (const keyword of mapping.keywords) {
            if (normalizedName.includes(keyword.toLowerCase())) {
                console.log(`[PDF] 关键词匹配: "${companyName}" 包含 "${keyword}" → ${mapping.name}`);
                return mapping;
            }
        }
    }
    
    console.warn(`[PDF] 未匹配到 "${companyName}" 的logo关键词`);
    return null;
}

/**
 * 根据公司名称从本地 logos/目录加载 logo（仅本地文件，不联网）
 * 支持多种图片格式（png, jpg, jpeg, svg）
 * @param {string} companyName 公司名称
 * @returns {Buffer|null}
 */
function loadLogoByCompanyName(companyName) {
    if (!companyName) return null;
    
    const mapping = findLogoMapping(companyName);
    if (!mapping) return null;
    
    try {
        const logosDir = path.join(__dirname, 'logos');
        const extensions = ['.png', '.jpg', '.jpeg', '.svg'];
        
        for (const ext of extensions) {
            const logoPath = path.join(logosDir, mapping.file.replace(/\.[^.]+$/, '') + ext);
            if (fs.existsSync(logoPath)) {
                const buf = fs.readFileSync(logoPath);
                if (buf.length >= 20) {
                    console.log(`[PDF] 本地logo加载成功: ${companyName} → ${mapping.file} (${buf.length} bytes)`);
                    return buf;
                } else if (buf.length > 0) {
                    console.warn(`[PDF] 本地logo文件太小（${buf.length} bytes），跳过: ${logoPath}`);
                }
            }
        }
        
        // 尝试原始文件名
        const originalPath = path.join(logosDir, mapping.file);
        if (fs.existsSync(originalPath)) {
            const buf = fs.readFileSync(originalPath);
            if (buf.length >= 20) {
                console.log(`[PDF] 本地logo加载成功: ${companyName} → ${mapping.file} (${buf.length} bytes)`);
                return buf;
            } else if (buf.length > 0) {
                console.warn(`[PDF] 本地logo文件太小（${buf.length} bytes），跳过: ${originalPath}`);
            }
        }
        
        console.warn(`[PDF] 本地logo文件不存在: ${mapping.file}（公司: ${companyName}）`);
        return null;
    } catch (e) {
        console.warn(`[PDF] 加载本地logo失败: ${e.message}`);
    }
    return null;
}

/**
 * 获取logo的显示名称（用于文字降级显示）
 * @param {string} companyName 公司名称
 * @returns {string}
 */
function getLogoDisplayName(companyName) {
    const mapping = findLogoMapping(companyName);
    return mapping ? mapping.name : (companyName || '未知公司');
}

const PORT = process.env.PORT || 8000;

// 注册中文字体（系统字体路径 + 项目内置字体）
// pdfkit 只支持 .ttf 和 .otf 格式，不支持 .ttc
let CHINESE_FONT = null;
let FONT_WORKED = false;

// 优先检查项目内置字体
const projectFonts = [
    path.join(__dirname, 'fonts', 'NotoSansSC-Regular.ttf'),
    path.join(__dirname, 'fonts', 'SourceHanSansSC-Regular.otf'),
    path.join(__dirname, 'fonts', 'NotoSansCJK-Regular.ttf'),
    path.join(__dirname, 'fonts', 'NotoSansSC-Regular.otf'),
    path.join(__dirname, 'fonts', 'wqy-microhei.ttf'),
    path.join(__dirname, 'fonts', 'msyh.ttf'),
];

const candidateFonts = [
    // 项目内置字体（优先）
    ...projectFonts,
    // Windows .ttf
    'C:/Windows/Fonts/msyh.ttf',
    'C:/Windows/Fonts/simhei.ttf',
    'C:/Windows/Fonts/simsun.ttf',
    // Linux - Noto CJK (nixpacks font-noto-cjk)
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.otf',
    '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttf',
    '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.otf',
    '/usr/share/fonts/noto-cjk/NotoSansSC-Regular.otf',
    '/usr/share/fonts/noto/NotoSansCJK-Regular.ttf',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttf',
    // Linux - 文泉驿
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttf',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttf',
    // Linux - 系统字体
    '/usr/share/fonts/truetype/arphic/uming.ttc',
    '/usr/share/fonts/truetype/arphic/ukai.ttc',
];

// 检查字体文件
for (const fp of candidateFonts) {
    if (fs.existsSync(fp)) {
        CHINESE_FONT = fp;
        console.log(`[字体] 找到中文字体: ${fp}`);
        break;
    }
}

if (!CHINESE_FONT) {
    console.log(`[字体] 未找到中文字体，将使用默认字体（中文可能显示为方框）`);
    console.log(`[字体] 建议将中文字体文件放入项目 fonts/ 目录`);
}

// ============================================================
// 工具函数（从原 server.js 保留，不修改）
// ============================================================

/**
 * 从"识别结果"字段中解析键值对
 * 格式: 客户姓名:xxx|车型:xxx|...
 */
function parseRecognitionResult(text) {
    const result = {};
    if (!text || typeof text !== 'string') return result;
    const parts = text.split('|');
    for (const part of parts) {
        const idx = part.indexOf(':');
        if (idx > 0) {
            const key = part.substring(0, idx).trim();
            const value = part.substring(idx + 1).trim();
            result[key] = value;
        }
    }
    return result;
}

/** 将值转换为数字，失败时返回 0 */
function toNumber(value) {
    if (value === null || value === undefined || value === '') return 0;
    const num = parseFloat(value);
    return isNaN(num) ? 0 : num;
}

/** 金额格式化：¥x,xxx.xx */
function formatMoney(n) {
    const num = toNumber(n);
    return '¥' + num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 保额格式化：数字显示，不带小数 */
function formatBaoE(n) {
    const num = toNumber(n);
    return Math.floor(num).toLocaleString('zh-CN');
}

/**
 * 规范化飞书OpenAPI字段值：
 * - 富文本数组 [{type:"text",text:"xxx"}] → 提取纯文本
 * - 单值lookup数组 [item] → item
 * - 保留附件数组、null 等
 */
function normalizeFieldValue(value) {
    if (value === null || value === undefined) return value;

    // 处理飞书 search API 返回的 {type, value} 包装格式（lookup/引用字段）
    // 例如: {type:1, value:[{text:"xxx", type:"text"}]}
    if (typeof value === 'object' && !Array.isArray(value) && 'value' in value && 'type' in value) {
        return normalizeFieldValue(value.value);
    }

    if (Array.isArray(value)) {
        if (value.length === 0) return null;
        if (value.length === 1) {
            const item = value[0];
            // 富文本项 {type:"text", text:"xxx"}
            if (typeof item === 'object' && item !== null && 'text' in item) {
                return item.text;
            }
            // 单值lookup，解包
            if (typeof item === 'object' && item !== null && !('file_token' in item)) {
                return item.value !== undefined ? item.value : item;
            }
            return item;
        }
        // 多值：尝试提取文本拼接
        if (value.length > 1) {
            const first = value[0];
            if (typeof first === 'object' && first !== null && 'text' in first) {
                return value.map(v => v.text || '').join('');
            }
        }
        return value;
    }
    return value;
}

/**
 * 将飞书OpenAPI记录格式适配为内部格式
 * OpenAPI: { record_id, fields: {字段名: 值} }
 * 内部:    { _record_id, 字段名: 值, ... }
 */
function adaptRecord(openApiRecord) {
    if (!openApiRecord) return null;
    const record = { _record_id: openApiRecord.record_id || '' };
    const fields = openApiRecord.fields || {};
    for (const [key, value] of Object.entries(fields)) {
        record[key] = normalizeFieldValue(value);
    }
    // 从"识别结果"中补充解析"驾乘意外保额"（飞书表中无此字段）
    const recognition = record['识别结果'];
    if (recognition) {
        const parsed = parseRecognitionResult(recognition);
        if (parsed['驾乘意外保额']) {
            record['驾乘意外保额'] = toNumber(parsed['驾乘意外保额']);
        }
    }
    return record;
}

// ============================================================
// 报价单生成逻辑（从原 server.js 保留，不修改）
// ============================================================

/** 构建记录详情（用于报价单生成），统一字段名 */
function buildRecordDetail(record) {
    return {
        record_id: record._record_id || '',
        '客户信息': record['客户信息'] || '',
        '车型': record['车型'] || '',
        '保险公司': record['保险公司'] || '',
        // 优先读取「图标-公司logo」字段，回退到「公司Logo」，最后回退到原字段
        '保险公司logo': record['图标-公司logo'] || record['公司Logo'] || record['保险公司logo'] || '',
        '问界logo': record['图标-品牌logo'] || record['品牌Logo'] || record['问界logo'] || '',
        '保单编号': record['保单编号'] || '',
        '交强保额': toNumber(record['交强保额']) || 200000,
        '交强保费': toNumber(record['交强保费']),
        '车船税': toNumber(record['车船税']),
        '车损险保费': toNumber(record['车损险保费']),
        '医保外保额': toNumber(record['医保外保额']),
        '医保外保费': toNumber(record['医保外保费']),
        '外电网保费': toNumber(record['外电网保费']),
        '三者保额': toNumber(record['三者保额']),
        '三者保费': toNumber(record['三者保费']),
        '司机座位险保额': toNumber(record['司机座位险保额']),
        '乘客座位险保额': toNumber(record['乘客座位险保额']),
        '驾乘意外保额': toNumber(record['驾乘意外保额']),
        '司机座位险保费': toNumber(record['司机座位险保费']),
        '乘客座位险保费': toNumber(record['乘客座位险保费']),
        '驾乘意外保费': toNumber(record['驾乘意外保费']),
        '商业险合计': toNumber(record['商业险合计']),
        '保险公司保费': toNumber(record['保险公司保费']),
        '新能源车损两年期': toNumber(record['新能源车损两年期']),
        '新能源车损三年期': toNumber(record['新能源车损三年期']),
        '新能源车损三年期+': toNumber(record['新能源车损三年期+']),
        '非车价格m': toNumber(record['非车价格m']),
        '非车价格u': toNumber(record['非车价格u']),
        '非车价格u+': toNumber(record['非车价格u+']),
        // 各产品投保状态：未投保 / 有险种无分项价 / 正常保费
        '交强险状态': record['交强险状态'] || '正常保费',
        '车损状态': record['车损状态'] || '正常保费',
        '新能源车损保全状态': record['新能源车损保全状态'] || '正常保费',
        '三者状态': record['三者状态'] || '正常保费',
        '医保外状态': record['医保外状态'] || '正常保费',
        '外电网状态': record['外电网状态'] || '正常保费',
        '司机座位险状态': record['司机座位险状态'] || '正常保费',
        '乘客座位险状态': record['乘客座位险状态'] || '正常保费',
        '驾乘意外状态': record['驾乘意外状态'] || '正常保费',
        '车船税状态': record['车船税状态'] || '正常保费',
    };
}

/**
 * 后端直接生成纯文本报价单
 * 确保所有"安心包"和"非车"字样全部过滤，仅显示"新能源车损保全"
 */
function generateTextFromRecord(detail) {
    const d = detail || {};
    const get = (k) => (d[k] !== undefined && d[k] !== null && d[k] !== '') ? d[k] : '—';
    const fm = (k) => formatMoney(d[k]);
    const insuranceTotal = toNumber(d['保险公司保费']);

    const line = '═'.repeat(40);
    const dash = '─'.repeat(40);
    const dash2 = '┄'.repeat(40);

    let t = '';
    t += line + '\n';
    t += '          保 险 报 价 确 认 单\n';
    t += line + '\n';
    t += `承保公司：${get('保险公司')}\n`;
    t += `保单编号：${get('保单编号')}\n`;
    t += '\n';
    t += '【客户信息】\n';
    t += `  客　户：${get('客户信息')}\n`;
    t += `  车　型：${get('车型')}\n`;
    t += '\n';
    t += '【保障项目】\n';
    t += dash + '\n';
    t += '  保障项目             保额        保费\n';
    t += dash + '\n';

    // 各产品定义（与PDF版本保持一致）
    const textDefs = [
        { name: '交强险', baoE: formatBaoE(d['交强保额']), premium: fm('交强保费'), statusKey: '交强险状态' },
        { name: '车损险', baoE: '—', premium: fm('车损险保费'), statusKey: '车损状态' },
        { name: '新能源车损保全', baoE: '—', premium: fm('非车价格m'), statusKey: '新能源车损保全状态' },
        { name: '三者险', baoE: formatBaoE(d['三者保额']), premium: fm('三者保费'), statusKey: '三者状态' },
        { name: '医保外责任险', baoE: formatBaoE(d['医保外保额']), premium: fm('医保外保费'), statusKey: '医保外状态' },
        { name: '外电网责任险', baoE: '—', premium: fm('外电网保费'), statusKey: '外电网状态' },
        { name: '司机座位险', baoE: formatBaoE(d['司机座位险保额']), premium: fm('司机座位险保费'), statusKey: '司机座位险状态' },
        { name: '乘客座位险', baoE: formatBaoE(d['乘客座位险保额']), premium: fm('乘客座位险保费'), statusKey: '乘客座位险状态' },
        { name: '驾乘意外险', baoE: formatBaoE(d['驾乘意外保额']), premium: fm('驾乘意外保费'), statusKey: '驾乘意外状态' },
        { name: '车船税', baoE: '—', premium: fm('车船税'), statusKey: '车船税状态' },
    ];
    for (const def of textDefs) {
        const status = d[def.statusKey] || '正常保费';
        if (status === '未投保') continue;
        const premium = status === '有险种无分项价' ? '—' : def.premium;
        t += `  ${def.name}  ${def.baoE}  ${premium}\n`;
    }
    t += dash + '\n';
    t += '【新能源车损保全（三方案同报）】\n';
    t += dash2 + '\n';
    t += `  两年期          ${formatMoney(d['非车价格m'])}     ${fm('新能源车损两年期')}\n`;
    t += `  三年期          ${formatMoney(d['非车价格u'])}     ${fm('新能源车损三年期')}\n`;
    t += `  三年期+（尊享版）${formatMoney(d['非车价格u+'])}    ${fm('新能源车损三年期+')}\n`;
    t += dash2 + '\n';

    return t;
}

// ============================================================
// Logo 加载工具
// ============================================================

/**
 * 从飞书多维表格图标/附件字段加载 logo 图片
 * 支持以下格式：
 * 1. URL 字符串: "https://..." → 直接 fetch
 * 2. 附件对象: {file_token: "xxx"} 或 [{file_token: "xxx"}] → 通过飞书 API 下载
 * 3. 图标字段值: 可能是 URL 或 token
 * 4. 飞书内部API URL: 包含 file_token 的 internal-api-drive-stream URL
 * @returns {Promise<Buffer|null>}
 */
async function loadLogoImage(value) {
    if (!value) return null;
    try {
        let url = null;
        let fileToken = null;

        if (typeof value === 'string') {
            // 纯字符串：可能是 URL 或 token
            if (value.startsWith('http')) {
                url = value;
                // 尝试从飞书内部API URL提取file_token
                if (value.includes('internal-api-drive-stream.feishu.cn')) {
                    const match = value.match(/\/preview\/([A-Za-z0-9]+)/);
                    if (match) {
                        fileToken = match[1];
                        console.log(`[PDF] 从飞书内部URL提取file_token: ${fileToken}`);
                    }
                }
            } else if (value.startsWith('boxcn') || value.length > 20) {
                // 可能是飞书 file_token
                fileToken = value;
            } else {
                return null;
            }
        } else if (typeof value === 'object' && value !== null) {
            // 对象格式
            if (value.file_token) {
                fileToken = value.file_token;
            } else if (typeof value.url === 'string') {
                url = value.url;
                // 同样处理飞书内部API URL
                if (url.includes('internal-api-drive-stream.feishu.cn')) {
                    const match = url.match(/\/preview\/([A-Za-z0-9]+)/);
                    if (match) {
                        fileToken = match[1];
                        console.log(`[PDF] 从飞书内部URL提取file_token: ${fileToken}`);
                    }
                }
            } else if (value.link) {
                url = value.link;
            }
        } else if (Array.isArray(value) && value.length > 0) {
            // 数组格式（飞书附件字段）
            const first = value[0];
            if (first && first.file_token) {
                fileToken = first.file_token;
            } else if (first && typeof first === 'string') {
                return loadLogoImage(first);
            }
        }

        // 优先通过飞书 file_token 下载
        if (fileToken) {
            console.log(`[PDF] 尝试file_token下载: ${fileToken.substring(0, 20)}...`);
            try {
                const { getTenantToken } = require('./feishu-api');
                const token = await getTenantToken();

                // 多维表格附件需要extra参数指定tableId上下文
                // 尝试多种extra组合，确保能下载成功
                const tryExtras = [
                    // 尝试1: 使用ICON_TABLE_ID（图标表）
                    ICON_TABLE_ID ? `{"bitablePerm":{"tableId":"${ICON_TABLE_ID}","rev":0}}` : null,
                    // 尝试2: 使用TABLE_ID（报价单表）
                    TABLE_ID ? `{"bitablePerm":{"tableId":"${TABLE_ID}","rev":0}}` : null,
                    // 尝试3: 无extra（普通云文档/旧版API）
                    null,
                ];

                for (let i = 0; i < tryExtras.length; i++) {
                    const extra = tryExtras[i];
                    if (i > 0) console.log(`[PDF] 尝试下载 (方式${i+1}): extra=${extra ? extra.substring(0, 60) : 'none'}`);
                    try {
                        const downloadUrl = extra
                            ? `https://open.feishu.cn/open-apis/drive/v1/medias/${fileToken}/download?extra=${encodeURIComponent(extra)}`
                            : `https://open.feishu.cn/open-apis/drive/v1/medias/${fileToken}/download`;
                        const resp = await fetch(downloadUrl, {
                            headers: { 'Authorization': `Bearer ${token}` }
                        });
                        if (resp.ok) {
                            const buf = Buffer.from(await resp.arrayBuffer());
                            if (buf.length >= 20) {
                                console.log(`[PDF] ✅ 下载成功 (方式${i+1}): ${buf.length} bytes`);
                                return buf;
                            }
                        } else {
                            if (i === 0) {
                                try { const text = await resp.text(); console.log(`[PDF] 下载错误: HTTP ${resp.status}, ${text.substring(0, 200)}`); } catch(e) {}
                            }
                        }
                    } catch (e) {
                        if (i === 0) console.warn(`[PDF] 下载异常: ${e.message}`);
                    }
                }
            } catch (e) {
                console.warn(`[PDF] file_token下载总体异常: ${e.message}`);
            }
        }

        // 通过 URL 加载（作为降级方案）
        if (url && !fileToken) {
            try {
                const resp = await fetch(url);
                if (resp.ok) {
                    const buf = Buffer.from(await resp.arrayBuffer());
                    if (buf.length > 500) {
                        console.log(`[PDF] URL下载成功: ${url.substring(0, 40)}... (${buf.length} bytes)`);
                        return buf;
                    }
                } else {
                    console.warn(`[PDF] URL下载失败: HTTP ${resp.status}`);
                }
            } catch (e) {
                console.warn(`[PDF] URL下载异常: ${e.message}`);
            }
        }
    } catch (e) {
        console.warn(`[PDF] 加载 logo 失败: ${e.message}`);
    }
    return null;
}

/**
 * 从图标表（ICON_TABLE_ID）根据公司名称获取 logo
 * 通过飞书API查询图标表记录，从附件字段中获取标准file_token下载图片
 *
 * 匹配策略：
 * 1. 使用 LOGO_MAP 的关键词进行精确+包含匹配（确保100%识别率）
 * 2. 遍历所有字段查找包含附件（file_token）的字段
 * 3. 不依赖特定字段名，更健壮
 *
 * @param {string} companyName 保险公司名称
 * @returns {Promise<Buffer|null>}
 */
async function fetchLogoFromIconTable(companyName) {
    if (!ICON_TABLE_ID || !companyName) {
        console.warn(`[PDF] 图标表查询跳过: ICON_TABLE_ID="${ICON_TABLE_ID}", companyName="${companyName}"`);
        return null;
    }
    if (!BASE_TOKEN) {
        console.warn('[PDF] 图标表查询跳过: BASE_TOKEN 未设置');
        return null;
    }

    try {
        const { searchRecords } = require('./feishu-api');
        console.log(`[PDF] 查询图标表: BASE_TOKEN=${BASE_TOKEN?.substring(0, 10)}..., TABLE=${ICON_TABLE_ID}`);
        const records = await searchRecords(BASE_TOKEN, ICON_TABLE_ID);
        console.log(`[PDF] 图标表共 ${records.length} 条记录`);

        if (records.length === 0) {
            console.warn('[PDF] 图标表为空，无记录');
            return null;
        }

        // 打印字段结构（仅首次调试）
        const sampleFields = records[0].fields || {};
        console.log(`[PDF] 图标表字段名: ${Object.keys(sampleFields).join(', ')}`);

        // 使用 LOGO_MAP 的关键词匹配公司名（与findLogoMapping一致）
        const mapping = findLogoMapping(companyName);
        if (!mapping) {
            console.warn(`[PDF] 公司名 "${companyName}" 未匹配到LOGO_MAP关键词，跳过图标表查询`);
            return null;
        }

        // 遍历图标表记录，查找匹配的公司
        for (const record of records) {
            const fields = record.fields || {};

            // 遍历所有字段，查找文本类字段中包含公司关键词的记录
            let matched = false;
            let matchedFieldName = '';
            for (const [fieldName, fieldValue] of Object.entries(fields)) {
                // 跳过附件字段（含file_token的数组）
                if (Array.isArray(fieldValue) && fieldValue.length > 0 && fieldValue[0]?.file_token) {
                    continue;
                }
                // 规范化字段值为字符串
                const textValue = normalizeFieldValueToString(fieldValue);
                if (!textValue) continue;

                // 用LOGO_MAP的关键词匹配
                for (const keyword of mapping.keywords) {
                    if (textValue.includes(keyword)) {
                        matched = true;
                        matchedFieldName = fieldName;
                        console.log(`[PDF] 图标表匹配: 字段"${fieldName}"="${textValue}" 包含关键词"${keyword}" → ${mapping.name}`);
                        break;
                    }
                }
                if (matched) break;
            }

            if (!matched) continue;

            // 找到匹配记录后，遍历所有字段查找附件（file_token）
            for (const [fieldName, fieldValue] of Object.entries(fields)) {
                if (!Array.isArray(fieldValue) || fieldValue.length === 0) continue;
                const first = fieldValue[0];
                if (first && first.file_token) {
                    console.log(`[PDF] 找到附件字段"${fieldName}": file_token=${first.file_token.substring(0, 20)}..., name=${first.name || '?'}`);
                    console.log(`[PDF] 附件详情: type=${first.type}, size=${first.size}, file_token=${first.file_token}`);
                    
                    // 直接测试下载，绕过loadLogoImage的复杂逻辑
                    let buf = await loadLogoImage(fieldValue);
                    
                    // 如果loadLogoImage失败，直接用file_token下载
                    if (!buf || buf.length < 20) {
                        console.log(`[PDF] loadLogoImage失败，尝试直接用file_token下载...`);
                        try {
                            const { getTenantToken } = require('./feishu-api');
                            const token = await getTenantToken();
                            
                            // 尝试多种extra参数
                            const extraConfigs = [
                                ICON_TABLE_ID ? `{"bitablePerm":{"tableId":"${ICON_TABLE_ID}","rev":0}}` : null,
                                TABLE_ID ? `{"bitablePerm":{"tableId":"${TABLE_ID}","rev":0}}` : null,
                                null,
                            ];
                            
                            for (const extra of extraConfigs) {
                                const durl = extra
                                    ? `https://open.feishu.cn/open-apis/drive/v1/medias/${first.file_token}/download?extra=${encodeURIComponent(extra)}`
                                    : `https://open.feishu.cn/open-apis/drive/v1/medias/${first.file_token}/download`;
                                const resp = await fetch(durl, { headers: { 'Authorization': `Bearer ${token}` } });
                                console.log(`[PDF] 直接下载: HTTP ${resp.status}, extra=${extra ? extra.substring(0,50) : 'none'}`);
                                if (resp.ok) {
                                    const b = Buffer.from(await resp.arrayBuffer());
                                    if (b.length >= 20) {
                                        buf = b;
                                        console.log(`[PDF] ✅ 直接下载成功: ${b.length} bytes`);
                                        break;
                                    }
                                } else {
                                    try { console.log(`[PDF] 错误: ${(await resp.text()).substring(0,150)}`); } catch(e) {}
                                }
                            }
                        } catch (e) {
                            console.error(`[PDF] 直接下载异常: ${e.message}`);
                        }
                    }
                    
                    if (buf && buf.length >= 20) {
                        console.log(`[PDF] ✅ 从图标表加载logo成功: ${mapping.name} (${buf.length} bytes)`);

                        // 缓存到本地（清理旧缓存）
                        try {
                            const logosDir = path.join(__dirname, 'logos');
                            if (!fs.existsSync(logosDir)) fs.mkdirSync(logosDir, { recursive: true });
                            const cachePath = path.join(logosDir, mapping.file);
                            // 写入前先删除旧文件
                            if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
                            fs.writeFileSync(cachePath, buf);
                            console.log(`[PDF] logo已缓存到本地: ${mapping.file}`);
                        } catch (e) {
                            console.warn(`[PDF] logo缓存失败: ${e.message}`);
                        }
                        return buf;
                    } else {
                        console.warn(`[PDF] 附件字段"${fieldName}"加载失败`);
                    }
                }
            }
            console.warn(`[PDF] 匹配到记录(${matchedFieldName})但未找到附件字段`);
        }

        console.warn(`[PDF] 图标表中未找到 "${companyName}" (匹配:${mapping.name}) 的logo`);
    } catch (e) {
        console.warn(`[PDF] 从图标表加载logo失败: ${e.message}`);
    }
    return null;
}

/**
 * 将飞书字段值规范化为字符串（用于公司名匹配）
 * @param {*} value 飞书字段值
 * @returns {string}
 */
function normalizeFieldValueToString(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) {
        // 飞书文本字段返回 [{text: "xxx"}]
        return value.map(v => {
            if (typeof v === 'string') return v;
            if (v && typeof v === 'object') return v.text || v.value || v.name || '';
            return '';
        }).join('');
    }
    if (typeof value === 'object') {
        return value.text || value.value || value.name || '';
    }
    return '';
}

// ============================================================
// Logo 渲染工具函数
// ============================================================

/**
 * 在PDF页眉绘制logo（保险公司logo + 品牌logo）
 * 确保尺寸适配、保持比例、位置统一
 * @param {PDFDocument} doc PDF文档实例
 * @param {object} opts 配置选项
 * @returns {object} { nextY: number } 下一个可用的Y坐标
 */
function drawLogos(doc, opts) {
    const {
        y,
        companyName,
        companyLogoBuf,
        brandName,
        brandLogoBuf,
        colors,
        useFont,
        setFontSize,
        getDisplayName,
        pageMarginLeft,
        pageMarginRight,
        pageWidth,
    } = opts;

    const contentWidth = pageWidth - pageMarginLeft - pageMarginRight;
    const logoH = 32;
    const logoGap = 24;
    let currentX = pageMarginLeft;
    let maxY = y + logoH;

    // 辅助函数：绘制单个logo（图片或文字降级）
    function drawSingleLogo(name, logoBuf, x) {
        const displayName = getDisplayName(name);
        const maxLogoWidth = 160;
        
        if (logoBuf && logoBuf.length > 100) {
            try {
                // 计算图片尺寸比例，保持原始比例
                doc.save();
                doc.image(logoBuf, x, y, { 
                    height: logoH, 
                    fit: [maxLogoWidth, logoH],
                    align: 'left'
                });
                // 估算实际渲染宽度（基于160:32的最大比例）
                const estimatedWidth = Math.min(maxLogoWidth, logoH * 5);
                doc.restore();
                console.log(`[PDF] 渲染logo图片: ${displayName} (${estimatedWidth}px宽)`);
                return { width: estimatedWidth, height: logoH };
            } catch (e) {
                console.warn(`[PDF] 渲染logo图片失败: ${e.message}，使用文字降级`);
                return drawAsText(displayName, x);
            }
        } else {
            return drawAsText(displayName, x);
        }
    }

    // 辅助函数：文字降级显示
    function drawAsText(displayName, x) {
        doc.save();
        useFont();
        doc.fillColor(colors.primary);
        setFontSize(13);
        const textY = y + (logoH - 16) / 2;
        const textWidth = doc.widthOfString(displayName) + 8;
        doc.text(displayName, x, textY);
        doc.restore();
        console.log(`[PDF] 渲染文字logo: ${displayName} (${textWidth}px宽)`);
        return { width: textWidth, height: logoH };
    }

    // 绘制保险公司logo（左上角）
    const insLogo = drawSingleLogo(companyName || '未知公司', companyLogoBuf, currentX);
    maxY = Math.max(maxY, y + insLogo.height);

    // 绘制品牌logo（问界）（右上角）
    const brandLogoX = pageWidth - pageMarginRight;
    console.log(`[PDF] 右上角logo参数: rightX=${brandLogoX}, y=${y}, logoH=${logoH}, pageWidth=${pageWidth}, pageMarginRight=${pageMarginRight}`);
    const brandLogo = drawBrandLogoRight(brandName, brandLogoBuf, brandLogoX);
    maxY = Math.max(maxY, y + brandLogo.height);

    console.log(`[PDF] Logo渲染完成: 保险公司=${companyName || '未知'}, 品牌=${brandName}`);
    
    return { nextY: maxY };

    // 辅助函数：右上角绘制品牌logo
    function drawBrandLogoRight(name, logoBuf, rightX) {
        const displayName = getDisplayName(name);
        const maxLogoWidth = 120;
        const safeLogoH = logoH || 32;
        const safeRightX = isNaN(rightX) ? (pageWidth - pageMarginRight) : rightX;
        const estimatedWidth = Math.min(maxLogoWidth, safeLogoH * 4);
        
        console.log(`[PDF] drawBrandLogoRight: name=${name}, logoBuf=${logoBuf ? logoBuf.length + 'bytes' : 'null'}, rightX=${safeRightX}, logoH=${safeLogoH}`);
        
        if (logoBuf && logoBuf.length > 100) {
            try {
                // 检查图片格式
                const header = logoBuf.slice(0, 8).toString('hex');
                const isPng = header.startsWith('89504e47');
                const isJpg = header.startsWith('ffd8ff');
                const isGif = header.startsWith('474946');
                const isSvg = logoBuf.toString('utf8', 0, 100).includes('<svg');
                console.log(`[PDF] 品牌logo格式: header=${header.substring(0,16)}, png=${isPng}, jpg=${isJpg}, gif=${isGif}, svg=${isSvg}`);
                
                doc.save();
                const drawX = safeRightX - estimatedWidth;
                console.log(`[PDF] 绘制品牌logo: x=${drawX}, y=${y}, width=${estimatedWidth}, height=${safeLogoH}`);
                
                // 尝试使用openImage预加载
                try {
                    const image = doc.openImage(logoBuf);
                    console.log(`[PDF] openImage成功: width=${image.width}, height=${image.height}`);
                    doc.image(image, drawX, y, { 
                        width: estimatedWidth,
                        height: safeLogoH
                    });
                } catch (openErr) {
                    console.warn(`[PDF] openImage失败: ${openErr.message}，尝试直接传buffer`);
                    doc.image(logoBuf, drawX, y, { 
                        width: estimatedWidth,
                        height: safeLogoH
                    });
                }
                
                doc.restore();
                console.log(`[PDF] ✅ 渲染右上角logo图片: ${displayName} (${estimatedWidth}px宽)`);
                return { width: estimatedWidth, height: safeLogoH };
            } catch (e) {
                console.warn(`[PDF] 渲染右上角logo图片失败: ${e.message}，使用文字降级`);
                return drawBrandTextRight(displayName, safeRightX);
            }
        } else {
            return drawBrandTextRight(displayName, safeRightX);
        }
    }

    function drawBrandTextRight(displayName, rightX) {
        const safeLogoH = logoH || 32;
        doc.save();
        useFont();
        doc.fillColor(colors.primary);
        setFontSize(13);
        const textY = y + (safeLogoH - 16) / 2;
        const textWidth = doc.widthOfString(displayName) + 8;
        doc.text(displayName, rightX - textWidth, textY);
        doc.restore();
        console.log(`[PDF] 渲染右上角文字logo: ${displayName} (${textWidth}px宽)`);
        return { width: textWidth, height: safeLogoH };
    }
}

// ============================================================
// PDF 生成
// ============================================================

/**
 * 使用 pdfkit 生成精美 PDF 报价单
 * 严格遵循约束：不含"安心包"/"非车"字样，统一为"新能源车损保全"
 * @param {object} detail 记录详情（buildRecordDetail 返回值）
 * @returns {Promise<Buffer>} PDF 文件 Buffer
 */
function generatePdf(detail) {
    return (async () => {
        const d = detail || {};
        const get = (k) => (d[k] !== undefined && d[k] !== null && d[k] !== '') ? d[k] : '—';
        const fm = (k) => formatMoney(d[k]);

        // ============================================================
        // Logo 加载策略（按优先级依次尝试）
        // 1. 本地 logos/ 目录（按公司名关键词匹配）
        // 2. 环境变量 URL（INSURANCE_LOGO_URL / CAR_BRAND_LOGO_URL）
        // 3. 多个环境变量 URL 列表（INSURANCE_LOGO_URLS / CAR_BRAND_LOGO_URLS）
        // 4. 飞书字段值（图标-公司logo / 图标-品牌logo）
        // 5. 图标表兜底查询
        // ============================================================
        
        // 从多个URL尝试加载logo
        async function tryLoadFromUrls(urlsStr) {
            if (!urlsStr) return null;
            const urls = urlsStr.split(',').map(u => u.trim()).filter(u => u);
            for (const url of urls) {
                try {
                    console.log(`[PDF] 尝试URL加载logo: ${url.substring(0, 60)}...`);
                    const buf = await loadLogoImage(url);
                    if (buf && buf.length > 500) {
                        console.log(`[PDF] URL加载成功: ${url.substring(0, 40)}... (${buf.length} bytes)`);
                        return buf;
                    }
                } catch (e) {
                    console.warn(`[PDF] URL加载失败: ${e.message}`);
                }
            }
            return null;
        }

        // 先清理无效logo缓存（小于20字节的文件）
        try {
            const logosDir = path.join(__dirname, 'logos');
            if (fs.existsSync(logosDir)) {
                const files = fs.readdirSync(logosDir);
                for (const file of files) {
                    const fpath = path.join(logosDir, file);
                    if (fs.statSync(fpath).size < 20) {
                        console.log(`[PDF] 清理无效缓存: ${file}`);
                        fs.unlinkSync(fpath);
                    }
                }
            }
        } catch (e) { /* ignore */ }

        // 并行加载两个logo，提高效率
        console.log(`[PDF] 开始并行加载logo: 保险公司="${d['保险公司']}", 品牌="问界"`);
        
        const [insuranceLogoBuf, carBrandLogoBuf] = await Promise.all([
            // 加载保险公司logo
            (async () => {
                let buf = null;
                // 策略1: 本地
                buf = loadLogoByCompanyName(d['保险公司']);
                // 策略2: 图标表
                if (!buf) buf = await fetchLogoFromIconTable(d['保险公司']);
                // 策略3: 环境变量
                if (!buf && INSURANCE_LOGO_URL) buf = await loadLogoImage(INSURANCE_LOGO_URL);
                // 策略4: URL列表
                if (!buf) {
                    const urls = process.env.INSURANCE_LOGO_URLS || '';
                    buf = await tryLoadFromUrls(urls);
                }
                // 策略5: 飞书字段
                if (!buf) buf = await loadLogoImage(d['保险公司logo']);
                console.log(`[PDF] 保险公司logo加载完成: ${buf ? buf.length + ' bytes' : '失败'}`);
                return buf;
            })(),
            // 加载品牌logo
            (async () => {
                let buf = null;
                // 策略1: 本地
                buf = loadLogoByCompanyName('问界');
                console.log(`[PDF] 品牌策略1(本地): ${buf ? '成功 ' + buf.length + 'bytes' : '失败'}`);
                // 策略2: 图标表
                if (!buf) {
                    console.log(`[PDF] 品牌策略2(图标表): 开始查询...`);
                    buf = await fetchLogoFromIconTable('问界');
                    console.log(`[PDF] 品牌策略2(图标表): ${buf ? '成功 ' + buf.length + 'bytes' : '失败'}`);
                }
                // 策略3: 环境变量
                if (!buf && CAR_BRAND_LOGO_URL) {
                    console.log(`[PDF] 品牌策略3(环境变量): ${CAR_BRAND_LOGO_URL}`);
                    buf = await loadLogoImage(CAR_BRAND_LOGO_URL);
                }
                // 策略4: URL列表
                if (!buf) {
                    const urls = process.env.CAR_BRAND_LOGO_URLS || '';
                    if (urls) console.log(`[PDF] 品牌策略4(URL列表): ${urls}`);
                    buf = await tryLoadFromUrls(urls);
                }
                // 策略5: 飞书字段
                if (!buf) {
                    const logoField = d['问界logo'];
                    console.log(`[PDF] 品牌策略5(飞书字段): 字段值=${logoField ? (typeof logoField === 'string' ? logoField.substring(0,50) : JSON.stringify(logoField).substring(0,50)) : '空'}`);
                    buf = await loadLogoImage(logoField);
                }
                console.log(`[PDF] 品牌logo加载完成: ${buf ? buf.length + ' bytes' : '失败'}`);
                return buf;
            })(),
        ]);

        const insStatus = insuranceLogoBuf ? `OK(${insuranceLogoBuf.length}bytes)` : 'FAIL(将使用文字显示)';
        const brandStatus = carBrandLogoBuf ? `OK(${carBrandLogoBuf.length}bytes)` : 'FAIL(将使用文字显示)';
        console.log(`[PDF] Logo加载最终结果: 保险公司=${insStatus}, 品牌=${brandStatus}`);

        return new Promise((resolve, reject) => {
            const doc = new PDFDocument({
                size: 'A4',
                margins: { top: 25, bottom: 25, left: 30, right: 30 },
                info: {
                    Title: '保险报价确认单',
                    Author: '报价单生成系统',
                },
            });

            const chunks = [];
            doc.on('data', (chunk) => chunks.push(chunk));
            doc.on('end', () => {
                FONT_WORKED = !!CHINESE_FONT;
                resolve(Buffer.concat(chunks));
            });
            doc.on('error', reject);

        // 注册中文字体（尝试加载，失败则使用默认字体）
        let hasChineseFont = false;
        if (CHINESE_FONT) {
            try {
                doc.registerFont('Chinese', CHINESE_FONT);
                doc.font('Chinese');
                hasChineseFont = true;
                console.log(`[PDF] 中文字体加载成功: ${CHINESE_FONT}`);
            } catch (e) {
                console.warn(`[PDF] 中文字体加载失败: ${e.message}，使用默认字体`);
                hasChineseFont = false;
            }
        }

        // 字体辅助函数 - 安全使用字体
        function useFont() {
            if (hasChineseFont) {
                doc.font('Chinese');
                // pdfkit 对 CJK 字体的行高计算有 bug，需手动设置
                doc._font.lineGap = doc._font.lineGap || 0;
            } else {
                doc.font('Helvetica');
            }
        }

        // 设置中文字体行高的辅助函数
        function setFontSize(size) {
            doc.fontSize(size);
            if (hasChineseFont) {
                doc._font.lineGap = size * 0.3;
            }
        }

        const pageWidth = doc.page.width;
        const contentWidth = pageWidth - doc.page.margins.left - doc.page.margins.right;

        // === 颜色方案 ===
        const COLORS = {
            primary: '#1e3c72',       // 深蓝
            accent: '#2a5298',        // 中蓝
            headerBg: '#1e3c72',      // 表头背景
            lightBg: '#f0f4fa',       // 浅蓝背景
            darkText: '#1a1a2e',      // 深色文字
            grayText: '#6b7280',      // 灰色文字
            white: '#ffffff',
            border: '#e2e8f0',       // 边框
            green: '#059669',         // 绿色
            orange: '#ea580c',       // 橙色
            red: '#dc2626',          // 红色
        };

        // === 辅助函数 ===

        /**
         * 根据投保状态构建产品列表
         * 状态规则：
         * - "未投保"：跳过该行，完全不显示
         * - "有险种无分项价"：显示产品名和保额，保费为 "-"
         * - "正常保费"：显示完整信息（产品名+保额+保费）
         */
        function buildItemsByStatus(detail) {
            const d = detail;
            const defs = [
                { name: '交强险', baoE: formatBaoE(d['交强保额']), premium: fm('交强保费'), statusKey: '交强险状态' },
                { name: '车损险', baoE: '—', premium: fm('车损险保费'), statusKey: '车损状态' },
                { name: '新能源车损保全', baoE: '—', premium: fm('非车价格m'), statusKey: '新能源车损保全状态' },
                { name: '三者险', baoE: formatBaoE(d['三者保额']), premium: fm('三者保费'), statusKey: '三者状态' },
                { name: '医保外责任险', baoE: formatBaoE(d['医保外保额']), premium: fm('医保外保费'), statusKey: '医保外状态' },
                { name: '外电网责任险', baoE: '—', premium: fm('外电网保费'), statusKey: '外电网状态' },
                { name: '司机座位险', baoE: formatBaoE(d['司机座位险保额']), premium: fm('司机座位险保费'), statusKey: '司机座位险状态' },
                { name: '乘客座位险', baoE: formatBaoE(d['乘客座位险保额']), premium: fm('乘客座位险保费'), statusKey: '乘客座位险状态' },
                { name: '驾乘意外险', baoE: formatBaoE(d['驾乘意外保额']), premium: fm('驾乘意外保费'), statusKey: '驾乘意外状态' },
                { name: '车船税', baoE: '—', premium: fm('车船税'), statusKey: '车船税状态' },
            ];
            const items = [];
            for (const def of defs) {
                const status = d[def.statusKey] || '正常保费';
                if (status === '未投保') continue;
                if (status === '有险种无分项价') {
                    items.push([def.name, def.baoE, '—']);
                } else {
                    items.push([def.name, def.baoE, def.premium]);
                }
            }
            return items;
        }

        function drawHeader(text, y) {
            doc.save();
            doc.rect(doc.page.margins.left, y - 2, contentWidth, 24).fill(COLORS.headerBg);
            useFont();
            doc.fillColor(COLORS.white); setFontSize(12);
            doc.text(text, doc.page.margins.left + 10, y + 2);
            doc.restore();
            return y + 22;
        }

        function drawRow(label, value, y, isHighlight) {
            const rowH = 20;
            doc.save();
            if (isHighlight) {
                doc.rect(doc.page.margins.left, y - 1, contentWidth, rowH).fill(COLORS.lightBg);
            }
            useFont();
            doc.fillColor(COLORS.darkText); setFontSize(10);
            doc.text(label, doc.page.margins.left + 8, y + 2);
            doc.fillColor(isHighlight ? COLORS.accent : COLORS.darkText);
            if (hasChineseFont) { doc.font('Chinese'); setFontSize(10); } else { doc.font('Helvetica-Bold'); doc.fontSize(10); }
            doc.text(String(value), doc.page.margins.left + contentWidth - 90, y + 2, { width: 80, align: 'right' });
            doc.restore();
            return y + rowH + 1;
        }

        function drawTableRow(cells, y, isHeader) {
            const rowH = 22;
            const colWidths = [contentWidth * 0.4, contentWidth * 0.3, contentWidth * 0.3];

            doc.save();
            let x = doc.page.margins.left;
            for (let i = 0; i < cells.length; i++) {
                const w = colWidths[i];
                if (isHeader) {
                    doc.rect(x, y - 1, w, rowH).fill(COLORS.headerBg);
                    useFont();
                    doc.fillColor(COLORS.white); setFontSize(10);
                } else {
                    const bgColor = i % 2 === 0 ? COLORS.white : COLORS.lightBg;
                    doc.rect(x, y - 1, w, rowH).fill(bgColor);
                    useFont();
                    doc.fillColor(COLORS.darkText); setFontSize(9.5);
                }
                doc.strokeColor(COLORS.border).lineWidth(0.4);
                doc.rect(x, y - 1, w, rowH).stroke();
                doc.text(String(cells[i]), x + 6, y + 2, { width: w - 12, align: i === 2 ? 'right' : 'left' });
                x += w;
            }
            doc.restore();
            return y + rowH;
        }

        function drawSectionTitle(text, y) {
            doc.save();
            useFont();
            doc.fillColor(COLORS.primary); setFontSize(11);
            doc.text(text, doc.page.margins.left, y);
            doc.strokeColor(COLORS.primary).lineWidth(1.2);
            doc.moveTo(doc.page.margins.left, y + 18).lineTo(doc.page.margins.left + 50, y + 18).stroke();
            doc.restore();
            return y + 24;
        }

        function drawSeparator(y) {
            doc.save();
            doc.strokeColor(COLORS.border).lineWidth(0.4);
            doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.margins.left + contentWidth, y).stroke();
            doc.restore();
            return y + 5;
        }

        // === 开始绘制 ===
        let y = doc.page.margins.top;

        // 顶部装饰线
        doc.save();
        doc.rect(doc.page.margins.left, y, contentWidth, 3).fill(COLORS.primary);
        doc.restore();
        y += 10;

        // 绘制 logo（左上角并排：保险公司logo + 问界logo）
        // 使用统一的logo渲染函数，确保尺寸适配、比例正确、位置统一
        const logoResult = drawLogos(doc, {
            y: y,
            companyName: d['保险公司'],
            companyLogoBuf: insuranceLogoBuf,
            brandName: '问界',
            brandLogoBuf: carBrandLogoBuf,
            colors: COLORS,
            useFont: useFont,
            setFontSize: setFontSize,
            getDisplayName: getLogoDisplayName,
            pageMarginLeft: doc.page.margins.left,
            pageMarginRight: doc.page.margins.right,
            pageWidth: doc.page.width,
        });
        y = logoResult.nextY + 10;

        // 主标题
        doc.save();
        useFont();
        doc.fillColor(COLORS.primary); setFontSize(18);
        doc.text('保 险 报 价 确 认 单', doc.page.margins.left, y, { align: 'center', width: contentWidth });
        doc.restore();
        y += 22;

        // 副标题装饰
        doc.save();
        doc.strokeColor(COLORS.accent).lineWidth(0.8);
        doc.moveTo(doc.page.margins.left + contentWidth * 0.25, y).lineTo(doc.page.margins.left + contentWidth * 0.45, y).stroke();
        doc.moveTo(doc.page.margins.left + contentWidth * 0.55, y).lineTo(doc.page.margins.left + contentWidth * 0.75, y).stroke();
        doc.restore();
        y += 8;

        // 基本信息
        y = drawHeader('基 本 信 息', y + 6);
        y = drawRow('承保公司', get('保险公司'), y, false);
        y = drawRow('保单编号', get('保单编号'), y, false);
        y = drawSeparator(y);

        // 客户信息
        y = drawHeader('客 户 信 息', y + 5);
        y = drawRow('客户', get('客户信息'), y, false);
        y = drawRow('车型', get('车型'), y, false);
        y = drawSeparator(y);

        // 保障项目表格
        y = drawHeader('保 障 项 目 明 细', y + 5);
        y += 5;

        // 表头
        y = drawTableRow(['保障项目', '保额', '保费'], y, true);

        // 表格数据（根据投保状态动态生成）
        const items = buildItemsByStatus(d);
        for (const item of items) {
            y = drawTableRow(item, y, false);
        }

        // 新能源车损保全
        y = drawHeader('新能源车损保全（三方案同报）', y + 5);
        y += 5;

        // 方案表头
        y = drawTableRow(['方案', '保障期限', '合计金额'], y, true);

        // 方案数据
        y = drawTableRow(['方案一', '两年期', fm('新能源车损两年期')], y, false);
        y = drawTableRow(['方案二', '三年期', fm('新能源车损三年期')], y, false);
        y = drawTableRow(['方案三', '三年期+（尊享版）', fm('新能源车损三年期+')], y, false);
        y = drawSeparator(y);

        // 底部装饰线
        doc.save();
        doc.rect(doc.page.margins.left, doc.page.height - 20, contentWidth, 3).fill(COLORS.primary);
        doc.restore();

        doc.end();
        });
    })();
}

// ============================================================
// HTTP 响应函数
// ============================================================

/** 发送 JSON 响应 */
function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    res.end(JSON.stringify(data));
}

/** 发送 HTML 响应（用于手机端结果页） */
function sendHtml(res, statusCode, html) {
    res.writeHead(statusCode, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
    });
    res.end(html);
}

/**
 * 生成手机端结果页 HTML（移动端友好、大字号、居中卡片）
 */
function renderResultPage(data) {
    const { ok, title, message, detail, info } = data;
    const icon = ok ? '✅' : '❌';
    const theme = ok
        ? { headerBg: 'linear-gradient(135deg,#10b981,#059669)', border: '#10b981' }
        : { headerBg: 'linear-gradient(135deg,#ef4444,#dc2626)', border: '#ef4444' };

    const infoRows = info
        ? Object.entries(info)
              .map(([k, v]) => `<div class="info-row"><div class="info-label">${k}</div><div class="info-value">${v}</div></div>`)
              .join('')
        : '';
    const infoCard = infoRows
        ? `<div class="info-card"><h4 style="margin:0 0 10px 0; color:#1e3c72;">报价概览</h4>${infoRows}</div>`
        : '';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>${title}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f3f4f6; }
  body { min-height: 100vh; padding: 0 0 40px 0; }
  .header { background: ${theme.headerBg}; color: white; padding: 44px 20px 36px 20px; text-align: center; }
  .header .icon { font-size: 56px; line-height: 1; margin-bottom: 12px; }
  .header h1 { font-size: 22px; font-weight: 700; letter-spacing: 1px; }
  .content { padding: 0 16px; margin-top: -24px; }
  .card { background: white; border-radius: 14px; padding: 22px 18px; box-shadow: 0 6px 20px rgba(0,0,0,0.06); margin-bottom: 16px; border-left: 4px solid ${theme.border}; }
  .message { font-size: 17px; color: #1f2937; font-weight: 600; margin-bottom: 10px; line-height: 1.5; }
  .detail { font-size: 14px; color: #6b7280; line-height: 1.7; word-break: break-all; }
  .info-card { background: white; border-radius: 14px; padding: 18px; box-shadow: 0 6px 20px rgba(0,0,0,0.06); margin-bottom: 16px; }
  .info-row { display: flex; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px dashed #f0f0f0; }
  .info-row:last-child { border-bottom: none; }
  .info-label { font-size: 14px; color: #6b7280; flex-shrink: 0; }
  .info-value { font-size: 15px; color: #111827; font-weight: 600; text-align: right; word-break: break-all; }
  .tip-row { margin-top: 20px; display: flex; align-items: flex-start; gap: 10px; padding: 14px; background: #eff6ff; border-radius: 10px; }
  .tip-row .dot { flex-shrink: 0; width: 8px; height: 8px; border-radius: 50%; margin-top: 7px; background: #3b82f6; }
  .tip-row p { font-size: 13px; color: #1e3a8a; line-height: 1.7; }
  .actions { display: flex; gap: 12px; margin-top: 8px; }
  .btn { flex: 1; text-align: center; padding: 14px 16px; border-radius: 12px; font-size: 16px; font-weight: 600; text-decoration: none; display: block; transition: transform 0.1s; }
  .btn:active { transform: scale(0.97); }
  .btn-primary { background: linear-gradient(135deg,#3b82f6,#2563eb); color: white; box-shadow: 0 6px 14px rgba(37,99,235,0.28); }
  .btn-secondary { background: white; color: #374151; border: 1px solid #d1d5db; }
  .footer { text-align: center; color: #9ca3af; font-size: 12px; margin-top: 20px; }
</style>
</head>
<body>
  <div class="header">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
  </div>
  <div class="content">
    <div class="card">
      <div class="message">${message}</div>
      ${detail ? `<div class="detail">${detail}</div>` : ''}
    </div>
    ${infoCard}
    <div class="tip-row">
      <div class="dot"></div>
      <p>${ok ? '请返回飞书，打开该保单记录详情，在"报价单附件"字段中即可查看完整报价单。<br>若附件未立即显示，请下拉刷新当前记录页。' : '请稍后重新点击"生成报价单"按钮重试。若持续失败，请联系管理员检查后端服务状态。'}</p>
    </div>
    <div class="actions">
      <a class="btn btn-secondary" href="javascript:history.back();">← 返回上一页</a>
      ${ok ? '' : '<button class="btn btn-primary" onclick="location.reload();" style="border:none;cursor:pointer;">🔄 重新生成</button>'}
    </div>
    <div class="footer">报价单生成系统 · ${new Date().toLocaleString('zh-CN')}</div>
  </div>
</body>
</html>`;
}

/** 静态文件服务 */
function serveStatic(req, res) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let filePath = url.pathname === '/' ? '/quotation.html' : url.pathname;
    filePath = path.join(__dirname, decodeURIComponent(filePath));

    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 Not Found');
        } else {
            const ext = path.extname(filePath).toLowerCase();
            const contentTypes = {
                '.html': 'text/html; charset=utf-8',
                '.js': 'application/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8',
                '.json': 'application/json; charset=utf-8',
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.svg': 'image/svg+xml',
            };
            const headers = {
                'Content-Type': contentTypes[ext] || 'application/octet-stream',
                'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
                'Pragma': 'no-cache',
                'Expires': '0',
            };
            res.writeHead(200, headers);
            res.end(data);
        }
    });
}

// ============================================================
// 核心业务逻辑：生成报价单并上传飞书
// ============================================================

/**
 * 异步生成报价单 PDF 并上传到飞书"报价单附件"字段
 * 流程：获取记录 → pdfkit 生成精美 PDF → 上传飞书附件 → 更新记录
 * @param {string} recordId 飞书记录ID
 * @returns {Promise<{ok:boolean, detail?:object, file_name?:string, error?:string}>}
 */
async function generateAndUpload(recordId, policyNumber) {
    // 1. 获取记录（自动判断是 record_id 还是保单编号）
    let openApiRecord = null;
    let actualRecordId = recordId;

    const lookupValue = policyNumber || recordId;

    if (lookupValue) {
        console.log(`[调试] lookupValue="${lookupValue}" length=${lookupValue.length}`);
        const cleanedValue = lookupValue.replace(/^[\(\[\{\"]+/, '').replace(/[\)\]\}\"]+$/, '');
        console.log(`[调试] cleanedValue="${cleanedValue}" length=${cleanedValue.length}`);

        const isRecordId = cleanedValue.startsWith('recv');

        if (isRecordId) {
            openApiRecord = await feishu.getRecord(BASE_TOKEN, TABLE_ID, cleanedValue);
            if (openApiRecord) {
                actualRecordId = openApiRecord.record_id;
            }
        } else {
            openApiRecord = await feishu.getRecordByPolicyNumber(BASE_TOKEN, TABLE_ID, cleanedValue);
            if (openApiRecord) {
                actualRecordId = openApiRecord.record_id;
            }
        }
    }

    if (!openApiRecord) {
        return { ok: false, error: `未找到记录: ${lookupValue}` };
    }

    // 2. 适配记录格式并构建详情
    const record = adaptRecord(openApiRecord);
    const detail = buildRecordDetail(record);

    // 3. 使用 pdfkit 生成本地精美 PDF（无需飞书文档权限）
    console.log(`[生成] 正在生成 PDF...`);
    const pdfBuffer = await generatePdf(detail);
    console.log(`[生成] PDF 生成成功，大小 ${(pdfBuffer.length / 1024).toFixed(1)} KB`);

    // 4. 上传 PDF 到飞书云空间
    const fileName = `报价单_${detail['保单编号'] || Date.now()}.pdf`;
    console.log(`[生成] 正在上传 ${fileName} 到飞书...`);
    const fileToken = await feishu.uploadMedia(BASE_TOKEN, fileName, pdfBuffer);
    console.log(`[生成] 上传成功 file_token=${fileToken}`);

    // 5. 更新记录附件字段（覆盖式）
    await feishu.updateRecordAttachment(BASE_TOKEN, TABLE_ID, actualRecordId, fileToken, '报价单附件');
    console.log(`[生成] ✅ 完成！`);

    return { ok: true, detail, file_name: fileName };
}

// ============================================================
// HTTP 服务器
// ============================================================

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // CORS 预检
    if (req.method === 'OPTIONS') {
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
    }

    // GET /api/generate — 手机端按钮触发，生成报价单，返回结果页
    if (req.method === 'GET' && url.pathname === '/api/generate') {
        const recordId = url.searchParams.get('record_id');
        const policyNumber = url.searchParams.get('policy_number');

        if (!recordId && !policyNumber) {
            sendHtml(res, 400, renderResultPage({
                ok: false,
                title: '参数缺失',
                message: '缺少 record_id 或 policy_number 参数',
                detail: '请通过飞书多维表格的"生成报价单"按钮访问',
            }));
            return;
        }

        console.log(`[生成] record_id=${recordId}, policy_number=${policyNumber} 开始...`);
        const startTime = Date.now();

        try {
            const result = await generateAndUpload(recordId, policyNumber);
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);

            if (result.ok) {
                const d = result.detail;
                console.log(`[生成] ✅ 成功 ${duration}s: ${d['保单编号']} (${d['客户信息']})`);
                sendHtml(res, 200, renderResultPage({
                    ok: true,
                    title: '报价单已生成',
                    message: '✅ 报价单已成功保存到飞书"报价单附件"字段',
                    detail: `文件：${result.file_name}，耗时 ${duration}s。请返回飞书记录详情查看附件。`,
                    info: {
                        '客户信息': d['客户信息'] || '—',
                        '保单编号': d['保单编号'] || '—',
                        '承保公司': d['保险公司'] || '—',
                        '新能源车损保全（两年期）': formatMoney(d['新能源车损两年期']),
                        '新能源车损保全（三年期）': formatMoney(d['新能源车损三年期']),
                        '新能源车损保全（三年期+尊享版）': formatMoney(d['新能源车损三年期+']),
                    },
                }));
            } else {
                console.log(`[生成] ❌ 失败: ${result.error}`);
                sendHtml(res, 500, renderResultPage({
                    ok: false,
                    title: '生成失败',
                    message: result.error || '生成报价单时发生错误',
                    detail: '请稍后重试',
                }));
            }
        } catch (e) {
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            console.error(`[生成] ❌ 异常 ${duration}s:`, e.message);
            sendHtml(res, 500, renderResultPage({
                ok: false,
                title: '系统异常',
                message: '生成过程中出现异常',
                detail: e.message || '请稍后重试或联系管理员',
            }));
        }
        return;
    }

    // GET /api/records — 获取记录列表（JSON）
    if (req.method === 'GET' && url.pathname === '/api/records') {
        try {
            const rawRecords = await feishu.searchRecords(BASE_TOKEN, TABLE_ID);
            const records = rawRecords.map(r => {
                const adapted = adaptRecord(r);
                return {
                    record_id: adapted._record_id,
                    '保单编号': adapted['保单编号'] || '',
                    '客户信息': adapted['客户信息'] || '',
                    '车型': adapted['车型'] || '',
                    '保险公司': adapted['保险公司'] || '',
                    '保险公司保费': toNumber(adapted['保险公司保费']),
                };
            });
            sendJson(res, 200, { ok: true, count: records.length, records });
        } catch (e) {
            sendJson(res, 500, { ok: false, error: e.message });
        }
        return;
    }

    // GET /api/record — 获取单条记录详情（JSON）
    if (req.method === 'GET' && url.pathname === '/api/record') {
        const recordId = url.searchParams.get('record_id');
        if (!recordId) {
            sendJson(res, 400, { ok: false, error: '缺少 record_id 参数' });
            return;
        }
        try {
            const rawRecord = await feishu.getRecord(BASE_TOKEN, TABLE_ID, recordId);
            if (!rawRecord) {
                sendJson(res, 404, { ok: false, error: `未找到记录: ${recordId}` });
                return;
            }
            const record = adaptRecord(rawRecord);
            sendJson(res, 200, { ok: true, record: buildRecordDetail(record) });
        } catch (e) {
            sendJson(res, 500, { ok: false, error: e.message });
        }
        return;
    }

    // GET /health — 健康检查（Render 用于检测服务状态）
    if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, status: 'running', time: new Date().toISOString() });
        return;
    }

    // GET /debug/icon-table — 图标表结构诊断（查看图标表记录和字段结构）
    if (req.method === 'GET' && url.pathname === '/debug/icon-table') {
        (async () => {
            if (!BASE_TOKEN || !ICON_TABLE_ID) {
                sendJson(res, 400, { error: 'BASE_TOKEN或ICON_TABLE_ID未设置', BASE_TOKEN: !!BASE_TOKEN, ICON_TABLE_ID });
                return;
            }
            try {
                const { searchRecords } = require('./feishu-api');
                const records = await searchRecords(BASE_TOKEN, ICON_TABLE_ID);
                
                const result = {
                    iconTableId: ICON_TABLE_ID,
                    baseToken: BASE_TOKEN ? BASE_TOKEN.substring(0, 10) + '...' : null,
                    totalRecords: records.length,
                    records: records.map(r => {
                        const fields = r.fields || {};
                        const fieldInfo = {};
                        for (const [key, val] of Object.entries(fields)) {
                            if (Array.isArray(val) && val.length > 0 && val[0]?.file_token) {
                                // 附件字段
                                fieldInfo[key] = {
                                    type: 'attachment',
                                    fileToken: val[0].file_token,
                                    fileName: val[0].name,
                                    fileSize: val[0].size,
                                    fileType: val[0].type,
                                };
                            } else {
                                // 文本字段
                                fieldInfo[key] = {
                                    type: 'text',
                                    value: normalizeFieldValueToString(val),
                                };
                            }
                        }
                        return { recordId: r.record_id, fields: fieldInfo };
                    }),
                };
                sendJson(res, 200, result);
            } catch (e) {
                sendJson(res, 500, { error: e.message });
            }
        })().catch(e => sendJson(res, 500, { error: e.message }));
        return;
    }

    // GET /debug/font — 字体调试
    if (req.method === 'GET' && url.pathname === '/debug/font') {
        const fontDebug = {
            CHINESE_FONT,
            fontExists: null,
            fontSize: null,
            fontLoadTest: null,
            checkedPaths: [],
            dirname: __dirname,
        };
        for (const fp of candidateFonts) {
            const exists = fs.existsSync(fp);
            const stat = exists ? fs.statSync(fp) : null;
            fontDebug.checkedPaths.push({ path: fp, exists, size: stat ? stat.size : null });
        }
        if (CHINESE_FONT && fs.existsSync(CHINESE_FONT)) {
            try {
                const PDFDocument = require('pdfkit');
                const testDoc = new PDFDocument();
                testDoc.registerFont('Chinese', CHINESE_FONT);
                testDoc.font('Chinese');
                testDoc.fontSize(12);
                fontDebug.fontLoadTest = 'OK';
                testDoc.end();
            } catch (e) {
                fontDebug.fontLoadTest = 'FAIL: ' + e.message;
            }
        } else if (CHINESE_FONT) {
            fontDebug.fontLoadTest = 'SKIP: font file not found';
        } else {
            fontDebug.fontLoadTest = 'SKIP: no font path set';
        }
        sendJson(res, 200, fontDebug);
        return;
    }

    // GET /debug/logos — Logo 诊断端点
    if (req.method === 'GET' && url.pathname === '/debug/logos') {
        const logosDebug = {
            // Logo映射表信息
            logoMapping: LOGO_MAP.map(m => ({
                name: m.name,
                file: m.file,
                fileToken: m.fileToken || null,
                fileTokenPrefix: m.fileToken ? m.fileToken.substring(0, 15) + '...' : null,
                keywords: m.keywords,
                localFileExists: (() => {
                    const p = path.join(__dirname, 'logos', m.file);
                    return fs.existsSync(p);
                })(),
            })),
            // 环境变量配置
            envConfig: {
                INSURANCE_LOGO_URL: INSURANCE_LOGO_URL || '(未设置)',
                CAR_BRAND_LOGO_URL: CAR_BRAND_LOGO_URL || '(未设置)',
                INSURANCE_LOGO_URLS: process.env.INSURANCE_LOGO_URLS || '(未设置)',
                CAR_BRAND_LOGO_URLS: process.env.CAR_BRAND_LOGO_URLS || '(未设置)',
                ICON_TABLE_ID: ICON_TABLE_ID || '(未设置)',
                FEISHU_APP_ID: process.env.FEISHU_APP_ID ? '已设置' : '(未设置)',
                FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET ? '已设置' : '(未设置)',
            },
            // Logos目录内容
            logosDir: {
                path: path.join(__dirname, 'logos'),
                exists: fs.existsSync(path.join(__dirname, 'logos')),
                files: (() => {
                    const dir = path.join(__dirname, 'logos');
                    if (!fs.existsSync(dir)) return [];
                    return fs.readdirSync(dir)
                        .filter(f => f !== 'README.md')
                        .map(f => {
                            const fp = path.join(dir, f);
                            const stat = fs.statSync(fp);
                            return { name: f, size: stat.size };
                        });
                })(),
            },
            // 测试匹配
            testMatches: [
                { test: '中国平安财产保险股份有限公司', match: getLogoDisplayName('中国平安财产保险股份有限公司') },
                { test: '中国人寿财产保险股份有限公司', match: getLogoDisplayName('中国人寿财产保险股份有限公司') },
                { test: '中国太平洋财产保险股份有限公司', match: getLogoDisplayName('中国太平洋财产保险股份有限公司') },
                { test: '中国人民财产保险股份有限公司', match: getLogoDisplayName('中国人民财产保险股份有限公司') },
                { test: '太平财产保险有限公司', match: getLogoDisplayName('太平财产保险有限公司') },
                { test: '中华联合财产保险股份有限公司', match: getLogoDisplayName('中华联合财产保险股份有限公司') },
                { test: '问界AITO', match: getLogoDisplayName('问界AITO') },
                { test: '鸿蒙HarmonyOS', match: getLogoDisplayName('鸿蒙HarmonyOS') },
                { test: '平安产险', match: getLogoDisplayName('平安产险') },
                { test: '人保', match: getLogoDisplayName('人保') },
                { test: '太保', match: getLogoDisplayName('太保') },
            ],
            // 功能说明
            features: {
                localFileSupport: '✅ 本地logos目录自动加载',
                iconTableSupport: '✅ 飞书图标表查询自动下载（主要方式）',
                autoCache: '✅ 下载后自动缓存到本地',
                textFallback: '✅ 加载失败降级为文字显示',
            },
            // 建议
            suggestions: [
                `1. 系统已配置图标表ID: ${ICON_TABLE_ID}，会自动查询图标表下载logo`,
                '2. 确保FEISHU_APP_ID、FEISHU_APP_SECRET、BASE_TOKEN已配置',
                '3. 确保飞书应用有bitable:app:readonly和drive:drive:readonly权限',
                '4. 确保应用已被添加为多维表格的协作者',
                '5. 访问 /debug/icon-table 查看图标表结构和字段',
                '6. 下载的logo会自动缓存到logos/目录，后续无需重复下载',
            ],
        };
        sendJson(res, 200, logosDebug);
        return;
    }

    // GET /debug/logos/clean — 清理无效logo缓存
    if (req.method === 'GET' && url.pathname === '/debug/logos/clean') {
        (async () => {
            const logosDir = path.join(__dirname, 'logos');
            const cleaned = [];
            if (fs.existsSync(logosDir)) {
                const files = fs.readdirSync(logosDir);
                for (const file of files) {
                    const filePath = path.join(logosDir, file);
                    const stat = fs.statSync(filePath);
                    if (stat.size < 20) {
                        fs.unlinkSync(filePath);
                        cleaned.push({ file, size: stat.size, removed: true });
                    } else {
                        cleaned.push({ file, size: stat.size, removed: false });
                    }
                }
            }
            sendJson(res, 200, { 
                message: 'Logo缓存清理完成', 
                cleaned,
                totalFiles: cleaned.length,
                removedCount: cleaned.filter(c => c.removed).length,
            });
        })().catch(e => sendJson(res, 500, { error: e.message }));
        return;
    }

    // GET /debug/logos/test — 测试图标表logo下载（带详细诊断）v2
    if (req.method === 'GET' && url.pathname === '/debug/logos/test') {
        (async () => {
            const testCompanies = ['中国平安', '中国人寿', '中国太平洋', '中国人保', '太平保险', '中华联合', '问界'];
            const results = [];
            console.log('[Logo测试] ===== 开始详细诊断 v2 =====');

            for (const company of testCompanies) {
                console.log(`[Logo测试] ====== 测试 ${company} ======`);
                let result = {
                    company,
                    mapping: findLogoMapping(company)?.name || null,
                    success: false,
                    bufferSize: 0,
                    steps: [],
                    error: null,
                };

                try {
                    // 步骤1: 本地
                    const localBuf = loadLogoByCompanyName(company);
                    result.steps.push({ step: '本地文件', success: !!localBuf, size: localBuf?.length || 0 });
                    if (localBuf) {
                        result.success = true;
                        result.bufferSize = localBuf.length;
                        result.source = 'local';
                        results.push(result);
                        continue;
                    }

                    // 步骤2: 查询图标表
                    console.log(`[Logo测试] 查询图标表: BASE_TOKEN=${BASE_TOKEN?.substring(0,10)}..., ICON_TABLE_ID=${ICON_TABLE_ID}`);
                    const { searchRecords, getTenantToken } = require('./feishu-api');
                    let records = [];
                    try {
                        records = await searchRecords(BASE_TOKEN, ICON_TABLE_ID);
                        console.log(`[Logo测试] 图标表查询成功: ${records.length} 条记录`);
                    } catch (e) {
                        console.error(`[Logo测试] 图标表查询失败: ${e.message}`);
                        result.error = `图标表查询失败: ${e.message}`;
                        results.push(result);
                        continue;
                    }
                    result.steps.push({ step: '查询图标表', recordsFound: records.length });

                    const mapping = findLogoMapping(company);
                    if (!mapping) {
                        result.error = '无关键词映射';
                        results.push(result);
                        continue;
                    }

                    // 步骤3: 遍历记录找匹配
                    let matchedRecord = null;
                    let attachmentToken = null;
                    let attachmentInfo = null;
                    for (const record of records) {
                        const fields = record.fields || {};
                        let nameMatched = false;
                        for (const [fieldName, fieldValue] of Object.entries(fields)) {
                            if (Array.isArray(fieldValue) && fieldValue.length > 0 && fieldValue[0]?.file_token) continue;
                            const textValue = normalizeFieldValueToString(fieldValue);
                            if (!textValue) continue;
                            for (const keyword of mapping.keywords) {
                                if (textValue.includes(keyword)) {
                                    nameMatched = true;
                                    break;
                                }
                            }
                            if (nameMatched) break;
                        }
                        if (nameMatched) {
                            matchedRecord = record;
                            // 找附件
                            for (const [fieldName, fieldValue] of Object.entries(fields)) {
                                if (!Array.isArray(fieldValue) || fieldValue.length === 0) continue;
                                const first = fieldValue[0];
                                if (first && first.file_token) {
                                    attachmentToken = first.file_token;
                                    attachmentInfo = { field: fieldName, name: first.name, size: first.size, type: first.type };
                                    break;
                                }
                            }
                            break;
                        }
                    }
                    result.steps.push({ step: '匹配+查找附件', matched: !!matchedRecord, attachment: attachmentInfo, token: attachmentToken?.substring(0, 20) });

                    if (!attachmentToken) {
                        result.error = '未找到附件';
                        results.push(result);
                        continue;
                    }

                    // 步骤4: 使用loadLogoImage下载（已支持extra参数）
                    console.log(`[Logo测试] 下载logo: token=${attachmentToken?.substring(0,20)}..., name=${attachmentInfo?.name}`);
                    const buf = await loadLogoImage([{ file_token: attachmentToken, name: attachmentInfo?.name, type: attachmentInfo?.type }]);
                    console.log(`[Logo测试] 下载结果: buf=${buf ? buf.length + ' bytes' : 'null'}`);

                    if (buf && buf.length >= 20) {
                        result.success = true;
                        result.bufferSize = buf.length;
                        result.source = 'icon-table';
                        result.steps.push({ step: '下载', success: true, size: buf.length });
                    } else {
                        // 下载失败，手动测试extra参数效果
                        const tenantToken = await getTenantToken();
                        const testResults = [];
                        const extraTests = [
                            { label: 'extra+ICON_TABLE', extra: `{"bitablePerm":{"tableId":"${ICON_TABLE_ID}","rev":0}}` },
                            { label: 'extra+TABLE_ID', extra: TABLE_ID ? `{"bitablePerm":{"tableId":"${TABLE_ID}","rev":0}}` : null },
                            { label: '无extra', extra: null },
                        ];
                        for (const test of extraTests) {
                            if (test.extra === null && test.label !== '无extra') continue;
                            try {
                                const durl = test.extra
                                    ? `https://open.feishu.cn/open-apis/drive/v1/medias/${attachmentToken}/download?extra=${encodeURIComponent(test.extra)}`
                                    : `https://open.feishu.cn/open-apis/drive/v1/medias/${attachmentToken}/download`;
                                const resp = await fetch(durl, { headers: { 'Authorization': `Bearer ${tenantToken}` } });
                                const info = { label: test.label, status: resp.status };
                                if (resp.ok) {
                                    const b = Buffer.from(await resp.arrayBuffer());
                                    info.size = b.length;
                                } else {
                                    try { info.body = (await resp.text()).substring(0, 200); } catch(e) {}
                                }
                                testResults.push(info);
                            } catch(e) {
                                testResults.push({ label: test.label, error: e.message });
                            }
                        }
                        result.steps.push({ step: '下载', success: false, tests: testResults });
                        result.error = '下载失败';
                    }
                } catch (e) {
                    result.error = e.message;
                    result.steps.push({ step: '异常', error: e.message });
                }

                results.push(result);
            }

            const successCount = results.filter(r => r.success).length;
            sendJson(res, 200, {
                total: results.length,
                successCount,
                failCount: results.length - successCount,
                results,
            });
        })().catch(e => {
            sendJson(res, 500, { error: e.message });
        });
        return;
    }

    // 静态文件服务
    serveStatic(req, res);
});

// 启动服务器
server.listen(PORT, '0.0.0.0', () => {
    const banner = '='.repeat(55);
    console.log(banner);
    console.log('  报价单生成系统 - 云端版 (Node.js)');
    console.log(banner);
    console.log();
    console.log(`  监听端口: ${PORT}`);
    console.log(`  访问地址: ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}`);
    console.log();
    console.log('  API 接口:');
    console.log('    GET /api/generate?record_id=xxx  生成报价单（手机按钮触发）');
    console.log('    GET /api/records                 获取记录列表');
    console.log('    GET /api/record?record_id=xxx    获取单条记录');
    console.log('    GET /health                      健康检查');
    console.log('    GET /debug/font                  字体诊断');
    console.log('    GET /debug/logos                 Logo诊断');
    console.log('    GET /debug/logos/test            Logo下载测试');
    console.log('    GET /debug/icon-table            图标表结构诊断');
    console.log();
    console.log('  飞书表格按钮字段 URL 配置:');
    console.log(`    ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/api/generate?record_id={{记录ID}}`);
    console.log();
    console.log('  Logo 配置:');
    console.log(`    本地logo目录: ${path.join(__dirname, 'logos')}`);
    console.log(`    图标表ID: ${ICON_TABLE_ID}`);
    console.log(`    保险公司logo URL: ${INSURANCE_LOGO_URL || '(未设置)'}`);
    console.log(`    品牌logo URL: ${CAR_BRAND_LOGO_URL || '(未设置)'}`);
    console.log();
    console.log(banner);
    console.log();
});
