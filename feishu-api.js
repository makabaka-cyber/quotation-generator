/**
 * 飞书OpenAPI封装层 — 直接调用飞书HTTP API，不依赖 lark-cli
 * 使用 Node.js 18+ 内置的 fetch / FormData / Blob，零 npm 依赖
 *
 * 环境变量：
 *   FEISHU_APP_ID     — 飞书自建应用 App ID
 *   FEISHU_APP_SECRET — 飞书自建应用 App Secret
 */

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';

/** 读取环境变量，缺失时报错 */
function getEnv(name) {
    const val = process.env[name];
    if (!val) {
        throw new Error(`环境变量 ${name} 未设置，请在 Render 环境变量中配置`);
    }
    return val;
}

// ============================================================
// 1. tenant_access_token 获取与缓存
// ============================================================

let cachedToken = null;
let tokenExpiry = 0; // 毫秒时间戳

/**
 * 获取 tenant_access_token（带缓存，提前5分钟刷新）
 * @returns {Promise<string>} tenant_access_token
 */
async function getTenantToken() {
    // 缓存未过期则直接返回
    if (cachedToken && Date.now() < tokenExpiry) {
        return cachedToken;
    }

    const appId = getEnv('FEISHU_APP_ID');
    const appSecret = getEnv('FEISHU_APP_SECRET');

    const resp = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });

    const data = await resp.json();

    if (data.code !== 0) {
        throw new Error(`获取 tenant_access_token 失败: ${data.msg || JSON.stringify(data)}`);
    }

    cachedToken = data.tenant_access_token;
    // expire 通常为 7200 秒，提前 5 分钟刷新
    const expireSec = data.expire || 7200;
    tokenExpiry = Date.now() + (expireSec - 300) * 1000;

    console.log('[飞书API] tenant_access_token 已获取，有效期', expireSec, '秒');
    return cachedToken;
}

// ============================================================
// 2. 多维表格记录查询
// ============================================================

/**
 * 搜索多维表格记录（获取所有记录，自动分页）
 * @param {string} appToken 多维表格 app_token（BASE_TOKEN）
 * @param {string} tableId 表格ID
 * @returns {Promise<Array>} 记录数组，每条为 { record_id, fields: {...} }
 */
async function searchRecords(appToken, tableId) {
    const token = await getTenantToken();
    const url = `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/search?page_size=100`;
    const allRecords = [];
    let pageToken = null;

    do {
        const fetchUrl = pageToken ? `${url}&page_token=${pageToken}` : url;
        const resp = await fetch(fetchUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify({}),
        });

        const data = await resp.json();

        if (data.code !== 0) {
            throw new Error(`搜索记录失败: ${data.msg || JSON.stringify(data)}`);
        }

        const items = (data.data && data.data.items) || [];
        allRecords.push(...items);
        pageToken = (data.data && data.data.has_more) ? data.data.page_token : null;
    } while (pageToken);

    return allRecords;
}

/**
 * 获取单条记录
 * @param {string} appToken 多维表格 app_token
 * @param {string} tableId 表格ID
 * @param {string} recordId 记录ID
 * @returns {Promise<{record_id, fields}|null>}
 */
async function getRecord(appToken, tableId, recordId) {
    const token = await getTenantToken();
    const url = `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`;

    const resp = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
    });

    const data = await resp.json();

    if (data.code !== 0) {
        // 记录不存在时飞书返回非0 code
        if (data.code === 1254043 || (data.msg && data.msg.includes('not found'))) {
            return null;
        }
        throw new Error(`获取记录失败: ${data.msg || JSON.stringify(data)}`);
    }

    return data.data && data.data.record;
}

// ============================================================
// 3. 文件上传到飞书云空间
// ============================================================

/**
 * 上传文件到飞书云空间（用于多维表格附件字段）
 * @param {string} appToken 多维表格 app_token（作为 parent_node）
 * @param {string} fileName 文件名（如 报价单_xxx.txt）
 * @param {string} fileContent 文件内容（文本字符串）
 * @returns {Promise<string>} file_token
 */
