/**
 * TurboServer-Photon: 终极服务器加速插件 (修正版)
 * 新增:
 *  - PNG Worker 实验性开关 (默认关闭)
 */
const compression = require('compression');
const { LRUCache } = require('lru-cache');
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const msgpack = require('msgpack-lite');
const crypto = require('crypto');

let zstd;
try { zstd = require('node-zstd'); } catch(e) { zstd = null; }

function log(msg, type = 'info') {
    const colors = { info: '\x1b[36m', success: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m' };
    console.log(`${colors[type] || ''}[Photon-Server] ${msg}\x1b[0m`);
}

let cache, staleCache;
let pngWorker;
const pendingPng = new Map();
// 试验性功能开关，可在插件配置中修改
const ENABLE_PNG_WORKER = false; // 设为 true 启用

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
    pngWorker = new Worker(workerCode, { eval: true });
    pngWorker.on('message', ({ id, success, chunks, error }) => {
        const resolver = pendingPng.get(id);
        if (!resolver) return;
        pendingPng.delete(id);
        if (success) { resolver.resolve(chunks); log('PNG Worker 解析成功', 'success'); }
        else { log(`PNG Worker 解析失败: ${error}`, 'error'); resolver.reject(new Error(error)); }
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
    return crypto.createHash('md5').update(JSON.stringify(body)).digest('hex').slice(0,8);
}

async function init(router) {
    const app = router.app || router;
    log('启动终极光子引擎...');

    // 1. Brotli
    app.use(compression({ threshold: 256, level: 4 }));
    log('Brotli(Lv4) 已启用', 'success');

    // 2. Zstd
    if (zstd) {
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
        log('node-zstd 未安装', 'warn');
    }

    // 3. 缓存 + ETag + 失效
    cache = new LRUCache({ max: 2000, ttl: 1000*60*10 });
    staleCache = new LRUCache({ max: 1000, ttl: 1000*60*60 });

    app.use('/api', (req, res, next) => {
        if (['POST','PUT','DELETE','PATCH'].includes(req.method)) {
            cache.delete(req.originalUrl.split('?')[0]);
            staleCache.delete(req.originalUrl.split('?')[0]);
            log(`缓存失效: ${req.originalUrl.split('?')[0]}`, 'info');
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
                log(`304: ${key}`, 'info');
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
    log('多级缓存+ETag+失效 就绪', 'success');

    // 4. MessagePack
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
    log('MessagePack 就绪', 'success');

    // 5. PNG Worker (实验性，默认关闭)
    if (ENABLE_PNG_WORKER) {
        const pngRoute = findRoute(app._router.stack, 'post', '/api/characters/import');
        if (pngRoute) {
            startPngWorker();
            const orig = pngRoute.route.stack[0].handle;
            pngRoute.route.stack[0].handle = async function(req, res, next) {
                if (req.file?.buffer) {
                    try {
                        req.parsedPngChunks = await parsePngAsync(req.file.buffer);
                    } catch(e) { log(`PNG预解析失败: ${e.message}`, 'error'); }
                }
                return orig(req, res, next);
            };
            log('PNG 异步解析中间件已注入 (实验性)', 'warn');
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
    log('光子引擎全速运转！', 'success');
}

async function exit() {
    if (pngWorker) { pngWorker.terminate(); pngWorker = null; }
    log('光子引擎安全关闭', 'warn');
}

module.exports = { init, exit, info: { id: 'photon-server', name: 'Photon Server' } };