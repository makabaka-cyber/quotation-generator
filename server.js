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

const PORT = process.env.PORT || 8000;
const BASE_TOKEN = process.env.BASE_TOKEN || 'Dt4kbDdd1a6OtkstVLXcLJjlneG';
const TABLE_ID = process.env.TABLE_ID || 'tbluIyiU5i19TeqH';

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

/** 保额格式化：去掉￥符号，数值单位为万 */
function formatBaoE(n) {
    const num = toNumber(n);
    return num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '万';
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
        '保险公司logo': record['保险公司logo'] || '',
        '保单编号': record['保单编号'] || '',
        '交强保费': toNumber(record['交强保费']),
        '车船税': toNumber(record['车船税']),
        '车损险保费': toNumber(record['车损险保费']),
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
        { name: '交强险', baoE: '—', premium: fm('交强保费'), statusKey: '交强险状态' },
        { name: '车损险', baoE: '—', premium: fm('车损险保费'), statusKey: '车损状态' },
        { name: '新能源车损保全', baoE: '—', premium: fm('非车价格m'), statusKey: '新能源车损保全状态' },
        { name: '三者险', baoE: formatBaoE(d['三者保额']), premium: fm('三者保费'), statusKey: '三者状态' },
        { name: '医保外责任险', baoE: '—', premium: fm('医保外保费'), statusKey: '医保外状态' },
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
    t += `  商业险合计                    ${fm('商业险合计')}\n`;
    t += '\n';
    t += '【新能源车损保全（三方案同报）】\n';
    t += dash2 + '\n';
    t += `  两年期          ${formatMoney(d['非车价格m'])}     ${fm('新能源车损两年期')}\n`;
    t += `  三年期          ${formatMoney(d['非车价格u'])}     ${fm('新能源车损三年期')}\n`;
    t += `  三年期+（尊享版）${formatMoney(d['非车价格u+'])}    ${fm('新能源车损三年期+')}\n`;
    t += dash2 + '\n';
    t += '\n';
    t += '【费用汇总】\n';
    t += dash + '\n';
    t += `  交强保费：${fm('交强保费')}\n`;
    t += `  车船税：${fm('车船税')}\n`;
    t += `  驾乘意外保费：${fm('驾乘意外保费')}\n`;
    t += `  保险公司保费（交强+商业+驾乘）：${formatMoney(insuranceTotal)}\n`;
    t += '\n';
    t += dash + '\n';
    t += '  方案一 · 新能源车损保全（两年期）\n';
    t += `    合计：${fm('新能源车损两年期')}\n`;
    t += '\n';
    t += '  方案二 · 新能源车损保全（三年期）\n';
    t += `    合计：${fm('新能源车损三年期')}\n`;
    t += '\n';
    t += '  方案三 · 新能源车损保全（三年期+ 尊享版）\n';
    t += `    合计：${fm('新能源车损三年期+')}\n`;
    t += '\n';
    t += line + '\n';
    t += '本报价单仅供参考，最终以正式保单为准\n';
    t += `生成时间：${new Date().toLocaleString('zh-CN')}\n`;

    return t;
}

/**
 * 使用 pdfkit 生成精美 PDF 报价单
 * 严格遵循约束：不含"安心包"/"非车"字样，统一为"新能源车损保全"
 * @param {object} detail 记录详情（buildRecordDetail 返回值）
 * @returns {Promise<Buffer>} PDF 文件 Buffer
 */
