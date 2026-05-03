/**
 * TurboServer-Photon: 终极服务器加速插件 (优雅降级版)
 * 
 * 特性:
 *   - 自动检测依赖，缺失时安全降级并提示安装
 *   - 支持 Brotli, Zstd(可选), 多级缓存, ETag, MessagePack, HTTP/2 Push
 *   - 每个功能均有彩色日志 + 错误回退 + 安装指引
 */

const path = require('path');
const fs = require('fs');

// ================= 依赖自检与优雅降级 =================
const DEPS_MAP = {
    compression: { mod: null, name: 'compression', pkg: 'compression' },
    lruCache:     { mod: null, name: 'lru-cache', pkg: 'lru-cache' },
    msgpack:      { mod: null, name: 'msgpack-lite', pkg: 'msgpack-lite' },
    zstd:         { mod: null, name: 'node-zstd', pkg: 'node-zstd', optional: true },
};

const missingDeps = [];
for (const [key, dep] of Object.entries(DEPS_MAP)) {
    try {
        dep.mod = require(dep.pkg);
        // lru-cache v7+ 导出方式略有不同，统一处理
        if (key === 'lruCache' && dep.mod && dep.mod.default) {
            dep.mod = dep.mod.default;
        }
    } catch (e) {
        if (!dep.optional) missingDeps.push(dep.pkg);
    }
}

