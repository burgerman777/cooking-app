/**
 * ┌──────────────────────────────────────────────────┐
 * │  🤖 掌厨 Agent 模块                              │
 * │                                                  │
 * │  Agent = LLM + Tools + Loop                     │
 * │                                                  │
 * │  把原来的单次问答 → 升级为真正的 Agent            │
 * │                                                  │
 * │  工具（3个）：                                    │
 * │  1. search_recipes — 搜菜谱                      │
 * │  2. get_recipe_detail — 获取菜谱完整详情          │
 * │  3. find_by_ingredients — 根据食材反查菜谱        │
 * │                                                  │
 * │  升级前后对比：                                   │
 * │  之前: 159道菜谱全塞进prompt → token爆炸 + 片面   │
 * │  之后: Agent自己搜 → 精准 + 高效 + 能多步推理     │
 * └──────────────────────────────────────────────────┘
 */

// ─── Agent 工具定义 ──────────────────────────

var COOKING_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_recipes',
      description:
        '搜索掌厨菜谱库（共 159 道菜）。支持按菜名关键词、标签、难度、预估时间搜索。' +
        '返回匹配的菜谱列表（含 ID、菜名、emoji、用时、难度、标签、食材概要）。' +
        '当用户问"有什么XX菜"、"推荐XX"、"XX分钟内能做完的"时使用。',
      parameters: {
        type: 'object',
        properties: {
          keyword: {
            type: 'string',
            description: '搜索关键词，可匹配菜名、标签、食材名。如"鸡"、"汤"、"减脂"、"川菜"'
          },
          tags: {
            type: 'string',
            description: '按标签筛选，多个用逗号分隔。可选标签：快速、下饭、荤菜、海鲜、主食、汤羹、凉菜、早餐、宴客、减脂、川菜、粤菜、鲁菜、苏菜、浙菜、闽菜、湘菜、徽菜'
          },
          difficulty: {
            type: 'string',
            description: '难度筛选：入门、家常、进阶'
          },
          max_results: {
            type: 'number',
            description: '最多返回几条，默认 5'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_recipe_detail',
      description:
        '获取指定菜谱的完整详情：食材清单（含精确用量）、每一步做法（含秒数和贴士）、所需工具、难度、总用时。' +
        '用户想看某道菜的具体做法时，先调 search_recipes 拿到菜名/ID，再调此工具获取完整信息。',
      parameters: {
        type: 'object',
        properties: {
          recipe_id: {
            type: 'string',
            description: '菜谱ID或菜名。ID格式如"tomato-egg"，也可以用中文菜名如"番茄炒蛋（咸口）"'
          }
        },
        required: ['recipe_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_by_ingredients',
      description:
        '根据用户手头有的食材，反查能做什么菜。输入食材列表，返回匹配度最高的菜谱。' +
        '匹配逻辑：统计菜谱所需食材中用户已有的比例，按匹配度从高到低排序。' +
        '当用户说"我有XX和XX，能做什么"、"冰箱里有XX"时使用此工具。',
      parameters: {
        type: 'object',
        properties: {
          ingredients: {
            type: 'string',
            description: '用户手头有的食材，用中文逗号或空格分隔。如"鸡胸肉、番茄、鸡蛋"'
          }
        },
        required: ['ingredients']
      }
    }
  }
];

// ─── 工具实现 ──────────────────────────────

/**
 * 搜索菜谱
 * 从 window.recipes 中按多个维度筛选
 */
function executeSearchRecipes(args) {
  var keyword = (args.keyword || '').toLowerCase();
  var tags = args.tags ? args.tags.split(/[,，、]/).map(function(t) { return t.trim(); }) : [];
  var difficulty = args.difficulty || '';
  var maxResults = args.max_results || 5;

  var allIds = Object.keys(window.recipes);
  var results = [];

  for (var i = 0; i < allIds.length; i++) {
    var r = window.recipes[allIds[i]];
    if (!r) continue;

    // 关键词匹配：菜名、标签、食材名
    if (keyword) {
      var inName = r.name.toLowerCase().indexOf(keyword) !== -1;
      var inTags = (r.tags || []).some(function(t) { return t.toLowerCase().indexOf(keyword) !== -1; });
      var inIngredients = (r.ingredients || []).some(function(ing) {
        return ing.name.toLowerCase().indexOf(keyword) !== -1;
      });
      if (!inName && !inTags && !inIngredients) continue;
    }

    // 标签筛选（同时满足所有指定标签）
    if (tags.length > 0) {
      var recipeTags = r.tags || [];
      var allMatch = tags.every(function(t) { return recipeTags.indexOf(t) !== -1; });
      if (!allMatch) continue;
    }

    // 难度筛选
    if (difficulty && r.difficulty !== difficulty) continue;

    // 构建结果摘要 — 含食材和步骤预览，大多数情况不需再调 get_recipe_detail
    var ings = (r.ingredients || []).map(function(ing) {
      return ing.name + (ing.amount ? ' ' + ing.amount : '');
    }).join('、');

    var stepsPreview = (r.steps || []).slice(0, 3).map(function(s, i) {
      return (i + 1) + '.' + s.text;
    }).join(' ');

    results.push({
      id: r.id,
      name: r.name,
      emoji: r.emoji || '🍳',
      time: r.time,
      difficulty: r.difficulty,
      tags: (r.tags || []).join('、'),
      ingredients: ings,
      steps_preview: stepsPreview + ((r.steps || []).length > 3 ? '…共' + r.steps.length + '步' : ''),
      key_tip: (r.steps || []).length > 0 && r.steps[0].tip ? r.steps[0].tip : ''
    });

    if (results.length >= maxResults) break;
  }

  if (results.length === 0) {
    return {
      found: 0,
      keyword: keyword || '(无)',
      hint: '没有完全匹配的菜谱。试试更宽泛的关键词，如"鸡"、"汤"、"快速"、"减脂"'
    };
  }

  return {
    found: results.length,
    keyword: keyword || '(全部)',
    recipes: results
  };
}

/**
 * 获取菜谱详情
 * 支持用 ID 或菜名查找
 */
function executeGetRecipeDetail(args) {
  var id = args.recipe_id || '';
  var recipe = null;

  // 先按 ID 精确匹配
  if (window.recipes[id]) {
    recipe = window.recipes[id];
  } else {
    // 再按菜名模糊匹配
    var allIds = Object.keys(window.recipes);
    for (var i = 0; i < allIds.length; i++) {
      var r = window.recipes[allIds[i]];
      if (r && r.name.indexOf(id) !== -1) {
        recipe = r;
        break;
      }
    }
  }

  if (!recipe) {
    return {
      error: '未找到菜谱: ' + id,
      hint: '请先用 search_recipes 搜索菜谱，拿到准确的菜名或 ID 后再查详情'
    };
  }

  // 格式化食材清单
  var ingredients = (recipe.ingredients || []).map(function(ing, idx) {
    return (idx + 1) + '. ' + ing.name + (ing.amount ? ' — ' + ing.amount : '');
  });

  // 格式化步骤
  var steps = (recipe.steps || []).map(function(step, idx) {
    var timeStr = step.time ? ' [' + step.time + '秒]' : '';
    var tipStr = step.tip ? ' 💡' + step.tip : '';
    return '步骤' + (idx + 1) + timeStr + ': ' + step.text + tipStr;
  });

  return {
    id: recipe.id,
    name: recipe.name,
    emoji: recipe.emoji || '🍳',
    time: recipe.time,
    difficulty: recipe.difficulty,
    tags: (recipe.tags || []).join('、'),
    tools: (recipe.tools || []).join('、'),
    ingredients: ingredients,
    steps: steps,
    note: '请用自然语言向用户汇报，不要逐字复制上述内容。突出关键步骤和小贴士。'
  };
}

/**
 * 根据食材反查菜谱
 * 计算每道菜跟用户已有食材的匹配度
 */
function executeFindByIngredients(args) {
  var raw = args.ingredients || '';
  var userIngs = raw.split(/[,，、\s]+/).filter(function(s) { return s.length > 0; });

  if (userIngs.length === 0) {
    return { error: '请告诉我你有哪些食材，比如"鸡胸肉、番茄、鸡蛋"' };
  }

  var allIds = Object.keys(window.recipes);
  var scored = [];

  for (var i = 0; i < allIds.length; i++) {
    var r = window.recipes[allIds[i]];
    if (!r) continue;
    var recipeIngNames = (r.ingredients || []).map(function(ing) { return ing.name; });

    // 计算匹配度 = 用户有的食材 ∩ 菜谱所需食材 / 菜谱所需食材
    var matched = 0;
    var matchedIngs = [];
    var missing = [];

    for (var j = 0; j < recipeIngNames.length; j++) {
      var found = false;
      for (var k = 0; k < userIngs.length; k++) {
        if (recipeIngNames[j].indexOf(userIngs[k]) !== -1 || userIngs[k].indexOf(recipeIngNames[j]) !== -1) {
          found = true;
          matchedIngs.push(recipeIngNames[j]);
          break;
        }
      }
      if (found) {
        matched++;
      } else {
        // 跳过通用调料（油盐酱醋等）
        var isStaple = /^(食用油|盐|白糖|生抽|老抽|料酒|醋|酱油|蚝油|鸡精|味精|淀粉|胡椒粉|花椒|辣椒|葱|姜|蒜|香油|清水|水)$/.test(recipeIngNames[j]);
        if (!isStaple) {
          missing.push(recipeIngNames[j]);
        }
      }
    }

    var matchRate = recipeIngNames.length > 0 ? matched / recipeIngNames.length : 0;

    if (matchRate >= 0.3 || matched >= 2) {
      scored.push({
        id: r.id,
        name: r.name,
        emoji: r.emoji || '🍳',
        time: r.time,
        difficulty: r.difficulty,
        match_rate: Math.round(matchRate * 100) + '%',
        matched_ingredients: matchedIngs,
        missing_ingredients: missing,
        total_ingredients: recipeIngNames.length
      });
    }
  }

  // 按匹配度排序
  scored.sort(function(a, b) {
    return parseInt(b.match_rate) - parseInt(a.match_rate);
  });

  var top = scored.slice(0, 5);

  if (top.length === 0) {
    return {
      ingredients: userIngs,
      found: 0,
      hint: '没有找到匹配的菜谱。试试输入主要食材（如肉类、蔬菜），不需要加调料（油盐酱醋等）'
    };
  }

  return {
    your_ingredients: userIngs,
    found: top.length,
    recommendations: top.map(function(r) {
      return {
        name: r.name + ' ' + r.emoji,
        id: r.id,
        time: r.time,
        difficulty: r.difficulty,
        match: r.match_rate,
        you_have: r.matched_ingredients.join('、'),
        you_need: r.missing_ingredients.length > 0 ? r.missing_ingredients.join('、') : '齐了！'
      };
    })
  };
}

/**
 * 工具调度器
 */
function executeCookingTool(toolName, args) {
  var result;
  switch (toolName) {
    case 'search_recipes':      result = executeSearchRecipes(args);      break;
    case 'get_recipe_detail':   result = executeGetRecipeDetail(args);    break;
    case 'find_by_ingredients': result = executeFindByIngredients(args);  break;
    default:
      result = { error: '未知工具: ' + toolName };
  }
  return JSON.stringify(result);
}

// ─── Agent 核心循环 ──────────────────────────

/**
 * 构建系统提示词
 * @param {string} mode - 'chat' | 'recommend' | 'general'
 * @param {object} context - 当前烹饪上下文（可选）
 */
function buildAgentSystemPrompt(mode, context) {
  var base = '你是「掌厨」APP 的 AI 烹饪助手。你拥有 159 道菜谱的工具访问权限。\n\n';

  if (mode === 'chat' && context && context.recipe) {
    // 做菜陪伴模式 — 用户正在做菜中
    var r = context.recipe;
    var stepIdx = context.step || 0;
    var currentStep = r.steps ? r.steps[stepIdx] : null;
    var allSteps = r.steps ? r.steps.map(function(s, i) {
      return '第' + (i + 1) + '步: ' + s.text;
    }).join('\n') : '';

    base += '## 当前烹饪上下文\n';
    base += '- 正在做: ' + r.name + '\n';
    base += '- 当前步骤: 第' + (stepIdx + 1) + '步 / 共' + (r.steps ? r.steps.length : 0) + '步\n';
    base += '- 步骤内容: ' + (currentStep ? currentStep.text : '未开始') + '\n';
    base += '- 小贴士: ' + (currentStep && currentStep.tip ? currentStep.tip : '无') + '\n';
    base += '- 全部步骤:\n' + allSteps + '\n\n';
    base += '## 你的角色\n';
    base += '你是经验丰富的家庭厨师，正在厨房陪用户做菜。回答要简洁实用（2-5句话），口语化。\n';
    base += '- 用户问做菜相关问题（火候、调味、替代等）→ 直接回答（用你的烹饪知识），不需要调工具\n';
    base += '- 用户问其他菜谱怎么做 → 用工具搜索并获取详情\n';
    base += '- 用户问"根据我有的食材" → 用 find_by_ingredients\n\n';
  } else if (mode === 'recommend') {
    // 推荐模式 — 用户想根据食材找菜
    base += '## 你的角色\n';
    base += '你是食材匹配专家。用户告诉你冰箱里有啥，你帮 TA 找到最合适的菜谱。\n\n';
    base += '## 工作流程\n';
    base += '1. 用 find_by_ingredients 查找匹配用户食材的菜谱\n';
    base += '2. 从结果中选 1-2 道匹配度最高的，用 get_recipe_detail 拿详情\n';
    base += '3. 向用户推荐：告诉 TA 匹配度、缺什么食材、做菜大概多长时间\n';
    base += '4. 如果匹配度最高的那几道仍然需要买不少食材，诚实告知\n';
    base += '5. 语言要有人情味，像朋友在帮你翻冰箱想办法\n\n';
  } else {
    // 通用模式 — Agent 自己判断用户意图
    base += '## 你的角色\n';
    base += '你是掌厨的美食助手，帮用户搜菜谱、查做法、根据食材推荐菜。\n\n';
    base += '## 工作方式\n';
    base += '先判断用户说的是什么：\n';
    base += '- 如果用户列了一堆食材（如"鸡胸肉、番茄、鸡蛋"）→ 用 find_by_ingredients 匹配\n';
    base += '- 如果用户说的是口味/预算/时间等需求（如"想吃辣的"、"30分钟内"）→ 用 search_recipes 搜\n';
    base += '- 搜到候选后，可以用 get_recipe_detail 看详情再推荐\n';
    base += '- 不要假设用户提到了冰箱或食材，除非用户确实说了\n';
    base += '- 回复自然友好，推荐时说明为什么选这道菜\n\n';
  }

  base += '## 工具使用原则\n';
  base += '- 需要同时查多个条件时，在同一轮并行调用多个工具（如同时搜"辣"和"减脂"）\n';
  base += '- search_recipes 已返回食材和步骤预览，通常不需要再调 get_recipe_detail\n';
  base += '- 拿到工具结果后，直接自然回复，别逐字复制数据\n';
  base += '- 简洁回答，2-4 句话即可，友好温暖\n';

  return base;
}

/**
 * Agent 循环 — 核心！
 * 跟 Day 1-3 完全一样的模式
 */
async function agentLoop(mode, userMessage, context) {
  var systemPrompt = buildAgentSystemPrompt(mode, context);

  var messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ];

  var MAX_LOOPS = 8;
  var toolCallHistory = [];

  for (var i = 0; i < MAX_LOOPS; i++) {
    var key = getApiKey();
    if (!key) throw new Error('NO_KEY');

    var resp = await fetch(AI_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 350,
        temperature: 0.7,
        messages: messages,
        tools: COOKING_TOOLS,
        tool_choice: 'auto'
      }),
      signal: AbortSignal.timeout(20000)
    });

    if (!resp.ok) {
      var err = await resp.json().catch(function() { return {}; });
      if (resp.status === 401) throw new Error('AUTH');
      if (resp.status === 429) throw new Error('RATE');
      throw new Error(err.error ? err.error.message : 'API 错误 (' + resp.status + ')');
    }

    var data = await resp.json();
    var choice = data.choices[0];
    var msg = choice.message;

    messages.push(msg);

    // 检查是否有工具调用
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      var toolNames = msg.tool_calls.map(function(tc) { return tc.function.name; });
      toolCallHistory.push(toolNames.join('+'));

      for (var j = 0; j < msg.tool_calls.length; j++) {
        var tc = msg.tool_calls[j];
        var toolName = tc.function.name;
        try {
          var args = JSON.parse(tc.function.arguments);
        } catch (parseErr) {
          console.warn('[Agent] 工具参数解析失败:', tc.function.arguments);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ error: '参数格式错误: ' + parseErr.message })
          });
          continue;
        }
        var result = executeCookingTool(toolName, args);

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result
        });
      }
      // 继续循环 — LLM 看到工具结果后可能再调工具或给出最终答案
    } else {
      // LLM 给了最终回复
      if (toolCallHistory.length > 0) {
        console.log('[Agent] 工具链: ' + toolCallHistory.join(' → ') + ' | 共 ' + (i + 1) + ' 轮');
      }
      return msg.content;
    }
  }

  return '抱歉，这个问题有点复杂，请换个方式问我试试？';
}

