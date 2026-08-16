/**
 * ┌──────────────────────────────────────────────────┐
 * │  🧠 掌厨语义搜索模块（浏览器端）                  │
 * │                                                  │
 * │  把「关键词搜」升级成「语义搜」：                  │
 * │  在浏览器里跑 bge-small-zh 模型，给用户的查询      │
 * │  算出语义向量，再跟预先算好的菜谱向量做余弦。      │
 * │                                                  │
 * │  懒加载：页面启动不碰模型，第一次 init() 才下载    │
 * │  （模型 23MB q8，下载后由 Service Worker 缓存）    │
 * │                                                  │
 * │  降级：任何一步失败，search() 返回 null，          │
 * │  由 agent.js 走原来的关键词搜索兜底。             │
 * └──────────────────────────────────────────────────┘
 */
(function () {
  var MODEL_ID = 'Xenova/bge-small-zh-v1.5';   // 本地模型目录名
  var MODEL_PATH = './models/';                 // 自托管模型根目录（同源，无 CORS）
  var VECTORS_PATH = './data/recipe-vectors.json'; // 预计算好的菜谱语义向量
  var TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';

  var state = {
    ready: false,     // 模型 + 向量都加载完成
    failed: false,    // 初始化失败过，不再重试
    loading: false,   // 正在初始化
    promise: null,    // 初始化 Promise（防并发重复触发）
    extractor: null,  // transformers feature-extraction pipeline
    ids: null,        // 菜谱 id 数组（与语料向量一一对应）
    vecs: null        // 语料向量 [ [512 维], ... ]
  };

  function dot(a, b) {
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  // ─── 初始化（懒加载，可多次调用，只会真正执行一次）────────────────
  async function init() {
    if (state.ready) return true;
    if (state.failed) return false;
    if (state.loading) return state.promise;  // 已在加载中，复用同一个 Promise

    state.loading = true;
    state.promise = (async function () {
      try {
        // 1. 语料向量（小，~590KB）——先加载，这一步几乎秒回
        var resp = await fetch(VECTORS_PATH, { cache: 'force-cache' });
        if (!resp.ok) throw new Error('菜谱向量加载失败 ' + resp.status);
        var corpus = await resp.json();
        state.ids = corpus.ids;
        state.vecs = corpus.vecs;

        // 2. transformers.js（从 CDN 动态加载，~1MB JS）
        var mod = await import(TRANSFORMERS_CDN);
        var env = mod.env;
        env.allowRemoteModels = false;  // 只用本地模型，绝不联网拉 huggingface
        env.localModelPath = MODEL_PATH;

        // 3. bge 语义模型（q8 量化 ~23MB，首次下载后由 SW 缓存）
        var extractor = await mod.pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
        state.extractor = extractor;

        state.ready = true;
        console.log('🧠 语义搜索就绪（bge-small-zh q8，' + state.vecs.length + ' 道菜）');
        return true;
      } catch (e) {
        state.failed = true;
        console.warn('[语义搜索] 初始化失败，降级为关键词搜索:', e.message);
        return false;
      } finally {
        state.loading = false;
      }
    })();

    return state.promise;
  }

  // ─── 语义检索：查询 → top-k 菜谱 id ──────────────────────────────
  // 未就绪或出错时返回 null，调用方走关键词兜底
  async function search(query, k) {
    if (!state.ready) return null;
    try {
      var out = await state.extractor([query], { pooling: 'mean', normalize: true });
      var q = out.tolist()[0];  // [512] 查询向量
      var scored = state.ids.map(function (id, i) {
        return { id: id, score: dot(q, state.vecs[i]) };
      });
      scored.sort(function (a, b) { return b.score - a.score; });
      return scored.slice(0, k || 5);
    } catch (e) {
      console.warn('[语义搜索] 查询失败，降级为关键词搜索:', e.message);
      return null;
    }
  }

  // 暴露给 agent.js
  window.__semantic = {
    init: init,
    search: search,
    isReady: function () { return state.ready; }
  };
})();
