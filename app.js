// ===== DB =====
const DB_NAME = 'calorie-app';
const DB_VER = 1;
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('meals')) {
        const store = d.createObjectStore('meals', { keyPath: 'id', autoIncrement: true });
        store.createIndex('date', 'date', { unique: false });
      }
    };
    req.onsuccess = e => { db = e.target.result; resolve(db); };
    req.onerror = e => reject(e);
  });
}

function saveMeal(meal) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meals', 'readwrite');
    tx.objectStore('meals').add(meal).onsuccess = e => resolve(e.target.result);
    tx.onerror = reject;
  });
}

function getMealsByDate(date) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meals', 'readonly');
    const idx = tx.objectStore('meals').index('date');
    const req = idx.getAll(date);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = reject;
  });
}

function getAllMeals() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meals', 'readonly');
    const req = tx.objectStore('meals').getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = reject;
  });
}

function deleteMeal(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meals', 'readwrite');
    tx.objectStore('meals').delete(id).onsuccess = resolve;
    tx.onerror = reject;
  });
}

function clearAllMeals() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meals', 'readwrite');
    tx.objectStore('meals').clear().onsuccess = resolve;
    tx.onerror = reject;
  });
}

// ===== SETTINGS =====
function getSetting(key, def) {
  return localStorage.getItem(key) ?? def;
}
function setSetting(key, val) {
  localStorage.setItem(key, val);
}

// ===== UTILS =====
// AI가 "약 480", "480kcal", "120g" 등 문자열로 숫자를 반환할 때 안전하게 파싱
function parseNum(val) {
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  if (typeof val === 'string') {
    const match = val.replace(/,/g, '').match(/[\d.]+/);
    return match ? parseFloat(match[0]) : 0;
  }
  return 0;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
}

function showToast(msg, duration = 2200) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
}

// ===== MODELS =====
const VALID_MODELS = [
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'openrouter/free'
];

// ===== STATE =====
let currentImageBase64 = null;
let currentMealType = '아침';
let pendingResult = null;

// ===== VIEW NAVIGATION =====
document.querySelectorAll('.back-btn').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.target));
});

document.getElementById('btn-add').addEventListener('click', () => {
  currentImageBase64 = null;
  document.getElementById('preview-img').style.display = 'none';
  document.getElementById('preview-placeholder').style.display = 'flex';
  document.getElementById('btn-analyze').disabled = true;
  showView('upload');
});

document.getElementById('btn-history').addEventListener('click', () => {
  renderHistory();
  showView('history');
});

document.getElementById('btn-settings-open').addEventListener('click', () => {
  document.getElementById('input-api-key').value = getSetting('api_key', '');
  document.getElementById('input-goal').value = getSetting('daily_goal', '2000');
  document.getElementById('select-model').value = getSetting('model', VALID_MODELS[0]);
  showView('settings');
});

// ===== IMAGE INPUT =====
function handleImageFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const dataUrl = e.target.result;
    currentImageBase64 = dataUrl.split(',')[1];
    const img = document.getElementById('preview-img');
    img.src = dataUrl;
    img.style.display = 'block';
    document.getElementById('preview-placeholder').style.display = 'none';
    document.getElementById('btn-analyze').disabled = false;
  };
  reader.readAsDataURL(file);
}

document.getElementById('input-camera').addEventListener('change', e => handleImageFile(e.target.files[0]));
document.getElementById('input-gallery').addEventListener('change', e => handleImageFile(e.target.files[0]));

// ===== MEAL TYPE =====
document.querySelectorAll('.meal-type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.meal-type-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentMealType = btn.dataset.type;
  });
});

// ===== AUTO MEAL TYPE =====
(function setDefaultMealType() {
  const h = new Date().getHours();
  let type = '간식';
  if (h >= 5 && h < 10) type = '아침';
  else if (h >= 10 && h < 14) type = '점심';
  else if (h >= 17 && h < 21) type = '저녁';
  currentMealType = type;
  document.querySelectorAll('.meal-type-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });
})();

// ===== IMAGE COMPRESS =====
// 아이폰 고화질 사진을 API 전송 전 1024px 이하로 압축
function compressImage(base64, maxWidth = 1024) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth; }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.82).split(',')[1]);
    };
    img.onerror = () => resolve(base64); // 실패 시 원본 사용
    img.src = 'data:image/jpeg;base64,' + base64;
  });
}