// ─── 对外接口（替换原来的 callAI）────────────────

/**
 * 智能烹饪助手 — Agent 版
 *
 * 用法：
 *   // 做菜陪伴聊天
 *   var reply = await cookingAgent('chat', '这步油温怎么判断够不够？', {
 *     recipe: currentRecipe,
 *     step: cookingStep
 *   });
 *
 *   // 食材推荐
 *   var reply = await cookingAgent('recommend', '鸡胸肉、番茄、鸡蛋');
 *
 *   // 通用问答
 *   var reply = await cookingAgent('general', '有什么30分钟内能做完的川菜？');
 *
 * @param {string} mode - 'chat' | 'recommend' | 'general'
 * @param {string} userMessage - 用户输入
 * @param {object} context - 可选，烹饪上下文
 * @returns {Promise<string>} Agent 的最终回复
 */
/**
 * 预搜索 — 在调 Agent 之前，客户端先跑搜索
 * 结果注入第一轮 prompt，Agent 直接回答，省掉一轮 API 调用
 * 这是从 2 轮 → 1 轮的关键优化
 */
function preSearch(userMessage) {
  var msg = userMessage || '';
  var results = {};

  // 1. 食材匹配 — 如果看起来像在列食材
  var ingMatch = msg.match(/[有剩下买].{0,5}[，,、\s]|冰箱|食材/);
  var looksLikeIngredients = /[，,、]/.test(msg) && msg.length < 30;
  if (looksLikeIngredients || ingMatch) {
    results.ingredient_match = JSON.parse(executeFindByIngredients({ ingredients: msg }));
  }

  // 2. 关键词搜索 — 用常见食物词匹配
  var keywords = [];
  var foodWords = ['辣', '鸡', '鱼', '肉', '虾', '牛', '猪', '蛋', '豆腐', '面', '饭', '汤',
    '减脂', '川菜', '粤菜', '鲁菜', '下饭', '早餐', '凉菜', '海鲜', '素', '快手', '煲', '蒸', '炒', '炖',
    '土豆', '番茄', '黄瓜', '茄子', '排骨'];
  for (var i = 0; i < foodWords.length; i++) {
    if (msg.indexOf(foodWords[i]) !== -1) {
      keywords.push(foodWords[i]);
    }
  }

  if (keywords.length > 0) {
    results.recipe_search = JSON.parse(executeSearchRecipes({
      keyword: keywords[0],
      max_results: 4
    }));
  } else if (!results.ingredient_match) {
    // 没关键词也不是食材列表，搜全部看标签匹配
    // 尝试用整个消息做关键词
    results.recipe_search = JSON.parse(executeSearchRecipes({
      keyword: msg.slice(0, 10),
      max_results: 4
    }));
  }

  return results;
}