async function uploadMedia(appToken, fileName, fileContent) {
    const token = await getTenantToken();
    const url = `${FEISHU_BASE}/drive/v1/medias/upload_all`;

    // 将文本内容转为 Buffer 再转 Blob
    const fileBuffer = Buffer.from(fileContent, 'utf8');
    const fileSize = fileBuffer.length;

    // 用 FormData 构建 multipart 请求
    const formData = new FormData();
    formData.append('file_name', fileName);
    formData.append('parent_type', 'bitable_file');
    formData.append('parent_node', appToken);
    formData.append('size', fileSize.toString());
    formData.append('file', new Blob([fileBuffer]), fileName);

    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
        },
        body: formData,
    });

    const data = await resp.json();

    if (data.code !== 0) {
        throw new Error(`上传文件失败: ${data.msg || JSON.stringify(data)}`);
    }

    const fileToken = data.data && data.data.file_token;
    if (!fileToken) {
        throw new Error('上传文件成功但未返回 file_token');
    }

    console.log(`[飞书API] 文件已上传: ${fileName} (${fileSize} bytes) → ${fileToken}`);
    return fileToken;
}

// ============================================================
// 4. 更新记录附件字段（覆盖式）
// ============================================================

/**
 * 更新记录的"报价单附件"字段（覆盖式，无需先删除旧附件）
 * @param {string} appToken 多维表格 app_token
 * @param {string} tableId 表格ID
 * @param {string} recordId 记录ID
 * @param {string} fileToken 上传后的文件token
 * @param {string} fieldName 附件字段名（默认"报价单附件"）
 * @returns {Promise<boolean>} 是否成功
 */
async function updateRecordAttachment(appToken, tableId, recordId, fileToken, fieldName) {
    const token = await getTenantToken();
    const field = fieldName || '报价单附件';
    const url = `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`;

    // 覆盖式更新：附件字段只包含新文件，旧附件会被替换
    const body = {
        fields: {},
    };
    body.fields[field] = [{ file_token: fileToken }];

    const resp = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
    });

    const data = await resp.json();

    if (data.code !== 0) {
        throw new Error(`更新记录附件失败: ${data.msg || JSON.stringify(data)}`);
    }

    console.log(`[飞书API] 记录 ${recordId} 的"${field}"字段已更新`);
    return true;
}

// ============================================================
// 5. 一站式：生成报价单并上传到飞书
// ============================================================

/**
 * 完整流程：获取记录 → 生成文本 → 上传文件 → 更新附件字段
 * @param {string} appToken 多维表格 app_token
 * @param {string} tableId 表格ID
 * @param {string} recordId 记录ID
 * @param {Function} generateTextFn 生成纯文本的函数（接收 record 对象，返回文本字符串）
 * @returns {Promise<{ok:boolean, file_name?:string, error?:string, record?:object}>}
 */
async function generateAndUploadQuotation(appToken, tableId, recordId, generateTextFn) {
    // 1. 获取记录
    const record = await getRecord(appToken, tableId, recordId);
    if (!record) {
        return { ok: false, error: `未找到记录: ${recordId}` };
    }

    // 2. 生成纯文本报价单
    const text = generateTextFn(record);
    const fileName = `报价单_${Date.now()}.txt`;

    // 3. 上传文件到飞书云空间
    const fileToken = await uploadMedia(appToken, fileName, text);

    // 4. 更新记录的附件字段
    await updateRecordAttachment(appToken, tableId, recordId, fileToken, '报价单附件');

    return { ok: true, file_name: fileName, record: record };
}

// ============================================================
// 导出
// ============================================================

module.exports = {
    getTenantToken,
    searchRecords,
    getRecord,
    uploadMedia,
    updateRecordAttachment,
    generateAndUploadQuotation,
};