// ===== AI ANALYZE =====
document.getElementById('btn-analyze').addEventListener('click', analyzeFood);
document.getElementById('btn-retry').addEventListener('click', () => showView('upload'));

async function callOpenRouter(apiKey, model, imageBase64, prompt) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': location.href,
      'X-Title': 'Calorie AI App'
    },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
          { type: 'text', text: prompt }
        ]
      }],
      max_tokens: 1200
    })
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API 오류 (${response.status})`);
  }
  return response.json();
}

async function analyzeFood() {
  const apiKey = getSetting('api_key', '');
  if (!apiKey) {
    showToast('먼저 설정에서 API 키를 입력해주세요.');
    document.getElementById('input-api-key').value = '';
    showView('settings');
    return;
  }
  if (!currentImageBase64) {
    showToast('사진을 먼저 선택해주세요.');
    return;
  }

  showView('analyzing');

  // 고화질 사진 압축 (API 전송 최적화)
  const compressedImage = await compressImage(currentImageBase64);

  const prompt = `You are a professional nutritionist expert in world cuisines. Analyze the food image and respond ONLY in Korean JSON format below.

[IDENTIFICATION RULES]
STEP 1 - Identify the MAIN dish (largest/most prominent bowl or plate):
- Focus on the foreground dish with the sharpest focus

⚠️ CRITICAL — DRY vs WET:
  - DRY dish (no visible liquid broth) → it is NEVER a stew(찌개) or soup(탕/국)
  - WET dish (visible red/brown/white liquid broth pooling around food) → it may be 찌개/국/탕
  - 볶음밥 looks RED/ORANGE but is DRY — the color comes from kimchi/gochujang staining the rice, NOT broth

Korean rice dish guide:
  * 김치볶음밥: DRY stir-fried rice, red-orange color from kimchi, individual rice grains visible, usually in large bowl, NO broth
  * 비빔밥: colorful vegetables arranged on top of white rice, often with egg yolk, served in stone/ceramic bowl
  * 볶음밥: plain DRY fried rice, brown/yellow color, with egg and vegetables

Korean soup/stew guide (ALL have clearly visible liquid broth):
  * 짬뽕: orange-yellow LIQUID broth + seafood (squid, clams, shrimp) + vegetables + noodles
  * 해물탕: spicy red LIQUID broth + large seafood pieces, no noodles
  * 김치찌개: red LIQUID broth with kimchi chunks + tofu, usually small pot
  * 된장찌개: brown/dark LIQUID broth + tofu + vegetables, small pot
  * 순두부찌개: soft white tofu pieces in red/orange LIQUID broth
  * 설렁탕/곰탕: white milky LIQUID broth + rice or noodles

- Use ONLY real, well-known Korean food names. Do NOT invent food names.

STEP 2 - Identify ALL SIDE dishes (separate containers clearly visible):
- Include ALL of these if present: drinks in glasses/cups (우유, 물, 주스), seaweed in tray (조미김/김), small side dish bowls
- 조미김/김: thin dark-green/black seaweed sheets in small plastic tray or wrapper
- 우유: white liquid in glass or cup
- EXCLUDE: blurry background items, condiments (참기름, 고추장 etc.), chopsticks, utensils
- Do NOT add items that are ingredients inside the main dish

STEP 3 - Assign confidence (0-100) for main dish identification:
- 90+: very certain | 70-89: similar dishes possible | below 70: hard to determine
- If confidence < 85, provide up to 3 candidates with calories

Respond ONLY with this JSON, no other text. All numeric values must be plain integers (no units):

{
  "confidence": 75,
  "food_name": "짬뽕",
  "portion": "약 800g",
  "calories": 650,
  "carbohydrate": 80,
  "protein": 30,
  "fat": 15,
  "items": [
    {
      "name": "짬뽕",
      "portion": "약 800g",
      "calories": 650,
      "carbohydrate": 80,
      "protein": 30,
      "fat": 15
    }
  ],
  "candidates": [
    {
      "name": "짬뽕",
      "reason": "황주황색 국물에 해물과 채소가 보임",
      "portion": "약 800g",
      "calories": 650,
      "carbohydrate": 80,
      "protein": 30,
      "fat": 15
    }
  ],
  "description": "한국어로 메인 음식 식별 근거와 칼로리 구성을 2~3문장으로 설명하세요."
}

