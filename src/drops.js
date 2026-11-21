// 받기 링크: 쏙이 없는 사람도 링크를 열면 이 PC로 파일·텍스트를 보낼 수 있다 (받은 목록은 보지 못한다).
// 링크는 https://<중계 서버>/d/<PC 번호>#<링크 번호>.<비밀 열쇠> 꼴이고, # 뒤는 중계 서버로 가지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DROP_ID = /^[0-9a-f]{16}$/;
export const DROP_DAYS = [1, 7, 30];
const MAX_LINKS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

export class DropBook {
  constructor(file, { now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.links = [];
    this.saveTimer = null;
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.links = (data.links || []).filter(
        (l) => DROP_ID.test(l.id) && /^[0-9a-f]{64}$/.test(l.secret) && typeof l.label === 'string' && Number.isFinite(l.expiresAt),
      );
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`받기 링크 목록을 읽지 못했어요: ${err.message}`);
    }
    return this;
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, links: this.links }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** 전송 횟수처럼 자주 바뀌는 값은 모아서 저장한다 */
  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.saveNow(), 2000);
    this.saveTimer.unref?.();
  }

  /** 기간이 지난 링크는 지운다 */
  prune() {
    const before = this.links.length;
    this.links = this.links.filter((l) => l.expiresAt > this.now());
    if (this.links.length !== before) this.saveNow();
  }

  list() {
    this.prune();
    return [...this.links].sort((a, b) => b.createdAt - a.createdAt);
  }

  create({ label, days }) {
    this.prune();
    if (this.links.length >= MAX_LINKS) throw Object.assign(new Error(`받기 링크는 ${MAX_LINKS}개까지 만들 수 있어요. 안 쓰는 링크를 꺼 주세요.`), { status: 409 });
    const clean = String(label ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
    const link = {
      id: crypto.randomBytes(8).toString('hex'),
      secret: crypto.randomBytes(32).toString('hex'),
      label: clean || '받기 링크',
      createdAt: this.now(),
      expiresAt: this.now() + (DROP_DAYS.includes(Number(days)) ? Number(days) : 7) * DAY_MS,
      count: 0,
      bytes: 0,
    };
    this.links.push(link);
    this.saveNow();
    return link;
  }

  remove(id) {
    const before = this.links.length;
    this.links = this.links.filter((l) => l.id !== id);
    if (this.links.length === before) return false;
    this.saveNow();
    return true;
  }

  /** 쓸 수 있는 링크 (없거나 기간이 지났으면 null) */
  active(id) {
    if (!DROP_ID.test(String(id))) return null;
    const link = this.links.find((l) => l.id === id);
    return link && link.expiresAt > this.now() ? link : null;
  }

  /** 이 링크로 받은 양을 센다 (PC 화면에 보여 줌) */
  record(id, bytes) {
    const link = this.active(id);
    if (!link) return;
    link.count += 1;
    link.bytes += Math.max(0, Number(bytes) || 0);
    this.saveSoon();
  }
}
