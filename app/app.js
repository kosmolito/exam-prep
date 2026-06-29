/* ── Utilities ─────────────────────────────────────── */

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(str) {
  if (!str) return '';
  return esc(str)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

const store = {
  get(key, fallback = null) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  },
  set(key, val) { localStorage.setItem(key, JSON.stringify(val)); },
  remove(key)   { localStorage.removeItem(key); },
};

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function formatTime(totalSecs) {
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

/* ── State ─────────────────────────────────────────── */

const state = {
  questions: [],
  meta: { title: 'Exam Prep', description: '', pass_mark: 80, time_limit: null },
  exam: null,
};

/* ── User history (localStorage) ───────────────────── */

// Stores {questionId → {selected: 'B', correct: true}} across sessions.
const hist = {
  get()                   { return store.get('userHistory', {}); },
  record(qId, sel, ok)    {
    const h = hist.get();
    h[String(qId)] = { selected: sel, correct: ok };
    store.set('userHistory', h);
  },
  forQ(qId)               { return hist.get()[String(qId)] ?? null; },
  wasWrong(qId)           { const e = hist.forQ(qId); return e !== null && e.correct === false; },
  clear()                 { store.remove('userHistory'); },
};

/* ── Derived ────────────────────────────────────────── */

const wrongFromHistory     = () => state.questions.filter(q => hist.wasWrong(q.id));
const wrongFromLastSession = () => {
  const ids = store.get('lastSessionWrongIds', []);
  return state.questions.filter(q => ids.includes(q.id));
};
const bookmarkedQuestions  = () => {
  const ids = store.get('bookmarkedIds', []);
  return state.questions.filter(q => ids.includes(q.id));
};
const isBookmarked  = id => store.get('bookmarkedIds', []).includes(id);
const toggleBookmark = id => {
  const ids = store.get('bookmarkedIds', []);
  store.set('bookmarkedIds', ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
};

/* ── Session persistence ───────────────────────────── */

function saveSession() {
  if (!state.exam) return;
  const { exam } = state;
  store.set('activeSession', {
    mode:         exam.mode,
    type:         exam.type,
    queueIds:     exam.queue.map(q => q.id),
    index:        exam.index,
    results:      exam.results,
    selected:     exam.selected,
    submitted:    exam.submitted,
    timerEndMs:   exam.timerEndMs,
    optionOrders: exam.optionOrders,
  });
}

function clearSession() { store.remove('activeSession'); }

function loadSession() {
  const saved = store.get('activeSession', null);
  if (!saved) return false;

  const queue = saved.queueIds
    .map(id => state.questions.find(q => q.id === id))
    .filter(Boolean);
  if (queue.length !== saved.queueIds.length) { clearSession(); return false; }

  // Normalise selected: old sessions may have stored a string or null
  const normSelected = s =>
    Array.isArray(s) ? s : (s ? [s] : []);

  // If timer expired while away, finish the exam immediately
  if (saved.type === 'exam' && saved.timerEndMs && Date.now() >= saved.timerEndMs) {
    state.exam = {
      mode: saved.mode, type: 'exam', queue,
      index: saved.index, results: saved.results,
      selected: [], submitted: false, timerEndMs: saved.timerEndMs,
    };
    finishExam();
    return false;
  }

  state.exam = {
    mode:         saved.mode,
    type:         saved.type ?? 'practice',
    queue,
    index:        saved.index,
    results:      saved.results,
    selected:     normSelected(saved.selected),
    submitted:    saved.submitted,
    timerEndMs:   saved.timerEndMs ?? null,
    optionOrders: saved.optionOrders ?? null,
  };
  return true;
}

/* ── Timer ─────────────────────────────────────────── */

let timerInterval = null;

function startTimerTick() {
  clearInterval(timerInterval);
  if (!state.exam?.timerEndMs) return;

  timerInterval = setInterval(() => {
    const { exam } = state;
    if (!exam?.timerEndMs) { clearInterval(timerInterval); return; }

    const remaining = Math.max(0, Math.floor((exam.timerEndMs - Date.now()) / 1000));
    const el = document.getElementById('exam-timer');
    if (el) {
      el.textContent = formatTime(remaining);
      el.className = 'exam-timer' +
        (remaining <= 60  ? ' timer-critical' :
         remaining <= 300 ? ' timer-warning'  : '');
    }
    if (remaining === 0) {
      clearInterval(timerInterval);
      finishExam();
    }
  }, 1000);
}

/* ── Actions ────────────────────────────────────────── */

function startExam(mode, type = 'practice', customQueue = null) {
  let queue;
  switch (mode) {
    case 'all':           queue = [...state.questions]; break;
    case 'wrong':         queue = [...wrongFromHistory()]; break;
    case 'session-wrong': queue = [...wrongFromLastSession()]; break;
    case 'bookmarked':    queue = [...bookmarkedQuestions()]; break;
    case 'custom':        queue = [...(customQueue ?? [])]; break;
    default:              queue = [];
  }

  if (!queue.length) { alert('No questions available for this mode.'); return; }

  let timerEndMs = null;
  if (type === 'exam' && state.meta.time_limit) {
    const scaledMins = Math.ceil((queue.length / state.questions.length) * state.meta.time_limit);
    timerEndMs = Date.now() + scaledMins * 60_000;
  }

  const shuffledQueue = shuffle(queue);
  state.exam = {
    mode, type,
    queue:        shuffledQueue,
    index:        0,
    results:      {},
    selected:     [],
    submitted:    false,
    timerEndMs,
    optionOrders: Object.fromEntries(shuffledQueue.map(q => [q.id, shuffle(Object.keys(q.options ?? {}))])),
  };

  clearSession();
  render('exam');
}

function selectAnswer(letter) {
  if (!state.exam || state.exam.submitted) return;
  const q       = state.exam.queue[state.exam.index];
  const isMulti = (q.correct_answers?.length ?? 1) > 1;

  if (isMulti) {
    const sel = state.exam.selected;
    state.exam.selected = sel.includes(letter)
      ? sel.filter(l => l !== letter)
      : [...sel, letter];
  } else {
    state.exam.selected = [letter];
  }
  render('exam');
}

function answersMatch(selected, correctAnswers) {
  if (selected.length !== correctAnswers.length) return false;
  const s = new Set(selected);
  return correctAnswers.every(l => s.has(l));
}

function submitAnswer() {
  const { exam } = state;
  if (!exam || exam.selected.length === 0 || exam.submitted) return;

  const q       = exam.queue[exam.index];
  const correct = answersMatch(exam.selected, q.correct_answers);

  exam.results[q.id] = { correct, selected: [...exam.selected] };
  exam.submitted = true;

  hist.record(q.id, [...exam.selected], correct);

  if (exam.type === 'exam') {
    // Exam mode: record silently, advance immediately (no per-question feedback)
    nextQuestion();
  } else {
    saveSession();
    render('exam');
  }
}

function nextQuestion() {
  const { exam } = state;
  if (!exam) return;

  exam.index++;
  exam.selected  = [];
  exam.submitted = false;

  if (exam.index >= exam.queue.length) {
    finishExam();
  } else {
    saveSession();
    render('exam');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function prevQuestion() {
  const { exam } = state;
  if (!exam || exam.index === 0) return;

  exam.index--;
  const q = exam.queue[exam.index];
  const prev = exam.results[q.id];

  // Pre-select previous answer so the user can keep or change it
  exam.selected  = prev ? [...prev.selected] : [];
  exam.submitted = false;

  saveSession();
  render('exam');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function goToQuestion(targetIndex) {
  const { exam } = state;
  if (!exam || targetIndex < 0 || targetIndex >= exam.queue.length) return;

  exam.index = targetIndex;
  const q = exam.queue[targetIndex];
  const prev = exam.results[q.id];
  exam.selected  = prev ? [...prev.selected] : [];
  exam.submitted = false;

  saveSession();
  render('exam');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function finishExam() {
  clearInterval(timerInterval);

  const wrongIds = Object.entries(state.exam.results)
    .filter(([, r]) => !r.correct)
    .map(([id]) => parseInt(id));

  store.set('lastSessionWrongIds', wrongIds);
  clearSession();
  render('results');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ── Render ─────────────────────────────────────────── */

const $app = () => document.getElementById('app');

function render(screen) {
  clearInterval(timerInterval);
  switch (screen) {
    case 'loading': $app().innerHTML = renderLoading(); break;
    case 'error':   $app().innerHTML = renderError();   break;
    case 'home':    $app().innerHTML = renderHome();     break;
    case 'exam':    $app().innerHTML = renderExam();     break;
    case 'results': $app().innerHTML = renderResults();  break;
  }
  attachHandlers(screen);
  if (screen === 'exam' && state.exam?.type === 'exam') startTimerTick();
}

/* Loading */
function renderLoading() {
  return `
    <div class="center-screen">
      <div class="spinner"></div>
      <p>Loading questions…</p>
    </div>`;
}

/* Error */
function renderError() {
  return `
    <div class="center-screen">
      <div style="font-size:2.5rem">⚠</div>
      <h2>Questions not found</h2>
      <p>Start the server with an input file:</p>
      <div class="code-block">python serve.py --input-file questions.yaml</div>
      <p style="margin-top:4px">Or place a <code>questions.json</code> in the app directory.</p>
    </div>`;
}

/* Home */
function renderHome() {
  const total   = state.questions.length;
  const h       = hist.get();
  const answered = state.questions.filter(q => h[String(q.id)]).length;
  const wrong   = wrongFromHistory().length;
  const correct = answered - wrong;
  const last    = wrongFromLastSession().length;
  const bmarks  = bookmarkedQuestions().length;
  const pct     = answered > 0 ? Math.round((correct / answered) * 100) : 0;
  const PASS    = state.meta.pass_mark ?? 80;
  const TL      = state.meta.time_limit;
  const hasSession = !!store.get('activeSession', null);

  const circ = 263.9;
  const dash = (pct / 100) * circ;
  const title = esc(state.meta.title || 'Exam Prep');
  const desc  = esc(state.meta.description || '');

  const examWrong  = wrong;
  const examBmarks = bmarks;
  const minsFor = n => TL ? Math.ceil((n / total) * TL) : 0;

  return `
    <div class="home">
      <header class="home-header">
        <h1>${title}</h1>
        ${desc ? `<p>${desc}</p>` : ''}
      </header>

      <div class="score-summary">
        <div class="score-ring">
          <svg viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="42" fill="none" stroke="#E2E8F0" stroke-width="8"/>
            <circle cx="50" cy="50" r="42" fill="none"
              stroke="#6B46C1" stroke-width="8"
              stroke-dasharray="${dash.toFixed(1)} ${circ}"
              stroke-dashoffset="${(circ * 0.25).toFixed(1)}"
              stroke-linecap="round"/>
          </svg>
          <div class="score-ring-text">
            <span class="score-ring-pct">${pct}%</span>
            <span class="score-ring-label">${answered > 0 ? 'Practice Score' : 'No history yet'}</span>
          </div>
        </div>

        <div class="score-details">
          <div class="score-row">
            <span class="score-dot correct"></span>
            <span>${correct} correct</span>
          </div>
          <div class="score-row">
            <span class="score-dot wrong"></span>
            <span>${wrong} incorrect</span>
          </div>
          <div class="score-row">
            <span class="score-dot"></span>
            <span>${total} total · pass mark ${PASS}%</span>
          </div>
        </div>
      </div>

      ${hasSession ? `
      <div class="session-banner">
        <div class="session-banner-text">
          <strong>Session in progress</strong>
          <span>You have an unfinished exam session.</span>
        </div>
        <button class="btn-continue" id="btn-continue-session">Continue →</button>
      </div>` : ''}

      <p class="section-title">Practice</p>
      <div class="mode-list">
        <button class="mode-btn ${total === 0 ? 'disabled' : ''}" data-mode="all" data-type="practice">
          <div class="mode-btn-icon">📚</div>
          <div class="mode-btn-body">
            <div class="mode-btn-title">All Questions</div>
            <div class="mode-btn-count">${total} questions · shuffled · instant feedback</div>
          </div>
          <div class="mode-btn-arrow">›</div>
        </button>

        <button class="mode-btn ${wrong === 0 ? 'disabled' : ''}" data-mode="wrong" data-type="practice">
          <div class="mode-btn-icon">🎯</div>
          <div class="mode-btn-body">
            <div class="mode-btn-title">Previously Wrong</div>
            <div class="mode-btn-count">${wrong > 0 ? `${wrong} questions you answered incorrectly` : 'Complete a practice session first'}</div>
          </div>
          <div class="mode-btn-arrow">›</div>
        </button>

        ${last > 0 ? `
        <button class="mode-btn" data-mode="session-wrong" data-type="practice">
          <div class="mode-btn-icon">🔄</div>
          <div class="mode-btn-body">
            <div class="mode-btn-title">Last Session Wrong</div>
            <div class="mode-btn-count">${last} questions from your most recent session</div>
          </div>
          <div class="mode-btn-arrow">›</div>
        </button>` : ''}

        ${bmarks > 0 ? `
        <button class="mode-btn bookmarked-mode" data-mode="bookmarked" data-type="practice">
          <div class="mode-btn-icon">★</div>
          <div class="mode-btn-body">
            <div class="mode-btn-title">Bookmarked</div>
            <div class="mode-btn-count">${bmarks} starred questions</div>
          </div>
          <div class="mode-btn-arrow">›</div>
        </button>` : ''}
      </div>

      ${TL ? `
      <p class="section-title exam-section-title">
        Exam Mode <span class="timer-badge">⏱ ${TL} min</span>
      </p>
      <div class="mode-list">
        <button class="mode-btn exam-mode-btn ${total === 0 ? 'disabled' : ''}" data-mode="all" data-type="exam">
          <div class="mode-btn-icon">📝</div>
          <div class="mode-btn-body">
            <div class="mode-btn-title">Full Exam</div>
            <div class="mode-btn-count">${total} questions · ${TL} min · no per-question feedback</div>
          </div>
          <div class="mode-btn-arrow">›</div>
        </button>

        ${examWrong > 0 ? `
        <button class="mode-btn exam-mode-btn" data-mode="wrong" data-type="exam">
          <div class="mode-btn-icon">🎯</div>
          <div class="mode-btn-body">
            <div class="mode-btn-title">Wrong Answers Exam</div>
            <div class="mode-btn-count">${examWrong} questions · ~${minsFor(examWrong)} min</div>
          </div>
          <div class="mode-btn-arrow">›</div>
        </button>` : ''}

        ${examBmarks > 0 ? `
        <button class="mode-btn exam-mode-btn bookmarked-mode" data-mode="bookmarked" data-type="exam">
          <div class="mode-btn-icon">★</div>
          <div class="mode-btn-body">
            <div class="mode-btn-title">Bookmarked Exam</div>
            <div class="mode-btn-count">${examBmarks} questions · ~${minsFor(examBmarks)} min</div>
          </div>
          <div class="mode-btn-arrow">›</div>
        </button>` : ''}
      </div>` : ''}

      ${hasSession ? `
      <div style="margin-top:16px;text-align:center">
        <button class="btn-ghost-full" id="btn-start-fresh">Start Fresh (clear session &amp; history)</button>
      </div>` : ''}
    </div>`;
}

/* Exam */
function renderExam() {
  const { exam } = state;
  if (!exam || !exam.queue.length) {
    return `<div class="center-screen"><p>No questions.</p>
      <button class="btn-ghost" onclick="render('home')">← Home</button></div>`;
  }

  const { queue, index, selected, submitted, results, type, timerEndMs } = exam;
  const q        = queue[index];
  const total    = queue.length;
  const answered = Object.keys(results).length;
  const correct  = Object.values(results).filter(r => r.correct).length;
  const result   = submitted ? results[q.id] : null;
  const progress = Math.round((index / total) * 100);
  const letters  = exam.optionOrders?.[q.id] ?? Object.keys(q.options ?? {});
  const starred  = isBookmarked(q.id);
  const isExam   = type === 'exam';
  const correctAnswers = q.correct_answers ?? [];
  const isMulti  = correctAnswers.length > 1;
  const correctSet = new Set(correctAnswers);

  const remainingSecs = (isExam && timerEndMs)
    ? Math.max(0, Math.floor((timerEndMs - Date.now()) / 1000))
    : null;

  return `
    <div id="nav-backdrop" class="nav-backdrop"></div>
    <div class="question-nav-panel" id="question-nav-panel">
      <div class="nav-panel-header">
        <span class="nav-panel-title">All Questions</span>
        <button class="btn-ghost btn-nav-close" id="btn-nav-close">✕</button>
      </div>
      <div class="nav-legend">
        <span><span class="nav-dot nav-dot-current"></span>Current</span>
        <span><span class="nav-dot nav-dot-correct"></span>Correct</span>
        <span><span class="nav-dot nav-dot-wrong"></span>Wrong</span>
        <span><span class="nav-dot nav-dot-bm"></span>Bookmarked</span>
      </div>
      <div class="nav-q-grid">
        ${queue.map((q, i) => {
          const res = results[q.id];
          const isCurrent = i === index;
          const starred = isBookmarked(q.id);
          let cls = 'nav-q-btn';
          if (isCurrent)  cls += ' nav-q-current';
          else if (res)   cls += res.correct ? ' nav-q-correct' : ' nav-q-wrong';
          if (starred)    cls += ' nav-q-bm';
          return `
            <button class="${cls}" data-nav-index="${i}" title="Question ${q.number ?? i + 1}${starred ? ' ★' : ''}">
              <span class="nav-q-num">${q.number ?? i + 1}</span>
              ${starred ? '<span class="nav-q-star">★</span>' : ''}
            </button>`;
        }).join('')}
      </div>
    </div>
    <div class="exam">
      <div class="exam-topbar">
        <button class="btn-ghost" id="btn-home">← Home</button>
        <div class="exam-progress-text">${index + 1} / ${total}</div>
        <div class="topbar-end">
          ${isExam && remainingSecs !== null
            ? `<div id="exam-timer" class="exam-timer${remainingSecs <= 60 ? ' timer-critical' : remainingSecs <= 300 ? ' timer-warning' : ''}">${formatTime(remainingSecs)}</div>`
            : `<div class="exam-score">${correct}/${answered} ✓</div>`}
          <button class="btn-nav-toggle" id="btn-nav-toggle" title="Question overview" aria-label="Question overview">&#9776;</button>
        </div>
      </div>

      <div class="progress-track">
        <div class="progress-fill" style="width:${progress}%"></div>
      </div>

      <div class="question-wrap" style="position:relative">
        <button class="bookmark-btn ${starred ? 'bookmarked' : ''}"
                id="btn-bookmark"
                title="${starred ? 'Remove bookmark' : 'Bookmark this question'}"
                aria-label="${starred ? 'Remove bookmark' : 'Bookmark this question'}">
          ${starred ? '★' : '☆'}
        </button>

        ${isExam ? `<div class="mode-pill mode-pill-exam">Exam</div>` : `<div class="mode-pill">Practice</div>`}

        <div class="question-meta">
          Question ${q.number ?? index + 1}${q.topic ? ' · ' + esc(q.topic) : ''}
        </div>

        <div class="question-text">${fmt(q.question)}</div>
        ${isMulti ? `<div class="choose-n">Choose ${correctAnswers.length}.</div>` : ''}

        ${q.image ? `
        <div class="question-img-wrap">
          <img class="question-img"
               src="${esc(q.image)}"
               alt="Question ${q.number ?? index + 1} exhibit"
               loading="lazy">
        </div>` : ''}

        <div class="options">
          ${letters.map(letter => {
            let cls = 'option-btn';
            if (!submitted) {
              if (selected.includes(letter)) cls += ' selected';
            } else {
              if (result?.selected?.includes(letter)) cls += ' selected';
              if (!isExam) {
                if (correctSet.has(letter))                                        cls += ' correct';
                else if (result?.selected?.includes(letter) && !result?.correct)   cls += ' wrong';
              }
            }
            return `
              <button class="${cls}" data-letter="${letter}" ${submitted ? 'disabled' : ''}>
                <div class="option-badge">${esc(letter)}</div>
                <div class="option-text">${fmt(q.options[letter])}</div>
              </button>`;
          }).join('')}
        </div>

        ${submitted && !isExam ? `
          <div class="feedback ${result.correct ? 'feedback-correct' : 'feedback-wrong'}">
            ${result.correct
              ? `✓ Correct!`
              : `✗ Incorrect — correct answer${correctAnswers.length > 1 ? 's' : ''}: <strong>${esc(correctAnswers.join(', '))}</strong>`}
          </div>
          ${q.explanation ? `
          <details class="explanation">
            <summary>Explanation</summary>
            <div class="explanation-body">${fmt(q.explanation)}</div>
          </details>` : ''}
        ` : ''}
      </div>

      <div class="exam-footer">
        <div class="exam-nav-row">
          <button class="btn-prev" id="btn-prev" ${index === 0 ? 'disabled' : ''}>← Prev</button>
          ${!submitted
            ? `<button class="btn-primary${isExam ? ' btn-exam' : ''}" id="btn-submit" ${selected.length === 0 ? 'disabled' : ''}>
                 ${isExam ? 'Submit &amp; Next →' : 'Submit Answer'}
               </button>`
            : `<button class="btn-primary" id="btn-next">
                 ${index + 1 < total ? 'Next Question →' : 'Finish Exam'}
               </button>`}
        </div>
        ${isExam ? `<button class="btn-secondary btn-finish-early" id="btn-finish-early">Finish Exam</button>` : ''}
      </div>
    </div>`;
}

/* Results */
function renderResults() {
  const { exam } = state;
  const { queue, results, type } = exam;
  const total   = queue.length;
  const correct = Object.values(results).filter(r => r.correct).length;
  const wrong   = total - correct;
  const pct     = Math.round((correct / total) * 100);
  const PASS    = state.meta.pass_mark ?? 80;
  const passed  = pct >= PASS;
  const isExam  = type === 'exam';

  const wrongItems = queue.filter(q => results[q.id] && !results[q.id].correct);
  // Also include unanswered (timer ran out) as wrong
  const unanswered = queue.filter(q => !results[q.id]);

  return `
    <div class="results">
      <div class="results-hero ${passed ? 'pass' : 'fail'}">
        <div class="results-pct">${pct}%</div>
        <div class="results-status">${passed ? '✓ PASS' : '✗ FAIL'}</div>
        <div class="results-detail">
          ${correct} of ${total} correct · pass mark ${PASS}%
          ${isExam ? ' · Exam Mode' : ''}
          ${unanswered.length > 0 ? ` · ${unanswered.length} unanswered` : ''}
        </div>
      </div>

      <div class="results-actions">
        ${wrong > 0 ? `
        <button class="btn-primary" id="btn-retry-wrong">
          🎯 Retry ${wrong} Wrong Answer${wrong !== 1 ? 's' : ''} (Practice)
        </button>` : `
        <div class="perfect-msg">🎉 All answers correct!</div>`}

        <button class="btn-secondary" id="btn-retake${isExam ? '-exam' : ''}">
          ${isExam ? '⏱ Retake as Exam' : 'Retake Same Set'}
        </button>
        <button class="btn-ghost-full" id="btn-home-results">← Back to Home</button>
      </div>

      ${wrongItems.length > 0 ? `
      <div class="wrong-review">
        <h3>Review — ${wrongItems.length} Incorrect Answer${wrongItems.length !== 1 ? 's' : ''}</h3>
        ${wrongItems.map((q, i) => {
          const r       = results[q.id];
          const starred = isBookmarked(q.id);
          return `
          <div class="wrong-card">
            <div class="wrong-card-meta">
              <span class="tag-q">Q${q.number ?? i + 1}</span>
              <span class="tag-wrong">Your answer: ${esc(Array.isArray(r.selected) ? r.selected.join(', ') : r.selected)}</span>
              <span class="tag-correct">Correct: ${esc((q.correct_answers ?? []).join(', '))}</span>
              <button class="bookmark-btn ${starred ? 'bookmarked' : ''}"
                      data-bookmark-id="${q.id}"
                      title="${starred ? 'Remove bookmark' : 'Bookmark'}"
                      style="position:static;font-size:1.1rem;margin-left:auto">
                ${starred ? '★' : '☆'}
              </button>
            </div>
            <p class="wrong-card-q">${fmt(q.question.length > 280 ? q.question.slice(0, 280) + '…' : q.question)}</p>
            ${q.image ? `<img src="${esc(q.image)}" alt="Q${q.number} exhibit" style="max-width:100%;border-radius:6px;margin:8px 0">` : ''}
            ${q.explanation ? `
            <details class="wrong-explanation">
              <summary>Explanation</summary>
              <div>${fmt(q.explanation)}</div>
            </details>` : ''}
          </div>`;
        }).join('')}
      </div>` : ''}
    </div>`;
}

/* ── Handlers ──────────────────────────────────────── */

function attachHandlers(screen) {
  if (screen === 'home') {
    document.querySelectorAll('.mode-btn:not(.disabled)').forEach(btn => {
      btn.addEventListener('click', () => {
        startExam(btn.dataset.mode, btn.dataset.type ?? 'practice');
      });
    });

    document.getElementById('btn-continue-session')?.addEventListener('click', () => {
      if (loadSession()) render('exam');
      else render('home');
    });

    document.getElementById('btn-start-fresh')?.addEventListener('click', () => {
      if (confirm('Clear session and all practice history?')) {
        clearSession();
        store.remove('lastSessionWrongIds');
        hist.clear();
        store.remove('bookmarkedIds');
        render('home');
      }
    });
  }

  if (screen === 'exam') {
    document.getElementById('btn-home')?.addEventListener('click', () => {
      const msg = state.exam?.type === 'exam'
        ? 'Leave exam? Your timer will keep running in the background.'
        : 'Leave exam? Progress is saved — you can continue later.';
      if (confirm(msg)) {
        if (state.exam?.type === 'practice') saveSession();
        else clearSession();  // exam mode sessions don't persist mid-way
        clearInterval(timerInterval);
        render('home');
      }
    });

    document.getElementById('btn-bookmark')?.addEventListener('click', () => {
      const q = state.exam.queue[state.exam.index];
      toggleBookmark(q.id);
      const btn = document.getElementById('btn-bookmark');
      if (btn) {
        const starred = isBookmarked(q.id);
        btn.textContent = starred ? '★' : '☆';
        btn.title = starred ? 'Remove bookmark' : 'Bookmark this question';
        btn.className = `bookmark-btn${starred ? ' bookmarked' : ''}`;
      }
    });

    document.querySelector('.question-img')?.addEventListener('click', e => {
      e.target.classList.toggle('zoomed');
    });

    document.querySelectorAll('.option-btn').forEach(btn => {
      btn.addEventListener('click', () => selectAnswer(btn.dataset.letter));
    });

    document.getElementById('btn-prev')?.addEventListener('click', prevQuestion);
    document.getElementById('btn-submit')?.addEventListener('click', submitAnswer);
    document.getElementById('btn-next')?.addEventListener('click', nextQuestion);
    document.getElementById('btn-finish-early')?.addEventListener('click', () => {
      if (confirm('Finish the exam now? Unanswered questions will be marked as wrong.')) {
        finishExam();
      }
    });

    const openNav  = () => {
      document.getElementById('question-nav-panel')?.classList.add('open');
      document.getElementById('nav-backdrop')?.classList.add('open');
    };
    const closeNav = () => {
      document.getElementById('question-nav-panel')?.classList.remove('open');
      document.getElementById('nav-backdrop')?.classList.remove('open');
    };

    document.getElementById('btn-nav-toggle')?.addEventListener('click', openNav);
    document.getElementById('btn-nav-close')?.addEventListener('click', closeNav);
    document.getElementById('nav-backdrop')?.addEventListener('click', closeNav);

    document.querySelectorAll('[data-nav-index]').forEach(btn => {
      btn.addEventListener('click', () => goToQuestion(parseInt(btn.dataset.navIndex)));
    });
  }

  if (screen === 'results') {
    document.getElementById('btn-retry-wrong')?.addEventListener('click', () => {
      const wrongIds = Object.entries(state.exam.results)
        .filter(([, r]) => !r.correct)
        .map(([id]) => parseInt(id));
      const wrongQ = state.questions.filter(q => wrongIds.includes(q.id));
      startExam('custom', 'practice', wrongQ);
    });

    document.getElementById('btn-retake')?.addEventListener('click', () => {
      startExam('custom', 'practice', state.exam.queue);
    });

    document.getElementById('btn-retake-exam')?.addEventListener('click', () => {
      startExam('custom', 'exam', state.exam.queue);
    });

    document.getElementById('btn-home-results')?.addEventListener('click', () => {
      render('home');
    });

    document.querySelectorAll('[data-bookmark-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.bookmarkId);
        toggleBookmark(id);
        const starred = isBookmarked(id);
        btn.textContent = starred ? '★' : '☆';
        btn.title = starred ? 'Remove bookmark' : 'Bookmark';
        btn.className = `bookmark-btn${starred ? ' bookmarked' : ''}`;
      });
    });
  }
}

/* ── Init ──────────────────────────────────────────── */

async function init() {
  render('loading');
  try {
    const resp = await fetch('questions.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    if (Array.isArray(data)) {
      state.questions = data;
    } else {
      state.questions = data.questions ?? [];
      if (data.meta) state.meta = { ...state.meta, ...data.meta };
    }

    document.title = state.meta.title || 'Exam Prep';
    render('home');
  } catch {
    render('error');
  }
}

init();