// ---------- 彩色日志 ----------
function log(msg, type = 'info') {
    const colors = { info: '\x1b[36m', success: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m' };
    console.log(`${colors[type] || ''}[Photon-Server] ${msg}\x1b[0m`);
}

// 输出安装指引
if (missingDeps.length > 0) {
    log('警告：缺少以下依赖，相关优化将被禁用', 'warn');
    missingDeps.forEach(pkg => log(`   - ${pkg}`, 'warn'));
    log(`请运行: cd plugins/TurboServer-Photon && npm install ${missingDeps.join(' ')}`, 'warn');
}

// ================= 导出模块 =================
let cache, staleCache;
let pngWorker;
const pendingPng = new Map();
const ENABLE_PNG_WORKER = false; // 实验性，默认关闭

// ---- PNG Worker (仅当启用且依赖存在时) ----
function startPngWorker() {
    if (pngWorker || !ENABLE_PNG_WORKER) return;
    const workerCode = `
        const { parentPort } = require('worker_threads');
        parentPort.on('message', ({ id, buffer }) => {
            try {
                const u8 = new Uint8Array(buffer);
                let pos = 8;
                const chunks = Object.create(null);
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
    pngWorker = new (require('worker_threads').Worker)(workerCode, { eval: true });
    pngWorker.on('message', ({ id, success, chunks, error }) => {
        const resolver = pendingPng.get(id);
        if (!resolver) return;
        pendingPng.delete(id);
        success ? resolver.resolve(chunks) : resolver.reject(new Error(error));
    });
    log('PNG Worker 已启动 (实验性)', 'warn');
}

async function parsePngAsync(buffer) {
    return new Promise((resolve, reject) => {
        const id = Math.random().toString(36);
        pendingPng.set(id, { resolve, reject });
        const copy = Buffer.from(buffer);
        pngWorker.postMessage({ id, buffer: copy.buffer }, [copy.buffer]);
    });
}

// ---- 递归查找路由 ----
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

// ---- 计算 ETag ----
function hashBody(body) {
    try {
        return require('crypto').createHash('md5').update(JSON.stringify(body)).digest('hex').slice(0,8);
    } catch(e) { return Date.now().toString(36); }
}

// ================= 插件入口 =================
async function init(router) {
    const app = router.app || router;
    log('启动光子引擎 (优雅降级版) ...');

    // 1. Brotli 压缩 (依赖 compression)
    if (DEPS_MAP.compression.mod) {
        app.use(DEPS_MAP.compression.mod({ threshold: 256, level: 4 }));
        log('Brotli 压缩 (Lv4) 已启用', 'success');
    } else {
        log('compression 模块缺失，Brotli 不可用', 'error');
    }

    // 2. Zstd 压缩 (可选)
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
                        } catch(e) { log(`Zstd 压缩失败: ${e.message}`, 'error'); }
                    }
                    return _end(chunk, encoding);
                };
            }
            next();
        });
        log('Zstd 压缩已激活', 'success');
    } else {
        log('node-zstd 未安装，跳过', 'warn');
    }

    // 3. 多级缓存 + ETag + 自动失效 (依赖 lru-cache)
    if (DEPS_MAP.lruCache.mod) {
        const { LRUCache } = DEPS_MAP.lruCache.mod;
        cache = new LRUCache({ max: 2000, ttl: 1000*60*10 });
        staleCache = new LRUCache({ max: 1000, ttl: 1000*60*60 });

        // 写请求清除缓存
        app.use('/api', (req, res, next) => {
            if (['POST','PUT','DELETE','PATCH'].includes(req.method)) {
                const base = req.originalUrl.split('?')[0];
                cache.delete(base);
                staleCache.delete(base);
                log(`缓存失效: ${base}`, 'info');
            }
            next();
        });

        // GET 请求缓存读取与 ETag
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
                log(`陈旧缓存响应: ${key}`, 'warn');
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
        log('多级缓存 + ETag + 失效 已启用', 'success');
    } else {
        log('lru-cache 模块缺失，缓存功能不可用', 'error');
    }

    // 4. MessagePack 支持 (依赖 msgpack-lite)
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
                        } catch(e) { log(`MsgPack 编码失败: ${e.message}`, 'error'); }
                    }
                    return _json(body);
                };
            }
            next();
        });
        log('MessagePack 序列化已启用', 'success');
    } else {
        log('msgpack-lite 模块缺失，MessagePack 不可用', 'warn');
    }

    // 5. PNG 异步解析 (实验性，默认关闭)
    if (ENABLE_PNG_WORKER) {
        const pngRoute = findRoute(app._router.stack, 'post', '/api/characters/import');
        if (pngRoute && DEPS_MAP.compression.mod) { // 至少需要基本模块支持
            startPngWorker();
            const orig = pngRoute.route.stack[0].handle;
            pngRoute.route.stack[0].handle = async function(req, res, next) {
                if (req.file?.buffer) {
                    try { req.parsedPngChunks = await parsePngAsync(req.file.buffer); }
                    catch(e) { log(`PNG 预解析失败: ${e.message}`, 'error'); }
                }
                return orig(req, res, next);
            };
            log('PNG 异步解析中间件已注入 (实验性)', 'warn');
        }
    }

    // 6. HTTP/2 Push
    app.use((req, res, next) => {
        if (res.push && req.path === '/') {
            const assets = ['/css/main.css', '/scripts/extensions/third-party/TurboClient-Photon/nitro-photon.js'];
            assets.forEach(asset => {
                const fp = path.join(__dirname, '..', '..', 'public', asset);
                if (fs.existsSync(fp)) {
                    const stream = res.push(asset, {});
                    stream?.on('error', ()=>{});
                    stream?.end(fs.readFileSync(fp));
                } else log(`Push 资源缺失: ${fp}`, 'warn');
            });
        }
        next();
    });
    log('HTTP/2 Push 就绪', 'success');

    // 最终建议
    if (missingDeps.length > 0) {
        log(`请运行 "cd plugins/TurboServer-Photon && npm install ${missingDeps.join(' ')}" 以启用全部功能`, 'warn');
    } else {
        log('所有依赖已满足，光子引擎全速运转！', 'success');
    }
}

async function exit() {
    if (pngWorker) { pngWorker.terminate(); pngWorker = null; }
    log('光子引擎已安全关闭', 'warn');
}

module.exports = { init, exit, info: { id: 'photon-server', name: 'Photon Server' } };