If confidence >= 85, set candidates to [].
If no food visible, set food_name to "음식 없음" and calories to 0.`;

  // 선택된 모델을 우선 시도, 실패 시 나머지 모델로 순서대로 재시도
  const selectedModel = getSetting('model', VALID_MODELS[0]);
  const tryOrder = [selectedModel, ...VALID_MODELS.filter(m => m !== selectedModel)];

  let lastError = null;
  for (const model of tryOrder) {
    try {
      document.querySelector('.analyzing-sub').textContent = `모델: ${model.split('/')[1]}`;
      const data = await callOpenRouter(apiKey, model, compressedImage, prompt);
      const content = data.choices?.[0]?.message?.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('AI 응답을 파싱할 수 없습니다.');

      const parsed = JSON.parse(jsonMatch[0]);
      parsed.imageBase64 = currentImageBase64;
      parsed.mealType = currentMealType;
      setSetting('model', model);

      const confidence = parseNum(parsed.confidence);
      if (confidence < 85 && parsed.candidates && parsed.candidates.length > 0) {
        // 확신도 낮음 → 유저 선택 팝업
        showView('upload');
        showCandidateModal(parsed);
      } else {
        pendingResult = parsed;
        renderResult(pendingResult);
        showView('result');
      }
      return;
    } catch (err) {
      lastError = err;
      console.warn(`모델 ${model} 실패:`, err.message);
    }
  }

  showView('upload');
  showToast('분석 실패: ' + (lastError?.message || '알 수 없는 오류'), 3500);
  console.error(lastError);
}

// ===== CANDIDATE MODAL =====
function showCandidateModal(parsed) {
  const overlay = document.getElementById('modal-overlay');
  const container = document.getElementById('modal-candidates');

  container.innerHTML = parsed.candidates.map((c, i) => `
    <button class="candidate-btn" data-idx="${i}">
      <div class="candidate-num">${i + 1}</div>
      <div class="candidate-info">
        <div class="candidate-name">${c.name}</div>
        <div class="candidate-reason">${c.reason}</div>
      </div>
      <div class="candidate-cal">${Math.round(parseNum(c.calories))} kcal</div>
    </button>
  `).join('');

  container.querySelectorAll('.candidate-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      const chosen = parsed.candidates[idx];
      pendingResult = {
        ...parsed,
        food_name: chosen.name,
        portion: chosen.portion,
        calories: chosen.calories,
        carbohydrate: chosen.carbohydrate ?? parsed.carbohydrate,
        protein: chosen.protein ?? parsed.protein,
        fat: chosen.fat ?? parsed.fat,
        items: [],
        description: chosen.reason
      };
      overlay.classList.remove('show');
      renderResult(pendingResult);
      showView('result');
    });
  });

  overlay.classList.add('show');
}

document.getElementById('modal-cancel').addEventListener('click', () => {
  document.getElementById('modal-overlay').classList.remove('show');
});
document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget)
    document.getElementById('modal-overlay').classList.remove('show');
});

function renderResult(r) {
  const cal = parseNum(r.calories);
  const carb = parseNum(r.carbohydrate);
  const protein = parseNum(r.protein);
  const fat = parseNum(r.fat);

  document.getElementById('result-img').src = `data:image/jpeg;base64,${r.imageBase64}`;
  document.getElementById('result-food-name').textContent = r.food_name;
  document.getElementById('result-portion').textContent = r.portion;
  document.getElementById('result-cal').textContent = Math.round(cal).toLocaleString();
  document.getElementById('result-nutrients').innerHTML = `
    <div class="r-nutrient"><div class="r-nutrient-label">탄수화물</div><div class="r-nutrient-value">${Math.round(carb)}g</div></div>
    <div class="r-nutrient"><div class="r-nutrient-label">단백질</div><div class="r-nutrient-value">${Math.round(protein)}g</div></div>
    <div class="r-nutrient"><div class="r-nutrient-label">지방</div><div class="r-nutrient-value">${Math.round(fat)}g</div></div>
  `;

  const detailEl = document.getElementById('result-detail');
  if (r.items && r.items.length > 0) {
    const itemRows = r.items.map(item => `
      <div class="item-row">
        <div class="item-info">
          <span class="item-name">${item.name}</span>
          <span class="item-portion">${item.portion}</span>
        </div>
        <span class="item-cal">${Math.round(parseNum(item.calories))} kcal</span>
      </div>
    `).join('');
    detailEl.innerHTML = `
      <div class="items-label">인식된 음식 목록</div>
      <div class="items-list">${itemRows}</div>
      ${r.description ? `<div class="items-desc">${r.description}</div>` : ''}
    `;
  } else {
    detailEl.textContent = r.description || '';
  }
}

// ===== EDIT RESULT MODAL =====
document.getElementById('btn-edit-result').addEventListener('click', () => {
  if (!pendingResult) return;
  document.getElementById('edit-food-name').value = pendingResult.food_name || '';
  document.getElementById('edit-portion').value = pendingResult.portion || '';
  document.getElementById('edit-calories').value = Math.round(parseNum(pendingResult.calories)) || '';
  document.getElementById('edit-carb').value = Math.round(parseNum(pendingResult.carbohydrate)) || '';
  document.getElementById('edit-protein').value = Math.round(parseNum(pendingResult.protein)) || '';
  document.getElementById('edit-fat').value = Math.round(parseNum(pendingResult.fat)) || '';
  document.getElementById('edit-modal-overlay').classList.add('show');
});

document.getElementById('edit-save-btn').addEventListener('click', () => {
  const name = document.getElementById('edit-food-name').value.trim();
  if (!name) { showToast('음식 이름을 입력해주세요.'); return; }
  pendingResult = {
    ...pendingResult,
    food_name: name,
    portion: document.getElementById('edit-portion').value.trim() || pendingResult.portion,
    calories: parseNum(document.getElementById('edit-calories').value) || parseNum(pendingResult.calories),
    carbohydrate: parseNum(document.getElementById('edit-carb').value),
    protein: parseNum(document.getElementById('edit-protein').value),
    fat: parseNum(document.getElementById('edit-fat').value),
    items: []
  };
  document.getElementById('edit-modal-overlay').classList.remove('show');
  renderResult(pendingResult);
  showToast('수정되었습니다.');
});

document.getElementById('edit-cancel-btn').addEventListener('click', () => {
  document.getElementById('edit-modal-overlay').classList.remove('show');
});
document.getElementById('edit-modal-overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget)
    document.getElementById('edit-modal-overlay').classList.remove('show');
});

// ===== SAVE MEAL =====
document.getElementById('btn-save').addEventListener('click', async () => {
  if (!pendingResult) return;
  const meal = {
    date: todayStr(),
    mealType: pendingResult.mealType,
    foodName: pendingResult.food_name,
    portion: pendingResult.portion,
    calories: Math.round(parseNum(pendingResult.calories)),
    carbohydrate: Math.round(parseNum(pendingResult.carbohydrate)),
    protein: Math.round(parseNum(pendingResult.protein)),
    fat: Math.round(parseNum(pendingResult.fat)),
    imageBase64: pendingResult.imageBase64,
    createdAt: Date.now()
  };
  await saveMeal(meal);
  pendingResult = null;
  showToast('기록에 저장되었습니다!');
  await renderHome();
  showView('home');
});

// ===== HOME RENDER =====
async function renderHome() {
  const today = todayStr();
  const d = new Date();
  document.getElementById('today-label').textContent =
    d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

  const meals = await getMealsByDate(today);
  const totalCal = meals.reduce((s, m) => s + m.calories, 0);
  const totalCarb = meals.reduce((s, m) => s + (parseFloat(m.carbohydrate) || 0), 0);
  const totalProtein = meals.reduce((s, m) => s + (parseFloat(m.protein) || 0), 0);
  const totalFat = meals.reduce((s, m) => s + (parseFloat(m.fat) || 0), 0);

  const goal = parseInt(getSetting('daily_goal', '2000'));
  document.getElementById('total-cal').textContent = totalCal.toLocaleString();
  document.getElementById('goal-display').textContent = `/ ${goal.toLocaleString()} 목표`;
  document.getElementById('total-carb').textContent = Math.round(totalCarb) + 'g';
  document.getElementById('total-protein').textContent = Math.round(totalProtein) + 'g';
  document.getElementById('total-fat').textContent = Math.round(totalFat) + 'g';

  // 링 업데이트
  const circumference = 2 * Math.PI * 80; // ~502.65
  const ratio = Math.min(totalCal / goal, 1);
  const offset = circumference * (1 - ratio);
  const ring = document.getElementById('ring-progress');
  ring.style.strokeDasharray = circumference;
  ring.style.strokeDashoffset = offset;
  ring.style.stroke = totalCal > goal ? '#ef4444' : '#22c55e';

  // 식사 목록
  const list = document.getElementById('today-meals');
  if (meals.length === 0) {
    list.innerHTML = '<div class="empty-meals">오늘 기록된 식사가 없어요.<br>+ 버튼을 눌러 음식을 추가해보세요!</div>';
    return;
  }
  list.innerHTML = meals.slice().reverse().map(m => `
    <div class="meal-item">
      ${m.imageBase64
        ? `<img class="meal-thumb" src="data:image/jpeg;base64,${m.imageBase64}" alt="${m.foodName}"/>`
        : `<div class="meal-thumb-placeholder">${mealEmoji(m.mealType)}</div>`}
      <div class="meal-info">
        <div class="meal-name">${m.foodName}</div>
        <div class="meal-meta">${m.mealType} · ${m.portion}</div>
      </div>
      <div class="meal-cal">${m.calories.toLocaleString()} <span class="meal-cal-unit">kcal</span></div>
      <button class="meal-delete" data-id="${m.id}" aria-label="삭제">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>
        </svg>
      </button>
    </div>
  `).join('');

  list.querySelectorAll('.meal-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      await deleteMeal(Number(btn.dataset.id));
      await renderHome();
    });
  });
}

function mealEmoji(type) {
  return { '아침': '🌅', '점심': '☀️', '저녁': '🌙', '간식': '🍎' }[type] || '🍽️';
}

// ===== HISTORY RENDER =====
async function renderHistory() {
  const meals = await getAllMeals();
  const grouped = {};
  meals.forEach(m => {
    if (!grouped[m.date]) grouped[m.date] = [];
    grouped[m.date].push(m);
  });

  const el = document.getElementById('history-content');
  const dates = Object.keys(grouped).sort().reverse();

  if (dates.length === 0) {
    el.innerHTML = '<div class="empty-meals" style="margin-top:60px">아직 기록이 없어요.</div>';
    return;
  }

  el.innerHTML = dates.map(date => {
    const dayMeals = grouped[date];
    const dayTotal = dayMeals.reduce((s, m) => s + m.calories, 0);
    const items = dayMeals.slice().reverse().map(m => `
      <div class="meal-item">
        ${m.imageBase64
          ? `<img class="meal-thumb" src="data:image/jpeg;base64,${m.imageBase64}" alt="${m.foodName}"/>`
          : `<div class="meal-thumb-placeholder">${mealEmoji(m.mealType)}</div>`}
        <div class="meal-info">
          <div class="meal-name">${m.foodName}</div>
          <div class="meal-meta">${m.mealType} · ${m.portion}</div>
        </div>
        <div class="meal-cal">${m.calories.toLocaleString()} <span class="meal-cal-unit">kcal</span></div>
      </div>
    `).join('');
    return `
      <div class="history-date-group">
        <div class="history-date-title">
          <span>${fmtDate(date)}</span>
          <span class="history-date-cal">${dayTotal.toLocaleString()} kcal</span>
        </div>
        ${items}
      </div>
    `;
  }).join('');
}

// ===== SETTINGS SAVE =====
document.getElementById('btn-save-settings').addEventListener('click', () => {
  const key = document.getElementById('input-api-key').value.trim();
  const goal = document.getElementById('input-goal').value.trim();
  const model = document.getElementById('select-model').value;

  if (!key) { showToast('API 키를 입력해주세요.'); return; }

  setSetting('api_key', key);
  setSetting('daily_goal', goal || '2000');
  setSetting('model', model);
  showToast('설정이 저장되었습니다.');
  renderHome();
  showView('home');
});

document.getElementById('btn-clear-data').addEventListener('click', async () => {
  if (!confirm('모든 식사 기록을 삭제할까요? 이 작업은 되돌릴 수 없습니다.')) return;
  await clearAllMeals();
  showToast('모든 기록이 삭제되었습니다.');
  renderHome();
});

// ===== INIT =====
// 지원 종료된 모델이 localStorage에 남아있으면 교체
const savedModel = getSetting('model', '');
if (!VALID_MODELS.includes(savedModel)) {
  setSetting('model', VALID_MODELS[0]);
}

openDB().then(() => renderHome());

// ===== SERVICE WORKER =====
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
