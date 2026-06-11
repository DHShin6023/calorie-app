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
function todayStr() {
  return new Date().toISOString().slice(0, 10);
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
      max_tokens: 500
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

  const prompt = `이 이미지에 있는 음식을 분석해주세요.
반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트 없이 JSON만 출력하세요.

{
  "food_name": "음식 이름 (한국어)",
  "portion": "예상 중량 또는 분량 (예: 약 250g, 1인분 등)",
  "calories": 숫자,
  "carbohydrate": 숫자,
  "protein": 숫자,
  "fat": 숫자,
  "description": "음식에 대한 간단한 설명과 칼로리 구성 (2~3문장)"
}

음식이 여러 가지라면 모두 합산해서 하나의 JSON으로 응답하고 food_name에 대표 음식명을 적어주세요.
이미지에 음식이 없다면 food_name을 "음식 없음", calories를 0으로 응답하세요.`;

  // 선택된 모델을 우선 시도, 실패 시 나머지 모델로 순서대로 재시도
  const selectedModel = getSetting('model', VALID_MODELS[0]);
  const tryOrder = [selectedModel, ...VALID_MODELS.filter(m => m !== selectedModel)];

  let lastError = null;
  for (const model of tryOrder) {
    try {
      document.querySelector('.analyzing-sub').textContent = `모델: ${model.split('/')[1]}`;
      const data = await callOpenRouter(apiKey, model, currentImageBase64, prompt);
      const content = data.choices?.[0]?.message?.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('AI 응답을 파싱할 수 없습니다.');

      pendingResult = JSON.parse(jsonMatch[0]);
      pendingResult.imageBase64 = currentImageBase64;
      pendingResult.mealType = currentMealType;
      // 성공한 모델을 저장
      setSetting('model', model);
      renderResult(pendingResult);
      showView('result');
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

function renderResult(r) {
  document.getElementById('result-img').src = `data:image/jpeg;base64,${r.imageBase64}`;
  document.getElementById('result-food-name').textContent = r.food_name;
  document.getElementById('result-portion').textContent = r.portion;
  document.getElementById('result-cal').textContent = Math.round(r.calories).toLocaleString();
  document.getElementById('result-nutrients').innerHTML = `
    <div class="r-nutrient"><div class="r-nutrient-label">탄수화물</div><div class="r-nutrient-value">${r.carbohydrate}g</div></div>
    <div class="r-nutrient"><div class="r-nutrient-label">단백질</div><div class="r-nutrient-value">${r.protein}g</div></div>
    <div class="r-nutrient"><div class="r-nutrient-label">지방</div><div class="r-nutrient-value">${r.fat}g</div></div>
  `;
  document.getElementById('result-detail').textContent = r.description || '';
}

// ===== SAVE MEAL =====
document.getElementById('btn-save').addEventListener('click', async () => {
  if (!pendingResult) return;
  const meal = {
    date: todayStr(),
    mealType: pendingResult.mealType,
    foodName: pendingResult.food_name,
    portion: pendingResult.portion,
    calories: Math.round(pendingResult.calories),
    carbohydrate: pendingResult.carbohydrate,
    protein: pendingResult.protein,
    fat: pendingResult.fat,
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
      <div class="meal-cal">${m.calories.toLocaleString()}</div>
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
        <div class="meal-cal">${m.calories.toLocaleString()}</div>
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