function injectPreSearchResults(systemPrompt, preResults) {
  if (!preResults || Object.keys(preResults).length === 0) return systemPrompt;

  var extra = '\n## 📋 预搜索结果（已为你准备好，优先使用）\n';

  try {
    if (preResults.ingredient_match && typeof preResults.ingredient_match === 'object' && preResults.ingredient_match.found > 0) {
      extra += '### 食材匹配结果\n';
      extra += JSON.stringify(preResults.ingredient_match) + '\n';
    }

    if (preResults.recipe_search && typeof preResults.recipe_search === 'object' && preResults.recipe_search.found > 0) {
      extra += '### 菜谱搜索结果\n';
      extra += JSON.stringify(preResults.recipe_search) + '\n';
    }

    if ((!preResults.ingredient_match || preResults.ingredient_match.found === 0) &&
        (!preResults.recipe_search || preResults.recipe_search.found === 0)) {
      extra += '(预搜索未找到匹配，请使用工具手动搜索)\n';
    }
  } catch (e) {
    console.warn('[Agent] injectPreSearchResults 失败:', e.message);
    return systemPrompt; // 出错就降级，不带预搜索结果
  }

  return systemPrompt + extra;
}

async function cookingAgent(mode, userMessage, context) {
  try {
    // 通用模式：预搜索 + 单轮 Agent（大幅加速）
    if (mode === 'general') {
      try {
        var preResults = preSearch(userMessage);
        var systemPrompt = buildAgentSystemPrompt(mode, context);
        systemPrompt = injectPreSearchResults(systemPrompt, preResults);

        var hasResults = (preResults.recipe_search && preResults.recipe_search.found > 0) ||
                         (preResults.ingredient_match && preResults.ingredient_match.found > 0);

        if (hasResults) {
          console.log('[Agent] 预搜索命中，单轮响应');
          return await singleRoundAI(systemPrompt, userMessage);
        }
      } catch (preErr) {
        // 预搜索失败 → 降级为标准 Agent 循环
        console.warn('[Agent] 预搜索失败，降级为 Agent 循环:', preErr.message);
      }
    }

    // 标准 Agent 循环
    return await agentLoop(mode, userMessage, context || {});
  } catch (e) {
    throw e;
  }
}

/**
 * 单轮 AI 调用 — 已有搜索结果，直接回答（最快）
 */
async function singleRoundAI(systemPrompt, userMessage) {
  var key = getApiKey();
  if (!key) throw new Error('NO_KEY');

  var resp = await fetch(AI_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: 400,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!resp.ok) {
    var err = await resp.json().catch(function() { return {}; });
    if (resp.status === 401) throw new Error('AUTH');
    if (resp.status === 429) throw new Error('RATE');
    throw new Error(err.error ? err.error.message : 'API 错误 (' + resp.status + ')');
  }

  var data = await resp.json();
  return data.choices[0].message.content;
}

console.log('🍳 掌厨 Agent 已就绪 | 预搜索 + Agent 双模式');
