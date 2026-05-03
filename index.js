/**
 * TurboServer-Photon: 终极服务器加速插件 (清晰提示版)
 * 自动检测依赖，缺失时安全跳过并提示安装
 * 提供: Brotli/Zstd压缩, 多级缓存+ETag+自动清缓存, MessagePack, HTTP/2 Push等
 */

const path = require('path');
const fs = require('fs');

// ================= 依赖自检（加强诊断） =================
const DEPS_MAP = {
    compression: { mod: null, pkg: 'compression', required: true },
    lruCache:    { mod: null, pkg: 'lru-cache', required: true },
    msgpack:     { mod: null, pkg: 'msgpack-lite', required: true },
    zstd:        { mod: null, pkg: 'node-zstd', required: false },
};

const missingRequired = [];
const optionalWarnings = [];

for (const [key, dep] of Object.entries(DEPS_MAP)) {
    try {
        const raw = require(dep.pkg);
        if (key === 'lruCache' && raw && raw.default) {
            dep.mod = raw.default;
        } else {
            dep.mod = raw;
        }
        console.log(`[Photon-Server] ✔ 已加载: ${dep.pkg}`);
    } catch (e) {
        if (dep.required) {
            missingRequired.push(dep.pkg);
            console.log(`[Photon-Server] ✖ 必需依赖 ${dep.pkg} 加载失败: ${e.message}`);
        } else {
            optionalWarnings.push({ pkg: dep.pkg, error: e.message });
            console.log(`[Photon-Server] ⚠ 可选依赖 ${dep.pkg} 加载失败: ${e.message}`);
        }
    }
}

