#!/usr/bin/env node
/**
 * 从飞书图标表下载 logo 到本地 logos/ 目录
 * 使用方法: node download-logos.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// 环境变量
const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const BASE_TOKEN = process.env.BASE_TOKEN || 'Dt4kbDdd1a6OtkstVLXcLJjlneG';
const ICON_TABLE_ID = process.env.ICON_TABLE_ID || 'tblqZ84MplpY2sTr';

const LOGOS_DIR = path.join(__dirname, 'logos');

// 从命令行参数或环境变量读取
const args = process.argv.slice(2);
function getArg(name, envName) {
    const idx = args.findIndex(a => a.startsWith(name + '='));
    if (idx >= 0) return args[idx].substring(name.length + 1);
    return process.env[envName] || '';
}

const APP_ID = getArg('app_id', 'FEISHU_APP_ID');
const APP_SECRET = getArg('app_secret', 'FEISHU_APP_SECRET');
const BASE_TOKEN = getArg('base_token', 'BASE_TOKEN') || 'Dt4kbDdd1a6OtkstVLXcLJjlneG';
const ICON_TABLE_ID = getArg('icon_table', 'ICON_TABLE_ID') || 'tblqZ84MplpY2sTr';

// Logo 映射
const LOGO_MAP = {
    '平安': 'pingan.png',
    '人寿': 'chinalife.png',
    '太平洋': 'cpic.png',
    '人保': 'picc.png',
    '人民财产': 'picc.png',
    '太平': 'taiping.png',
    '中华联合': 'chinaunion.png',
    '中华保': 'chinaunion.png',
    '问界': 'aito.png',
};

let cachedToken = null;

async function getTenantToken() {
    if (cachedToken) return cachedToken;
    const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
    });
    const data = await resp.json();
    if (data.code !== 0) throw new Error(`获取token失败: ${data.msg}`);
    cachedToken = data.tenant_access_token;
    return cachedToken;
}

async function downloadFile(fileToken) {
    const token = await getTenantToken();
    const resp = await fetch(`https://open.feishu.cn/open-apis/drive/v1/medias/${fileToken}/download`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!resp.ok) throw new Error(`下载失败: ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
}

async function main() {
    if (!APP_ID || !APP_SECRET) {
        console.error('请设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET 环境变量');
        process.exit(1);
    }

    // 创建目录
    if (!fs.existsSync(LOGOS_DIR)) fs.mkdirSync(LOGOS_DIR, { recursive: true });

    // 获取 token
    const token = await getTenantToken();

    // 搜索图标表
    const resp = await fetch(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${ICON_TABLE_ID}/records/search?page_size=100`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify({}),
        }
    );

    const data = await resp.json();
    if (data.code !== 0) {
        console.error(`搜索记录失败: ${data.msg}`);
        process.exit(1);
    }

    const records = (data.data && data.data.items) || [];
    console.log(`找到 ${records.length} 条记录`);

    // 打印第一条记录的字段结构
    if (records.length > 0) {
        const firstFields = records[0].fields;
        console.log('字段名:', Object.keys(firstFields).join(', '));
        console.log('第一条记录:', JSON.stringify(firstFields, null, 2).substring(0, 500));
    }

    let downloaded = 0;

    for (const record of records) {
        const fields = record.fields || {};
        
        // 尝试获取公司名
        const name = fields['公司名称'] || fields['名称'] || '';
        if (!name) continue;

        // 匹配 logo 文件名
        let targetFile = null;
        for (const [keyword, filename] of Object.entries(LOGO_MAP)) {
            if (name.includes(keyword)) {
                targetFile = filename;
                break;
            }
        }

        if (!targetFile) {
            console.log(`跳过: ${name} (无匹配映射)`);
            continue;
        }

        // 获取 logo 字段
        const logoField = fields['公司Logo'] || fields['logo'] || fields['Logo'] || fields['公司logo'] || null;
        
        if (!logoField) {
            console.log(`跳过: ${name} (无logo字段)`);
            continue;
        }

        // 提取 file_token
        let fileToken = null;
        if (typeof logoField === 'object' && logoField.file_token) {
            fileToken = logoField.file_token;
        } else if (Array.isArray(logoField) && logoField[0] && logoField[0].file_token) {
            fileToken = logoField[0].file_token;
        } else if (typeof logoField === 'string') {
            fileToken = logoField;
        }

        if (!fileToken) {
            console.log(`跳过: ${name} (无法提取file_token)`);
            console.log('  logo字段:', JSON.stringify(logoField).substring(0, 200));
            continue;
        }

        try {
            console.log(`下载: ${name} → ${targetFile} (token=${fileToken.substring(0, 20)}...)`);
            const buf = await downloadFile(fileToken);
            const filePath = path.join(LOGOS_DIR, targetFile);
            fs.writeFileSync(filePath, buf);
            console.log(`  ✅ 保存成功: ${filePath} (${buf.length} bytes)`);
            downloaded++;
        } catch (e) {
            console.error(`  ❌ 下载失败: ${e.message}`);
        }
    }

    console.log(`\n完成！共下载 ${downloaded} 个logo文件到 ${LOGOS_DIR}`);
    console.log('请将 logos/ 目录推送到 GitHub 触发 Railway 重新部署。');
}

main().catch(e => {
    console.error('错误:', e.message);
    process.exit(1);
});
