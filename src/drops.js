// 링크로 주고받기: 쏙이 없는 사람(예: 민수)에게 https://<중계 서버>/minsu 같은 링크와 비밀번호를 주면,
// 그 사람은 웹에서 이 PC로 보내고, 이 PC가 그 사람에게 보낸 파일을 받아 간다. 이 PC의 다른 목록·파일은 볼 수 없다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DROP_ID = /^[0-9a-f]{16}$/;
/** 링크 이름: 영문 소문자·숫자·-, 3~30자 (주소에 그대로 쓴다) */
export const LINK_NAME = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
export const DROP_DAYS = [1, 7, 30, 0]; // 0 = 끌 때까지
const RESERVED = new Set(['api', 'admin', 'relay', 'ssok', 'www', 'app', 'static', 'assets', 'login', 'help']);
const MAX_LINKS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WRONG = 10; // 비밀번호를 이만큼 틀리면 잠시 막는다
const LOCK_MS = 10 * 60_000; // 처음 막는 시간. 또 막힐 때마다 두 배로 (하루까지)
const AUTO_LETTERS = 'abcdefghjkmnpqrstuvwxyz23456789'; // 헷갈리는 0/o, 1/l/i 제외

export function cleanLinkName(input) {
  const name = String(input ?? '').trim().toLowerCase();
  return LINK_NAME.test(name) && !name.includes('--') && !RESERVED.has(name) ? name : null;
}

/** 저장된 링크의 비밀번호 (예전에 만든 4자리도 계속 쓴다) */
export const isValidPin = (pin) => typeof pin === 'string' && /^\S{4,20}$/.test(pin);
/** 새로 만드는 링크의 비밀번호: 6자 이상 (4자리는 하루 이틀이면 다 넣어 볼 수 있다) */
export const isStrongPin = (pin) => typeof pin === 'string' && /^\S{6,20}$/.test(pin);

/** 링크를 만들 때 미리 채워 줄 비밀번호 (숫자 6자리) */
export const suggestPin = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

