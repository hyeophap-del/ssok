import fs from 'node:fs';
import path from 'node:path';

/**
 * 주고받은 항목(파일·텍스트) 목록을 JSON 파일에 저장한다. 최신 항목이 앞에 온다.
 */
export class Store {
  constructor(file, { max = 500 } = {}) {
    this.file = file;
    this.max = max;
    this.items = [];
    this.timer = null;
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(data.items)) this.items = data.items.filter(isValidItem);
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`목록 파일을 읽지 못해 새로 시작합니다: ${err.message}`);
    }
    // PC에서 직접 지운 파일은 목록에서도 뺀다
    const before = this.items.length;
    this.items = this.items.filter((item) => item.kind !== 'file' || fs.existsSync(item.path));
    if (this.items.length !== before) this.saveSoon();
    return this;
  }

  list() {
    return this.items;
  }

  get(id) {
    return this.items.find((item) => item.id === id);
  }

  /** 항목을 추가하고, 최대 개수를 넘어 밀려난 항목들을 돌려준다. */
  add(item) {
    this.items.unshift(item);
    const evicted = this.items.splice(this.max);
    this.saveSoon();
    return evicted;
  }

  remove(id) {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const [item] = this.items.splice(index, 1);
    this.saveSoon();
    return item;
  }

  saveSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), 200);
    this.timer.unref?.();
  }

  saveNow() {
    clearTimeout(this.timer);
    this.timer = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: this.items }, null, 1));
    fs.renameSync(tmp, this.file);
  }
}

function isValidItem(item) {
  if (!item || typeof item.id !== 'string' || typeof item.createdAt !== 'number') return false;
  if (item.kind === 'file') return typeof item.path === 'string' && typeof item.name === 'string';
  if (item.kind === 'text') return typeof item.text === 'string';
  return false;
}
