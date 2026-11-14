/** Pure, deterministic bank validation and study logic. No network or AI grading. */
export const SCHEMA_VERSION = 1;
export const MODES = ['quick', 'random', 'incorrect', 'spaced'];
const own = (o, key) => Object.prototype.hasOwnProperty.call(o, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const allowedKeys = (value, keys, path, errors) => {
  for (const key of Object.keys(value)) if (!keys.includes(key)) errors.push(`${path}.${key}: unknown field.`);
};
function textField(value, path, errors, max = 160) {
  if (typeof value !== 'string' || !value.trim()) errors.push(`${path}: expected a nonempty string.`);
  else if (value.length > max) errors.push(`${path}: must be at most ${max} characters.`);
}
function uniqueIds(items, path, errors) {
  const seen = new Set();
  items.forEach((item, i) => {
    if (object(item) && typeof item.id === 'string') {
      if (seen.has(item.id)) errors.push(`${path}[${i}].id: duplicate ID "${item.id}" in this file.`);
      seen.add(item.id);
    }
  });
}
export function validateBank(input) {
  const errors = [];
  if (!object(input)) return { valid: false, errors: ['$: expected a JSON object.'], value: null };
  allowedKeys(input, ['schemaVersion', 'courses', 'questions'], '$', errors);
  if (input.schemaVersion !== 1) errors.push('$.schemaVersion: expected 1. Unsupported schema version.');
  if (!Array.isArray(input.courses)) errors.push('$.courses: expected an array.');
  if (!Array.isArray(input.questions)) errors.push('$.questions: expected an array.');
  const courses = Array.isArray(input.courses) ? input.courses : [];
  const questions = Array.isArray(input.questions) ? input.questions : [];
  uniqueIds(courses, '$.courses', errors);
  uniqueIds(questions, '$.questions', errors);
  const courseIds = new Set(courses.filter(object).map(c => c.id));
  courses.forEach((course, i) => {
    const path = `$.courses[${i}]`;
    if (!object(course)) { errors.push(`${path}: expected a course object.`); return; }
    allowedKeys(course, ['id', 'name', 'color', 'icon'], path, errors);
    textField(course.id, `${path}.id`, errors);
    textField(course.name, `${path}.name`, errors);
    if (own(course, 'color') && (typeof course.color !== 'string' || !/^#[\da-f]{6}$/i.test(course.color))) errors.push(`${path}.color: expected a six-digit hex color, such as #b8ead4.`);
    if (own(course, 'icon')) textField(course.icon, `${path}.icon`, errors, 16);
  });
  questions.forEach((question, i) => {
    const path = `$.questions[${i}]`;
    if (!object(question)) { errors.push(`${path}: expected a question object.`); return; }
    allowedKeys(question, ['id', 'courseId', 'topic', 'lecture', 'type', 'prompt', 'options', 'answer', 'explanation', 'difficulty', 'keywords', 'keywordMode'], path, errors);
    for (const field of ['id', 'courseId', 'topic', 'lecture']) textField(question[field], `${path}.${field}`, errors);
    for (const field of ['prompt', 'answer', 'explanation']) textField(question[field], `${path}.${field}`, errors, 20000);
    if (!courseIds.has(question.courseId)) errors.push(`${path}.courseId: course "${question.courseId}" is missing from $.courses.`);
    if (!['easy', 'medium', 'hard'].includes(question.difficulty)) errors.push(`${path}.difficulty: expected "easy", "medium", or "hard".`);
    if (!['mcq', 'short'].includes(question.type)) errors.push(`${path}.type: expected "mcq" or "short".`);
    if (question.type === 'mcq') {
      if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 8) errors.push(`${path}.options: multiple-choice questions need 2–8 options.`);
      if (Array.isArray(question.options)) {
        question.options.forEach((option, j) => textField(option, `${path}.options[${j}]`, errors, 4000));
        if (new Set(question.options).size !== question.options.length) errors.push(`${path}.options: options must be unique.`);
        if (!question.options.includes(question.answer)) errors.push(`${path}.answer: must exactly match one option.`);
      }
      for (const field of ['keywords', 'keywordMode']) if (own(question, field)) errors.push(`${path}.${field}: only allowed on short-answer questions.`);
    }
    if (question.type === 'short') {
      if (own(question, 'options')) errors.push(`${path}.options: not allowed on short-answer questions.`);
      if (own(question, 'keywords')) {
        if (!Array.isArray(question.keywords) || question.keywords.length < 1 || question.keywords.length > 30) errors.push(`${path}.keywords: expected 1–30 keyword strings.`);
        else {
          question.keywords.forEach((keyword, j) => textField(keyword, `${path}.keywords[${j}]`, errors));
          if (new Set(question.keywords.map(k => typeof k === 'string' ? normalize(k) : k)).size !== question.keywords.length) errors.push(`${path}.keywords: keywords must be unique, ignoring case and punctuation.`);
          if (question.keywords.some(k => typeof k === 'string' && !normalize(k))) errors.push(`${path}.keywords: each keyword must contain a letter or number.`);
        }
      }
      if (own(question, 'keywordMode') && (!['all', 'any'].includes(question.keywordMode) || !own(question, 'keywords'))) errors.push(`${path}.keywordMode: expected "all" or "any" with a keywords array.`);
    }
  });
  return { valid: errors.length === 0, errors, value: errors.length ? null : structuredClone(input) };
}
export function parseBankJSON(text) {
  try { return validateBank(JSON.parse(text)); }
  catch (error) { return { valid: false, errors: [`JSON: ${error.message}`], value: null }; }
}
export function gradeMCQ(question, selected) {
  return question.type === 'mcq' && Array.isArray(question.options) && question.options.includes(selected) && selected === question.answer;
}
function normalize(text) {
  return text.normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
export function checkKeywords(question, text) {
  const keywords = Array.isArray(question.keywords) ? question.keywords : [];
  if (!keywords.length) return { correct: null, matched: [], missing: [] };
  const haystack = ` ${normalize(String(text))} `;
  const matched = keywords.filter(keyword => haystack.includes(` ${normalize(keyword)} `));
  const missing = keywords.filter(keyword => !matched.includes(keyword));
  return { correct: question.keywordMode === 'any' ? matched.length > 0 : missing.length === 0, matched, missing };
}
export function nextProgress(previous, correct, now = Date.now()) {
  if (typeof correct !== 'boolean') throw new Error('Assessment must be true or false.');
  const time = new Date(now).getTime();
  if (!Number.isFinite(time)) throw new Error('Invalid assessment time.');
  const prior = previous || {};
  const streak = correct ? (prior.streak || 0) + 1 : 0;
  const intervalDays = correct ? [1, 3, 7, 14, 30][Math.min(streak - 1, 4)] : 0;
  return {
    ...(prior.questionId ? { questionId: prior.questionId } : {}),
    attempts: (prior.attempts || 0) + 1,
    correct: (prior.correct || 0) + Number(correct),
    incorrect: (prior.incorrect || 0) + Number(!correct),
    lastCorrect: correct, lastAnsweredAt: new Date(time).toISOString(),
    dueAt: new Date(time + (correct ? intervalDays * 86400000 : 600000)).toISOString(),
    intervalDays, streak
  };
}
export function selectQuestions(questions, progress = [], options = {}, now = Date.now()) {
  const byId = new Map(progress.map(p => [p.questionId, p]));
  const mode = options.mode || 'quick';
  let selected = questions.filter(q => (!options.courseId || options.courseId === 'all' || q.courseId === options.courseId) && (!options.topic || q.topic === options.topic) && (!options.lecture || q.lecture === options.lecture));
  if (mode === 'incorrect') selected = selected.filter(q => byId.get(q.id)?.lastCorrect === false);
  if (mode === 'spaced') selected = selected.filter(q => !byId.has(q.id) || Date.parse(byId.get(q.id).dueAt) <= new Date(now).getTime());
  selected = [...selected];
  for (let i = selected.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [selected[i], selected[j]] = [selected[j], selected[i]]; }
  if (mode === 'spaced') selected.sort((a, b) => (Date.parse(byId.get(a.id)?.dueAt || '1970-01-01') - Date.parse(byId.get(b.id)?.dueAt || '1970-01-01')));
  return selected.slice(0, Number.isFinite(options.count) ? Math.max(0, Math.floor(options.count)) : selected.length);
}
function dayKey(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function computeStats(questions, progress = [], history = [], courseId, now = Date.now()) {
  const time = new Date(now).getTime();
  const filtered = questions.filter(q => !courseId || courseId === 'all' || q.courseId === courseId);
  const ids = new Set(filtered.map(q => q.id));
  const records = progress.filter(p => ids.has(p.questionId));
  const recordsById = new Map(records.map(record => [record.questionId, record]));
  const attempts = history.filter(h => !courseId || courseId === 'all' || h.courseId === courseId);
  const correct = attempts.filter(h => h.correct).length;
  const days = new Map();
  attempts.forEach(h => { const date = dayKey(h.answeredAt); const day = days.get(date) || { date, attempts: 0, correct: 0 }; day.attempts++; day.correct += Number(h.correct); days.set(date, day); });
  const today = dayKey(time);
  let streak = 0;
  const cursor = new Date(time); cursor.setHours(12, 0, 0, 0);
  if (!days.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(dayKey(cursor))) { streak++; cursor.setDate(cursor.getDate() - 1); }
  const result = {
    total: filtered.length, answered: records.filter(p => p.attempts > 0).length,
    mastered: records.filter(p => p.streak >= 3).length,
    due: filtered.filter(q => !recordsById.has(q.id) || Date.parse(recordsById.get(q.id).dueAt) <= time).length,
    incorrect: records.filter(p => p.lastCorrect === false).length,
    attempts: attempts.length, correct, accuracy: attempts.length ? Math.round(correct / attempts.length * 100) : 0,
    streak, todayAttempts: days.get(today)?.attempts || 0,
    activity: [...days.values()].sort((a, b) => a.date.localeCompare(b.date))
  };
  result.byCourse = courseId && courseId !== 'all' ? [] : [...new Set(questions.map(q => q.courseId))].map(id => ({ courseId: id, ...computeStats(questions, progress, history, id, now), byCourse: undefined }));
  return result;
}
export function validateBackup(input) {
  const errors = [];
  if (!object(input)) return { valid: false, errors: ['$: expected a backup object.'], value: null };
  allowedKeys(input, ['format', 'schemaVersion', 'exportedAt', 'bank', 'progress', 'history', 'settings'], '$', errors);
  if (input.format !== 'pocket-study-backup') errors.push('$.format: expected "pocket-study-backup". Import a question bank through the bank manager.');
  if (input.schemaVersion !== 1) errors.push('$.schemaVersion: expected 1. Unsupported backup version.');
  if (!validDate(input.exportedAt)) errors.push('$.exportedAt: expected a valid date string.');
  const bankResult = validateBank(input.bank);
  errors.push(...bankResult.errors.map(error => error.replace(/^\$/, '$.bank')));
  const questionIds = new Set((Array.isArray(input.bank?.questions) ? input.bank.questions : []).filter(object).map(q => q.id));
  for (const field of ['progress', 'history', 'settings']) if (!Array.isArray(input[field])) errors.push(`$.${field}: expected an array.`);
  const progress = Array.isArray(input.progress) ? input.progress : [];
  const history = Array.isArray(input.history) ? input.history : [];
  const settings = Array.isArray(input.settings) ? input.settings : [];
  const seenProgress = new Set();
  progress.forEach((p, i) => {
    const path = `$.progress[${i}]`;
    if (!object(p)) { errors.push(`${path}: expected an object.`); return; }
    allowedKeys(p, ['questionId', 'attempts', 'correct', 'incorrect', 'lastCorrect', 'lastAnsweredAt', 'dueAt', 'intervalDays', 'streak'], path, errors);
    if (!questionIds.has(p.questionId)) errors.push(`${path}.questionId: no matching question.`);
    if (seenProgress.has(p.questionId)) errors.push(`${path}.questionId: duplicate progress record.`);
    seenProgress.add(p.questionId);
    for (const key of ['attempts', 'correct', 'incorrect', 'intervalDays', 'streak']) if (!integer(p[key])) errors.push(`${path}.${key}: expected a nonnegative integer.`);
    if (!p.attempts || p.correct + p.incorrect !== p.attempts || p.streak > p.correct || (!p.lastCorrect && p.streak !== 0)) errors.push(`${path}: inconsistent attempt counts or streak.`);
    if (typeof p.lastCorrect !== 'boolean') errors.push(`${path}.lastCorrect: expected a boolean.`);
    for (const key of ['lastAnsweredAt', 'dueAt']) if (!validDate(p[key])) errors.push(`${path}.${key}: expected a valid date string.`);
  });
  uniqueIds(history, '$.history', errors);
  history.forEach((h, i) => {
    const path = `$.history[${i}]`;
    if (!object(h)) { errors.push(`${path}: expected an object.`); return; }
    allowedKeys(h, ['id', 'questionId', 'courseId', 'topic', 'lecture', 'prompt', 'correct', 'answer', 'mode', 'answeredAt'], path, errors);
    for (const key of ['id', 'questionId', 'courseId', 'topic', 'lecture']) textField(h[key], `${path}.${key}`, errors);
    textField(h.prompt, `${path}.prompt`, errors, 20000);
    if (typeof h.answer !== 'string' || h.answer.length > 20000) errors.push(`${path}.answer: expected a string of at most 20000 characters.`);
    if (typeof h.correct !== 'boolean') errors.push(`${path}.correct: expected a boolean.`);
    if (!MODES.includes(h.mode)) errors.push(`${path}.mode: expected a supported quiz mode.`);
    if (!validDate(h.answeredAt)) errors.push(`${path}.answeredAt: expected a valid date string.`);
  });
  const seenSettings = new Set();
  settings.forEach((setting, i) => {
    const path = `$.settings[${i}]`;
    if (!object(setting)) { errors.push(`${path}: expected an object.`); return; }
    allowedKeys(setting, ['key', 'value'], path, errors);
    textField(setting.key, `${path}.key`, errors);
    if (!own(setting, 'value')) errors.push(`${path}.value: required.`);
    if (seenSettings.has(setting.key)) errors.push(`${path}.key: duplicate setting.`);
    seenSettings.add(setting.key);
    if (setting.key === 'activeSession' && setting.value !== null) errors.push(`${path}.value: activeSession must be null in portable backups.`);
  });
  return { valid: errors.length === 0, errors, value: errors.length ? null : structuredClone(input) };
}