export class DropBook {
  constructor(file, { now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.links = [];
    this.saveTimer = null;
    this.wrong = new Map(); // 링크 번호 → { count, since, lockouts, lockedUntil, lastWrongAt } (비밀번호 틀린 기록)
    this.onLock = null; // (link, { minutes, times }) 비밀번호를 너무 많이 틀려 막았을 때 (PC 주인에게 알린다)
    this.onGone = null; // (link) 기간이 지나 지운 링크 (중계 서버의 이름과 보내 둔 파일을 정리한다)
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.links = (data.links || []).filter(
        (l) => DROP_ID.test(l.id) && cleanLinkName(l.name) && isValidPin(l.pin) && typeof l.label === 'string' && (l.expiresAt === null || Number.isFinite(l.expiresAt)),
      );
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`링크 목록을 읽지 못했어요: ${err.message}`);
    }
    return this;
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, links: this.links }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** 전송 횟수처럼 자주 바뀌는 값은 모아서 저장한다 */
  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.saveNow(), 2000);
    this.saveTimer.unref?.();
  }

  isLive(link) {
    return link.expiresAt === null || link.expiresAt > this.now();
  }

  /** 기간이 지난 링크는 지우고, 지운 링크들을 돌려준다 (중계 서버에서 이름을 놓아주려고) */
  prune() {
    const gone = this.links.filter((l) => !this.isLive(l));
    if (gone.length) {
      this.links = this.links.filter((l) => this.isLive(l));
      for (const l of gone) this.wrong.delete(l.id);
      this.saveNow();
      for (const l of gone) this.onGone?.(l);
    }
    return gone;
  }

  list() {
    this.prune();
    return [...this.links].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 새 링크 이름 (자동): 'k7m2qx' */
  autoName() {
    for (;;) {
      const name = [...crypto.randomBytes(6)].map((b) => AUTO_LETTERS[b % AUTO_LETTERS.length]).join('');
      if (!this.links.some((l) => l.name === name)) return name;
    }
  }

  /**
   * @param {{label?: string, name?: string, pin: string, days?: number}} options
   *   name을 비우면 자동으로 정한다. days: 1, 7, 30, 0(끌 때까지)
   */
  create({ label, name, pin, days }) {
    this.prune();
    if (this.links.length >= MAX_LINKS) throw Object.assign(new Error(`링크는 ${MAX_LINKS}개까지 만들 수 있어요. 안 쓰는 링크를 꺼 주세요.`), { status: 409 });
    const wanted = String(name ?? '').trim();
    const clean = wanted ? cleanLinkName(wanted) : this.autoName();
    if (!clean) {
      throw Object.assign(new Error('링크 이름은 영문 소문자·숫자·-로 3~30자예요. 예: minsu, mom-2'), { status: 400 });
    }
    if (this.links.some((l) => l.name === clean)) throw Object.assign(new Error(`‘${clean}’은(는) 이미 쓰고 있어요.`), { status: 409 });
    if (!isStrongPin(pin)) throw Object.assign(new Error('비밀번호는 띄어쓰기 없이 6~20자로 정해 주세요. (숫자만 쓴다면 6자리 이상)'), { status: 400 });
    const span = DROP_DAYS.includes(Number(days)) ? Number(days) : 7;
    const cleanLabel = String(label ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
    const link = {
      id: crypto.randomBytes(8).toString('hex'),
      name: clean,
      pin,
      label: cleanLabel || clean,
      createdAt: this.now(),
      expiresAt: span === 0 ? null : this.now() + span * DAY_MS,
      count: 0,
      bytes: 0,
    };
    this.links.push(link);
    this.saveNow();
    return link;
  }

  /** 링크를 끈다. 끈 링크를 돌려준다 (없으면 null). */
  remove(id) {
    const link = this.links.find((l) => l.id === id) ?? null;
    if (!link) return null;
    this.links = this.links.filter((l) => l !== link);
    this.wrong.delete(id);
    this.saveNow();
    return link;
  }

  /** 쓸 수 있는 링크 (없거나 기간이 지났으면 null) */
  active(id) {
    if (!DROP_ID.test(String(id))) return null;
    const link = this.links.find((l) => l.id === id);
    return link && this.isLive(link) ? link : null;
  }

  /**
   * 비밀번호 확인: 'ok' | 'wrong' | 'locked'.
   * 10분 안에 10번 틀리면 막고, 막힌 동안은 맞아도 들이지 않는다 (짐작으로 맞히지 못하게).
   * 막는 시간은 10분에서 시작해 또 막힐 때마다 두 배(하루까지). 하루 동안 틀린 적이 없으면 처음부터 다시 센다.
   */
  checkPin(link, pin) {
    const now = this.now();
    let entry = this.wrong.get(link.id);
    if (entry && !(entry.lockedUntil > now) && now - entry.lastWrongAt > DAY_MS) {
      this.wrong.delete(link.id);
      entry = undefined;
    }
    if (entry?.lockedUntil > now) return 'locked';
    if (entry?.lockedUntil) Object.assign(entry, { lockedUntil: 0, count: 0, since: now }); // 막힌 시간이 지났다
    if (entry && now - entry.since > LOCK_MS) Object.assign(entry, { count: 0, since: now }); // 띄엄띄엄 틀린 것은 새로 센다
    const given = Buffer.from(String(pin ?? ''));
    const expected = Buffer.from(link.pin);
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return 'ok';
    if (pin === undefined || pin === '') return 'wrong'; // 아직 넣지 않았다: 세지 않는다
    if (!entry) {
      entry = { count: 0, since: now, lockouts: 0, lockedUntil: 0, lastWrongAt: now };
      this.wrong.set(link.id, entry);
    }
    entry.count++;
    entry.lastWrongAt = now;
    if (entry.count >= MAX_WRONG) {
      const ms = Math.min(DAY_MS, LOCK_MS * 2 ** entry.lockouts);
      entry.lockedUntil = now + ms;
      entry.lockouts++;
      link.lockCount = (link.lockCount || 0) + 1;
      link.lastLockAt = now;
      this.saveSoon();
      try {
        this.onLock?.(link, { minutes: Math.round(ms / 60_000), times: entry.lockouts });
      } catch {
        // 알림이 실패해도 막는 것은 그대로
      }
    }
    return 'wrong';
  }

  /** 이 링크로 받은 양을 센다 (PC 화면에 보여 줌) */
  record(id, bytes, newFile = true) {
    const link = this.active(id);
    if (!link) return;
    if (newFile) link.count += 1;
    link.bytes += Math.max(0, Number(bytes) || 0);
    this.saveSoon();
  }
}