function generatePdf(detail) {
    return new Promise((resolve, reject) => {
        const d = detail || {};
        const get = (k) => (d[k] !== undefined && d[k] !== null && d[k] !== '') ? d[k] : '—';
        const fm = (k) => formatMoney(d[k]);

        const doc = new PDFDocument({
            size: 'A4',
            margins: { top: 50, bottom: 50, left: 45, right: 45 },
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
                // CJK 字体行高 = 字号 * 1.4（经验值）
                doc._font.lineGap = size * 0.4;
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
                { name: '交强险', baoE: '—', premium: fm('交强保费'), statusKey: '交强险状态' },
                { name: '车损险', baoE: '—', premium: fm('车损险保费'), statusKey: '车损状态' },
                { name: '新能源车损保全', baoE: '—', premium: fm('非车价格m'), statusKey: '新能源车损保全状态' },
                { name: '三者险', baoE: formatBaoE(d['三者保额']), premium: fm('三者保费'), statusKey: '三者状态' },
                { name: '医保外责任险', baoE: '—', premium: fm('医保外保费'), statusKey: '医保外状态' },
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
            doc.rect(doc.page.margins.left, y - 4, contentWidth, 32).fill(COLORS.headerBg);
            useFont();
            doc.fillColor(COLORS.white); setFontSize(14);
            doc.text(text, doc.page.margins.left + 12, y + 2);
            doc.restore();
            return y + 34;
        }

        function drawRow(label, value, y, isHighlight) {
            const rowH = 24;
            doc.save();
            if (isHighlight) {
                doc.rect(doc.page.margins.left, y - 2, contentWidth, rowH).fill(COLORS.lightBg);
            }
            useFont();
            doc.fillColor(COLORS.darkText); setFontSize(11);
            doc.text(label, doc.page.margins.left + 10, y + 2);
            doc.fillColor(isHighlight ? COLORS.accent : COLORS.darkText);
            if (hasChineseFont) { doc.font('Chinese'); setFontSize(11); } else { doc.font('Helvetica-Bold'); doc.fontSize(11); }
            doc.text(String(value), doc.page.margins.left + contentWidth - 100, y + 2, { width: 90, align: 'right' });
            doc.restore();
            return y + rowH + 2;
        }

        function drawTableRow(cells, y, isHeader) {
            const rowH = 26;
            const colWidths = [contentWidth * 0.4, contentWidth * 0.3, contentWidth * 0.3];

            doc.save();
            let x = doc.page.margins.left;
            for (let i = 0; i < cells.length; i++) {
                const w = colWidths[i];
                // 背景
                if (isHeader) {
                    doc.rect(x, y - 2, w, rowH).fill(COLORS.headerBg);
                    useFont();
                    doc.fillColor(COLORS.white); setFontSize(11);
                } else {
                    const bgColor = i % 2 === 0 ? COLORS.white : COLORS.lightBg;
                    doc.rect(x, y - 2, w, rowH).fill(bgColor);
                    useFont();
                    doc.fillColor(COLORS.darkText); setFontSize(10.5);
                }
                // 边框
                doc.strokeColor(COLORS.border).lineWidth(0.5);
                doc.rect(x, y - 2, w, rowH).stroke();
                // 文字
                doc.text(String(cells[i]), x + 8, y + 2, { width: w - 16, align: i === 2 ? 'right' : 'left' });
                x += w;
            }
            doc.restore();
            return y + rowH;
        }

        function drawSectionTitle(text, y) {
            doc.save();
            useFont();
            doc.fillColor(COLORS.primary); setFontSize(13);
            doc.text(text, doc.page.margins.left, y);
            doc.strokeColor(COLORS.primary).lineWidth(1.5);
            doc.moveTo(doc.page.margins.left, y + 22).lineTo(doc.page.margins.left + 60, y + 22).stroke();
            doc.restore();
            return y + 30;
        }

        function drawSeparator(y) {
            doc.save();
            doc.strokeColor(COLORS.border).lineWidth(0.5);
            doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.margins.left + contentWidth, y).stroke();
            doc.restore();
            return y + 8;
        }

        // === 开始绘制 ===
        let y = doc.page.margins.top;

        // 顶部装饰线
        doc.save();
        doc.rect(doc.page.margins.left, y, contentWidth, 4).fill(COLORS.primary);
        doc.restore();
        y += 14;

        // 主标题
        doc.save();
        useFont();
        doc.fillColor(COLORS.primary); setFontSize(22);
        doc.text('保 险 报 价 确 认 单', { align: 'center', width: contentWidth });
        doc.restore();
        y += 30;

        // 副标题装饰
        doc.save();
        doc.strokeColor(COLORS.accent).lineWidth(1);
        doc.moveTo(doc.page.margins.left + contentWidth * 0.25, y).lineTo(doc.page.margins.left + contentWidth * 0.45, y).stroke();
        doc.moveTo(doc.page.margins.left + contentWidth * 0.55, y).lineTo(doc.page.margins.left + contentWidth * 0.75, y).stroke();
        doc.restore();
        y += 12;

        // 基本信息
        y = drawHeader('基 本 信 息', y + 10);
        y = drawRow('承保公司', get('保险公司'), y, false);
        y = drawRow('保单编号', get('保单编号'), y, false);
        y = drawSeparator(y);

        // 客户信息
        y = drawHeader('客 户 信 息', y + 8);
        y = drawRow('客户', get('客户信息'), y, false);
        y = drawRow('车型', get('车型'), y, false);
        y = drawSeparator(y);

        // 保障项目表格
        y = drawHeader('保 障 项 目 明 细', y + 8);
        y += 8;

        // 表头
        y = drawTableRow(['保障项目', '保额', '保费'], y, true);

        // 表格数据（根据投保状态动态生成）
        const items = buildItemsByStatus(d);
        for (const item of items) {
            y = drawTableRow(item, y, false);
        }

        // 商业险合计
        y += 6;
        y = drawRow('商业险合计', fm('商业险合计'), y, true);
        y = drawSeparator(y);

        // 新能源车损保全
        y = drawHeader('新能源车损保全（三方案同报）', y + 8);
        y += 8;

        // 方案表头
        y = drawTableRow(['方案', '保障期限', '合计金额'], y, true);

        // 方案数据
        y = drawTableRow(['方案一', '两年期', fm('新能源车损两年期')], y, false);
        y = drawTableRow(['方案二', '三年期', fm('新能源车损三年期')], y, false);
        y = drawTableRow(['方案三', '三年期+（尊享版）', fm('新能源车损三年期+')], y, false);
        y = drawSeparator(y);

        // 费用汇总
        y = drawHeader('费 用 汇 总', y + 8);
        y += 8;

        y = drawRow('交强保费', fm('交强保费'), y, false);
        y = drawRow('车船税', fm('车船税'), y, false);
        y = drawRow('驾乘意外保费', fm('驾乘意外保费'), y, false);
        y = drawRow('保险公司保费（交强+商业+驾乘）', formatMoney(toNumber(d['保险公司保费'])), y, true);
        y = drawSeparator(y);

        // 方案合计总览
        y = drawSectionTitle('三方案总价对比', y);
        y += 6;

        // 方案对比表头
        y = drawTableRow(['方案', '保障期限', '总价'], y, true);
        y = drawTableRow(['方案一', '新能源车损保全（两年期）', fm('新能源车损两年期')], y, false);
        y = drawTableRow(['方案二', '新能源车损保全（三年期）', fm('新能源车损三年期')], y, false);
        y = drawTableRow(['方案三', '新能源车损保全（三年期+尊享版）', fm('新能源车损三年期+')], y, false);
        y = drawSeparator(y);

        // 底部说明
        y += 10;
        doc.save();
        useFont();
        doc.fillColor(COLORS.grayText); setFontSize(9);
        doc.text('本报价单仅供参考，最终以正式保单为准', doc.page.margins.left, y, { align: 'left' });
        y += 16;
        doc.text(`生成时间：${new Date().toLocaleString('zh-CN')}`, doc.page.margins.left, y);
        doc.restore();

        // 底部装饰线
        doc.save();
        doc.rect(doc.page.margins.left, doc.page.height - 20, contentWidth, 3).fill(COLORS.primary);
        doc.restore();

        doc.end();
    });
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
    console.log();
    console.log('  飞书表格按钮字段 URL 配置:');
    console.log(`    ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/api/generate?record_id={{记录ID}}`);
    console.log();
    console.log(banner);
    console.log();
});
