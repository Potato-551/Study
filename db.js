import { validateBank, validateBackup, nextProgress, MODES } from './model.js';

const STORES = ['courses', 'questions', 'progress', 'history', 'settings'];
const requestValue = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const done = transaction => {
  const completion = new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error || new Error('The storage transaction was cancelled.')); transaction.onerror = () => {}; });
  // A request may reject first; keep the transaction rejection handled until its caller awaits it.
  completion.catch(() => {});
  return completion;
};
function assertValid(result) {
  if (!result.valid) { const error = new Error(result.errors.join('\n')); error.validationErrors = result.errors; throw error; }
  return result.value;
}
export class StudyDB {
  constructor(name = 'pocket-study') { this.name = name; this.db = null; this.opening = null; }
  async init() {
    if (this.db) return this;
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) { reject(new Error('IndexedDB is unavailable. Open Pocket Study in Safari or another modern browser.')); return; }
      const request = indexedDB.open(this.name, 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of STORES) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: name === 'progress' ? 'questionId' : name === 'settings' ? 'key' : 'id' });
        request.transaction.objectStore('questions').createIndex('courseId', 'courseId', { unique: false });
        request.transaction.objectStore('history').createIndex('questionId', 'questionId', { unique: false });
      };
      request.onblocked = () => { blocked = true; reject(new Error('Storage upgrade is blocked by another Pocket Study tab. Close the other tab and reload.')); };
      request.onerror = () => reject(request.error || new Error('Unable to open local storage.'));
      request.onsuccess = () => {
        if (blocked) { request.result.close(); return; }
        this.db = request.result;
        this.db.onversionchange = () => { this.close(); };
        resolve(this);
      };
    });
    try { return await this.opening; } finally { this.opening = null; }
  }
  close() { this.db?.close(); this.db = null; }
  async all(store) {
    await this.init();
    const tx = this.db.transaction(store, 'readonly'); const complete = done(tx);
    const result = await requestValue(tx.objectStore(store).getAll()); await complete; return result;
  }
  async getBank() {
    await this.init();
    const tx = this.db.transaction(['courses', 'questions'], 'readonly'); const complete = done(tx);
    const [courses, questions] = await Promise.all(['courses', 'questions'].map(name => requestValue(tx.objectStore(name).getAll())));
    await complete; return { schemaVersion: 1, courses, questions };
  }
  async mergeBank(input) {
    const bank = assertValid(validateBank(input));
    await this.init();
    const tx = this.db.transaction(['courses', 'questions'], 'readwrite'); const complete = done(tx);
    const courseStore = tx.objectStore('courses'); const questionStore = tx.objectStore('questions');
    const [courseKeys, questionKeys] = await Promise.all([requestValue(courseStore.getAllKeys()), requestValue(questionStore.getAllKeys())]);
    const courseIds = new Set(courseKeys); const questionIds = new Set(questionKeys);
    const result = { added: 0, updated: 0, coursesAdded: 0, coursesUpdated: 0 };
    for (const course of bank.courses) { courseStore.put(course); result[courseIds.has(course.id) ? 'coursesUpdated' : 'coursesAdded']++; }
    for (const question of bank.questions) { questionStore.put(question); result[questionIds.has(question.id) ? 'updated' : 'added']++; }
    await complete; return result;
  }
  async saveQuestion(question) {
    const bank = await this.getBank();
    bank.questions = [...bank.questions.filter(q => q.id !== question.id), question];
    assertValid(validateBank(bank));
    const tx = this.db.transaction('questions', 'readwrite'); const complete = done(tx);
    tx.objectStore('questions').put(structuredClone(question)); await complete;
  }
  async deleteQuestion(id) {
    await this.init();
    const tx = this.db.transaction(['questions', 'progress', 'settings'], 'readwrite'); const complete = done(tx);
    tx.objectStore('questions').delete(id); tx.objectStore('progress').delete(id);
    // A saved queue may contain the deleted question; retain completed history, discard the queue.
    tx.objectStore('settings').put({ key: 'activeSession', value: null });
    await complete;
  }
  async saveCourse(course) {
    const bank = await this.getBank();
    bank.courses = [...bank.courses.filter(c => c.id !== course.id), course];
    assertValid(validateBank(bank));
    const tx = this.db.transaction('courses', 'readwrite'); const complete = done(tx);
    tx.objectStore('courses').put(structuredClone(course)); await complete;
  }
  async deleteCourse(id) {
    await this.init();
    const tx = this.db.transaction(['courses', 'questions', 'progress', 'settings'], 'readwrite'); const complete = done(tx);
    const questions = await requestValue(tx.objectStore('questions').index('courseId').getAll(id));
    tx.objectStore('courses').delete(id);
    for (const question of questions) { tx.objectStore('questions').delete(question.id); tx.objectStore('progress').delete(question.id); }
    tx.objectStore('settings').put({ key: 'activeSession', value: null });
    await complete;
  }
  async getProgress() { return this.all('progress'); }
  async getHistory() { return this.all('history'); }
  async getSetting(key) {
    await this.init();
    const tx = this.db.transaction('settings', 'readonly'); const complete = done(tx);
    const row = await requestValue(tx.objectStore('settings').get(key)); await complete; return row?.value;
  }
  async setSetting(key, value) {
    if (typeof key !== 'string' || !key.trim() || key.length > 160) throw new Error('Invalid setting key.');
    await this.init();
    const tx = this.db.transaction('settings', 'readwrite'); const complete = done(tx);
    tx.objectStore('settings').put({ key, value: structuredClone(value) }); await complete;
  }
  async recordAttempt(question, correct, options = {}) {
    if (typeof correct !== 'boolean') throw new Error('Assessment must be true or false.');
    if (!MODES.includes(options.mode || 'quick')) throw new Error('Invalid quiz mode.');
    const answer = options.answer ?? '';
    if (typeof answer !== 'string' || answer.length > 20000) throw new Error('Answer must be text of at most 20000 characters.');
    const hasSession = Object.prototype.hasOwnProperty.call(options, 'session');
    const session = hasSession ? structuredClone(options.session) : undefined;
    const time = new Date(options.now ?? Date.now());
    if (!Number.isFinite(time.getTime())) throw new Error('Invalid assessment time.');
    const id = options.id || crypto.randomUUID();
    if (typeof id !== 'string' || !id.trim() || id.length > 160) throw new Error('Invalid attempt ID.');
    await this.init();
    const tx = this.db.transaction(['questions', 'progress', 'history', 'settings'], 'readwrite'); const complete = done(tx);
    const progressStore = tx.objectStore('progress'); const historyStore = tx.objectStore('history');
    const [savedQuestion, previous, existing] = await Promise.all([
      requestValue(tx.objectStore('questions').get(question.id)), requestValue(progressStore.get(question.id)), requestValue(historyStore.get(id))
    ]);
    if (existing) {
      if (existing.questionId !== question.id) { tx.abort(); await complete.catch(() => {}); throw new Error('Attempt ID already belongs to another question.'); }
      await complete; return previous;
    }
    if (!savedQuestion) { tx.abort(); await complete.catch(() => {}); throw new Error('This question was deleted. Start a new practice session.'); }
    const progress = { questionId: question.id, ...nextProgress(previous, correct, time.getTime()) };
    progressStore.put(progress);
    historyStore.add({ id, questionId: question.id, courseId: savedQuestion.courseId, topic: savedQuestion.topic, lecture: savedQuestion.lecture, prompt: savedQuestion.prompt, correct, answer, mode: options.mode || 'quick', answeredAt: time.toISOString() });
    if (hasSession) tx.objectStore('settings').put({ key: 'activeSession', value: session });
    await complete; return progress;
  }
  async createBackup() {
    await this.init();
    const tx = this.db.transaction(STORES, 'readonly'); const complete = done(tx);
    const [courses, questions, progress, history, settings] = await Promise.all(STORES.map(name => requestValue(tx.objectStore(name).getAll())));
    await complete;
    return { format: 'pocket-study-backup', schemaVersion: 1, exportedAt: new Date().toISOString(), bank: { schemaVersion: 1, courses, questions }, progress, history, settings: settings.map(row => row.key === 'activeSession' ? { key: row.key, value: null } : row) };
  }
  async restoreBackup(input) {
    const backup = assertValid(validateBackup(input));
    await this.init();
    const tx = this.db.transaction(STORES, 'readwrite'); const complete = done(tx);
    for (const name of STORES) tx.objectStore(name).clear();
    for (const name of ['courses', 'questions']) for (const row of backup.bank[name]) tx.objectStore(name).put(row);
    for (const name of ['progress', 'history', 'settings']) for (const row of backup[name]) tx.objectStore(name).put(row);
    await complete;
    return { questions: backup.bank.questions.length, attempts: backup.history.length };
  }
}