function log(msg, type = 'info') {
    const colors = { info: '\x1b[36m', success: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m' };
    console.log(`${colors[type] || ''}[Photon-Server] ${msg}\x1b[0m`);
}

if (missingRequired.length > 0) {
    log('缺少必需依赖，相关优化将被禁用:', 'error');
    missingRequired.forEach(pkg => log(`   - ${pkg}`, 'error'));
    log(`在插件目录运行: npm install ${missingRequired.join(' ')}`, 'warn');
}
if (optionalWarnings.length > 0) {
    log('部分可选依赖未能加载，相关功能关闭:', 'warn');
    optionalWarnings.forEach(({pkg, error}) => log(`   - ${pkg}: ${error}`, 'warn'));
    log(`如需启用，请在插件目录运行: npm install ${optionalWarnings.map(w=>w.pkg).join(' ')}`, 'warn');
}

// ================= 全局变量 =================
let cache, staleCache;
let pngWorker;
const pendingPng = new Map();
const ENABLE_PNG_WORKER = false; // 实验功能，默认关闭

// ---- PNG Worker ----
function startPngWorker() {
    if (pngWorker || !ENABLE_PNG_WORKER) return;
    const { Worker } = require('worker_threads');
    const code = `
        const { parentPort } = require('worker_threads');
        parentPort.on('message', ({ id, buffer }) => {
            try {
                const u8 = new Uint8Array(buffer);
                let pos = 8, chunks = Object.create(null);
                while (pos < u8.length) {
                    const len = (u8[pos]<<24)|(u8[pos+1]<<16)|(u8[pos+2]<<8)|u8[pos+3];
                    const type = String.fromCharCode(...u8.slice(pos+4, pos+8));
                    if (type === 'tEXt'||type==='zTXt'||type==='iTXt') {
                        const start = pos+8;
                        const nullIdx = u8.indexOf(0, start);
                        const key = String.fromCharCode(...u8.slice(start, nullIdx));
                        chunks[key] = Buffer.from(u8.slice(nullIdx+1, start+len));
                    }
                    pos += 12+len+4;
                }
                parentPort.postMessage({ id, success: true, chunks });
            } catch(e) {
                parentPort.postMessage({ id, success: false, error: e.message });
            }
        });
    `;
    pngWorker = new Worker(code, { eval: true });
    pngWorker.on('message', ({ id, success, chunks, error }) => {
        const resolver = pendingPng.get(id);
        if (!resolver) return;
        pendingPng.delete(id);
        success ? resolver.resolve(chunks) : resolver.reject(new Error(error));
    });
    log('PNG 解析 Worker 已启动 (实验性)', 'warn');
}

async function parsePngAsync(buffer) {
    return new Promise((resolve, reject) => {
        const id = Math.random().toString(36);
        pendingPng.set(id, { resolve, reject });
        const copy = Buffer.from(buffer);
        pngWorker.postMessage({ id, buffer: copy.buffer }, [copy.buffer]);
    });
}

function findRoute(stack, method, targetPath) {
    for (const layer of stack) {
        if (layer.name === 'router' && layer.handle?.stack) {
            const found = findRoute(layer.handle.stack, method, targetPath);
            if (found) return found;
        }
        if (layer.route && layer.route.path === targetPath && layer.route.methods[method]) {
            return layer;
        }
    }
    return null;
}

function hashBody(body) {
    try { return require('crypto').createHash('md5').update(JSON.stringify(body)).digest('hex').slice(0,8); }
    catch(e) { return Date.now().toString(36); }
}

// ================= 插件主体 =================
async function init(router) {
    const app = router.app || router;
    log('启动光子引擎...');

    // 1. Brotli
    if (DEPS_MAP.compression.mod) {
        app.use(DEPS_MAP.compression.mod({ threshold: 256, level: 4 }));
        log('Brotli 压缩已启用', 'success');
    } else {
        log('compression 缺失，Brotli 不可用', 'error');
    }

    // 2. Zstd (可选)，并再次给出安装路径建议
    if (DEPS_MAP.zstd.mod) {
        const zstd = DEPS_MAP.zstd.mod;
        app.use((req, res, next) => {
            if ((req.headers['accept-encoding']||'').includes('zstd')) {
                const chunks = [];
                const _end = res.end.bind(res);
                res.write = (c) => { if(c) chunks.push(Buffer.from(c)); return true; };
                res.end = function(chunk, encoding) {
                    if (chunk) chunks.push(Buffer.from(chunk));
                    if (chunks.length && !res.headersSent) {
                        try {
                            const compressed = zstd.compressSync(Buffer.concat(chunks), 3);
                            res.setHeader('Content-Encoding', 'zstd');
                            res.setHeader('Content-Length', compressed.length);
                            return _end(compressed);
                        } catch(e) { log(`Zstd 压缩流失败: ${e.message}`, 'error'); }
                    }
                    return _end(chunk, encoding);
                };
            }
            next();
        });
        log('Zstd 压缩已激活', 'success');
    } else {
        // 给出明确的安装路径和诊断
        log(`Zstd 未加载。若要启用，请在插件目录运行: cd ${__dirname} && npm install node-zstd`, 'warn');
    }

    // 3. 多级缓存 + ETag + 写入自动清缓存 （原“失效”改为更清晰描述）
    if (DEPS_MAP.lruCache.mod) {
        const LRUCache = DEPS_MAP.lruCache.mod;
        cache = new LRUCache({ max: 2000, ttl: 1000*60*10 });
        staleCache = new LRUCache({ max: 1000, ttl: 1000*60*60 });

        // 写操作自动清缓存
        app.use('/api', (req, res, next) => {
            if (['POST','PUT','DELETE','PATCH'].includes(req.method)) {
                const base = req.originalUrl.split('?')[0];
                cache.delete(base);
                staleCache.delete(base);
                log(`自动清除缓存: ${base}`, 'info');
            }
            next();
        });

        app.use('/api', (req, res, next) => {
            if (req.method !== 'GET') return next();
            const key = req.originalUrl;
            const fresh = cache.get(key);
            if (fresh) {
                res.setHeader('ETag', `"${fresh._etag}"`);
                if (req.headers['if-none-match'] === `"${fresh._etag}"`) {
                    res.status(304).end();
                    log(`304 未修改: ${key}`, 'info');
                    return;
                }
                res.setHeader('X-Photon-Cache', 'HIT');
                log(`缓存命中: ${key}`, 'info');
                return res.json(fresh.data);
            }
            const stale = staleCache.get(key);
            if (stale) {
                res.setHeader('ETag', `"${stale._etag}"`);
                if (req.headers['if-none-match'] === `"${stale._etag}"`) {
                    res.status(304).end();
                    return;
                }
                res.setHeader('X-Photon-Cache', 'STALE');
                log(`陈旧缓存: ${key}`, 'warn');
                const base = `${req.protocol}://${req.get('host')}`;
                setTimeout(() => fetch(`${base}${key}`).then(r=>r.json()).then(d=>{
                    const etag = hashBody(d);
                    cache.set(key, {data:d, _etag:etag});
                    staleCache.set(key, {data:d, _etag:etag});
                }).catch(e=>log(`后台刷新失败: ${key}`,'warn')), 0);
                return res.json(stale.data);
            }
            const _json = res.json.bind(res);
            res.json = function(body) {
                if (res.statusCode === 200) {
                    const etag = hashBody(body);
                    cache.set(key, {data:body, _etag:etag});
                    staleCache.set(key, {data:body, _etag:etag});
                    res.setHeader('ETag', `"${etag}"`);
                }
                return _json(body);
            };
            next();
        });
        log('多级缓存 + ETag + 写操作自动清缓存 已启用', 'success');
    } else {
        log('lru-cache 缺失，缓存不可用', 'error');
    }

    // 4. MessagePack
    if (DEPS_MAP.msgpack.mod) {
        const msgpack = DEPS_MAP.msgpack.mod;
        app.use('/api', (req, res, next) => {
            if ((req.headers['accept']||'').includes('application/x-msgpack')) {
                const _json = res.json.bind(res);
                res.json = function(body) {
                    if (res.statusCode === 200) {
                        try {
                            res.setHeader('Content-Type', 'application/x-msgpack');
                            return res.send(msgpack.encode(body));
                        } catch(e) { log(`MsgPack编码失败: ${e.message}`, 'error'); }
                    }
                    return _json(body);
                };
            }
            next();
        });
        log('MessagePack 已启用', 'success');
    } else {
        log('msgpack-lite 缺失，跳过', 'warn');
    }

    // 5. PNG Worker (实验)
    if (ENABLE_PNG_WORKER) {
        const pngRoute = findRoute(app._router.stack, 'post', '/api/characters/import');
        if (pngRoute) {
            startPngWorker();
            const orig = pngRoute.route.stack[0].handle;
            pngRoute.route.stack[0].handle = async function(req, res, next) {
                if (req.file?.buffer) {
                    try { req.parsedPngChunks = await parsePngAsync(req.file.buffer); }
                    catch(e) { log(`PNG预解析失败: ${e.message}`, 'error'); }
                }
                return orig(req, res, next);
            };
            log('PNG 异步中间件已注入', 'warn');
        }
    }

    // 6. HTTP/2 Push
    app.use((req, res, next) => {
        if (res.push && req.path === '/') {
            ['/css/main.css', '/scripts/extensions/third-party/TurboClient-Photon/nitro-photon.js'].forEach(asset => {
                const fp = path.join(__dirname, '..', '..', 'public', asset);
                if (fs.existsSync(fp)) {
                    const stream = res.push(asset, {});
                    stream?.on('error', ()=>{});
                    stream?.end(fs.readFileSync(fp));
                } else log(`Push资源缺失: ${fp}`, 'warn');
            });
        }
        next();
    });
    log('HTTP/2 Push 就绪', 'success');

    if (missingRequired.length > 0) {
        log(`安装缺失必备依赖以启用全部功能: npm install ${missingRequired.join(' ')}`, 'warn');
    } else {
        log('所有加速模块已启动，光子引擎全速运转！', 'success');
    }
}

async function exit() {
    if (pngWorker) { pngWorker.terminate(); pngWorker = null; }
    log('光子引擎已安全关闭', 'warn');
}

module.exports = { init, exit, info: { id: 'photon-server', name: 'Photon Server', description: '服务器端性能加速插件：Brotli/Zstd压缩、多级缓存、ETag、MessagePack、HTTP/2 Push等（缺失依赖会自动禁用并提示安装）' } };
