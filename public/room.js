// 홈페이지 첫 화면: 설치 없이 여러 기기(최대 10대)가 같은 방(6자리 코드)에 모여 주고받는다.
// 방의 약속(방 열쇠 건네기, 암호화, 받는 사람 지정)은 room-core.js에 있다.
import { FRAME, CHUNK } from './relay.js';
import { RoomPeer } from './room-core.js';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const VIEWS = ['pin-view', 'home-view', 'wait-view', 'session-view', 'notice-view'];
const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/room`;

let peer = null;
let target = 0; // 0 = 모두, 아니면 그 기기 번호
let nextId = 1;
const outgoing = new Map(); // 보내는 중: 번호 → { abort, view, update, size, to, acked: 받을 기기 → 받은 양, heard: 받을 기기 → 마지막 소식, done }
const incoming = new Map(); // 받는 중: '보낸 기기:번호' → { name, size, type, chunks, received, view, update, from }
let sending = Promise.resolve(); // 보낼 파일은 하나씩 차례로
const keyHolders = new Set(); // 방 열쇠를 가진 것으로 아는 다른 기기 ('모두'에게 보낼 때 받을 기기로 센다)
let joinedAt = 0;
// 중계 서버가 연결을 끊은 이유 → 화면 문구
const CLOSE_REASONS = {
  silent: '한동안 응답이 없어 방에서 빠졌어요 (화면이 꺼졌거나 다른 앱을 쓰는 동안).',
  stalled: '받는 것이 오래 막혀 방에서 빠졌어요.',
  'pin changed': '홈페이지 암호가 바뀌어 방이 닫혔어요.',
  'web off': '홈페이지 주고받기가 꺼졌어요.',
  'server closing': '중계 서버가 다시 시작해요. 잠시 뒤 새로 시작해 주세요.',
};

// ---- 화면 도구 ----
function show(id) {
  for (const v of VIEWS) $(v).hidden = v !== id;
}

function setStatus(state, text) {
  $('status').dataset.state = state;
  $('status-text').textContent = text;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(id) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

function toast(message, type = '') {
  const node = el('div', `toast ${type}`.trim());
  node.setAttribute('role', type === 'error' ? 'alert' : 'status');
  node.append(el('span', '', message));
  $('toasts').append(node);
  while ($('toasts').children.length > 2) $('toasts').firstElementChild.remove();
  setTimeout(() => node.remove(), type === 'error' ? 6000 : 3000);
}

function formatSize(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** 다른 기기 화면에 보일 이 기기 이름 */
function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? '안드로이드 휴대폰' : '안드로이드 태블릿';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Macintosh/.test(ua)) return 'Mac';
  return '다른 기기';
}

/** 화면에 보일 기기 이름: 같은 이름이 여럿이면 들어온 순서대로 'iPhone 2'처럼 번호를 붙인다 */
function displayNames() {
  const names = new Map();
  const seen = new Map();
  for (const m of peer ? peer.memberList() : []) {
    const count = (seen.get(m.device) ?? 0) + 1;
    seen.set(m.device, count);
    names.set(m.id, count > 1 ? `${m.device} ${count}` : m.device);
  }
  return names;
}
const nameOf = (id) => displayNames().get(id) ?? '나간 기기';

/** 방에서 보일 내 이름 (이 브라우저에 기억) */
const NAME_KEY = 'ssok.roomName';
function myName() {
  let saved = '';
  try {
    saved = localStorage.getItem(NAME_KEY) || '';
  } catch {
    saved = '';
  }
  return saved.trim().slice(0, 40) || deviceName();
}
function saveName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // 저장하지 못하면 다음에 다시 정한다
  }
}
const others = () => (peer ? peer.memberList().filter((m) => !m.me).map((m) => ({ ...m, device: nameOf(m.id) })) : []);

function notice(title, text) {
  closeRoom();
  show('notice-view');
  $('notice-title').textContent = title;
  $('notice-text').textContent = text;
  setStatus('offline', '연결 안 됨');
}

// ---- 시작: 암호 → 첫 화면 ----
async function start() {
  let status;
  try {
    status = await (await fetch('/api/web/status', { cache: 'no-store' })).json();
  } catch {
    return notice('연결하지 못했어요', '인터넷 연결을 확인하고 새로 고쳐 주세요.');
  }
  if (!status.enabled) {
    show('notice-view');
    $('notice-title').textContent = '홈페이지 주고받기가 꺼져 있어요';
    $('notice-text').textContent = 'PC에 쏙을 설치해 쓰는 중이라면, PC 화면의 [어디서나] QR을 휴대폰으로 찍어 주세요.';
    $('notice-home').hidden = true;
    return setStatus('offline', '꺼짐');
  }
  if (!status.authed) {
    show('pin-view');
    setStatus('waiting', '암호 필요');
    return $('pin-input').focus();
  }
  goHome();
}

function goHome() {
  opening++;
  closeRoom();
  show('home-view');
  $('my-name').value = myName() === deviceName() ? '' : myName();
  $('my-name').placeholder = `예: 민수 노트북 (비우면 ‘${deviceName()}’)`;
  setStatus('waiting', '준비됨');
  // QR로 들어왔으면 (주소 끝 #123456) 바로 그 방에 들어간다
  const code = /^#(\d{6})$/.exec(location.hash)?.[1];
  if (code) {
    history.replaceState(null, '', '/');
    joinRoom(code);
  }
}

$('pin-view').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = $('pin-input').value.trim();
  const res = await fetch('/api/web/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) }).catch(() => null);
  if (res?.status === 204) return goHome();
  let message = '암호가 맞지 않아요.';
  try {
    message = (await res.json()).error || message;
  } catch {
    // 기본 문구
  }
  $('pin-error').hidden = false;
  $('pin-error').textContent = res ? message : '연결하지 못했어요. 다시 해 주세요.';
  $('pin-input').value = '';
  $('pin-input').focus();
});
$('pin-input').addEventListener('input', () => {
  if (/^\d{4}$/.test($('pin-input').value)) $('pin-view').requestSubmit();
});

// ---- 방 만들기·들어가기 ----
function closeRoom() {
  const old = peer;
  peer = null;
  old?.close();
  target = 0;
  for (const out of outgoing.values()) out.abort = true;
  outgoing.clear();
  incoming.clear();
  keyHolders.clear();
  missedTexts.clear();
  for (const node of $('log').querySelectorAll('a[download], img')) {
    const url = node.href || node.src;
    if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
  }
  $('log').replaceChildren();
  $('log-card').hidden = true;
  $('invite-box').hidden = true;
  $('gone').hidden = true;
}

/** 연결이 끊겼다: 받은 파일은 지우지 않고 그대로 두어 저장할 수 있게 한다 */
function disconnected(text) {
  peer = null;
  for (const job of outgoing.values()) job.abort = true;
  for (const entry of incoming.values()) {
    entry.chunks = [];
    entry.view.dir.textContent = '받다가 끊김';
    entry.view.row.querySelector('.bar')?.remove();
  }
  incoming.clear();
  keyHolders.clear();
  if ($('session-view').hidden) return notice('연결이 끊겼어요', text);
  $('gone').hidden = false;
  $('gone-text').textContent = $('log').querySelector('a[download]') ? `${text} 받은 파일은 아래에서 저장할 수 있어요.` : text;
  $('key-wait').hidden = true;
  $('targets').replaceChildren();
  setStatus('offline', '연결 끊김');
}

/** 저장하지 않은 받은 파일이 있으면 나가기 전에 묻는다 */
function confirmLeave() {
  const unsaved = $('log').querySelector('a[download]:not([data-saved])');
  if (incoming.size) return confirm('받는 중인 파일이 있어요. 그래도 나갈까요?');
  if (unsaved) return confirm('저장하지 않은 받은 파일이 있어요. 나가면 사라져요. 그래도 나갈까요?');
  return true;
}

let opening = 0; // 방을 여는 차례: 여는 사이 첫 화면으로 돌아가면 열린 연결은 닫는다
let busy = false; // 방을 여는 중 (코드를 다 치자마자 저절로 들어가는데 [들어가기]도 누르면 두 번 들어가지 않게)
async function openRoom(options) {
  if (busy) return;
  busy = true;
  try {
    await openRoomOnce(options);
  } finally {
    busy = false;
  }
}
async function openRoomOnce(options) {
  if ($('my-name').value.trim()) saveName($('my-name').value.trim());
  else saveName('');
  const turn = ++opening;
  closeRoom();
  for (const id of ['create', 'join-code']) $(id).disabled = true;
  setStatus('connecting', options.create ? '방을 만드는 중…' : '들어가는 중…');
  let room;
  try {
    room = await RoomPeer.open(wsUrl, { ...options, device: myName() });
  } catch (err) {
    for (const id of ['create', 'join-code']) $(id).disabled = false;
    if (turn !== opening) return;
    if (err.code === 'CONNECT' || err.code === 'CLOSED') return notice('연결하지 못했어요', '암호가 바뀌었을 수 있어요. 새로 고쳐 다시 해 주세요.');
    return notice(err.code === 'no-room' ? '방을 찾지 못했어요' : '방에 들어가지 못했어요', err.message);
  }
  for (const id of ['create', 'join-code']) $(id).disabled = false;
  if (turn !== opening) return room.close(); // 그사이 다른 방을 열었으면 이 연결은 닫는다
  peer = room;
  joinedAt = Date.now();
  // 내가 들어오기 전부터 있던 기기는 방 열쇠를 가지고 있다. 새로 들어오는 기기는 열쇠를 받았다고 알려 올 때까지 기다린다.
  for (const m of room.memberList()) if (!m.me) keyHolders.add(m.id);
  room.onMembers = (list, change) => {
    if (peer !== room) return;
    if (change?.joined) toast(`${nameOf(change.joined.id)}이(가) 들어왔어요.`);
    if (change?.renamed) toast(`${change.renamed.from} → ${change.renamed.to}(으)로 이름을 바꿨어요.`);
    if (change?.left) {
      toast(`${change.left.device}이(가) 나갔어요.`);
      keyHolders.delete(change.left.id);
      missedTexts.delete(change.left.id);
      if (target === change.left.id) {
        target = 0;
        toast('보낼 곳이 ‘모두’로 바뀌었어요.');
      }
      // 그 기기에 보내던 파일은 그 기기를 빼고 마저 센다
      for (const job of outgoing.values()) job.forget?.(change.left.id);
      for (const [key, entry] of incoming) {
        if (entry.from === change.left.id) {
          incoming.delete(key);
          entry.view.dir.textContent = '보내던 기기가 나감';
        }
      }
    }
    renderRoom();
  };
  room.onFrame = (from, type, id, payload) => peer === room && onFrame(from, type, id, payload);
  room.onClose = (reason) => {
    if (peer === room) disconnected(room.lastError?.message || CLOSE_REASONS[reason] || '연결이 끊겼어요. 다시 주고받으려면 새로 시작하세요.');
  };
  for (const [id, code, host] of [['room-code', 'room-qr', 'room-host'], ['invite-code', 'invite-qr', 'invite-host']]) {
    $(id).textContent = `${room.code.slice(0, 3)} ${room.code.slice(3)}`;
    $(code).innerHTML = room.qrSvg; // 중계 서버가 만든 SVG
    $(host).textContent = location.host;
  }
  room.keyed.then(() => {
    if (peer !== room) return;
    room.send(0, FRAME.ROOM_READY, 0, {}).catch(() => {}); // 방 열쇠를 받았다고 모두에게 알린다
    renderRoom();
  });
  setTimeout(() => peer === room && !room.ready && renderRoom(), 20_000); // 열쇠가 오래 안 오면 안내를 바꾼다
  renderRoom();
}

/** 방 화면: 혼자면 코드를 보여 주며 기다리고, 누가 있으면 주고받는 화면 */
function renderRoom() {
  if (!peer) return;
  const list = others();
  const inSession = !$('session-view').hidden;
  // 방을 만들고 아직 아무도 안 들어왔으면 코드를 크게 보여 주며 기다린다 (주고받다가 모두 나가면 그 화면에 그대로 둔다)
  if (!list.length && !inSession && peer.ready) {
    show('wait-view');
    setStatus('waiting', '다른 기기를 기다리는 중');
    return;
  }
  show('session-view');
  $('peer-name').textContent = list.length ? `방 · ${list.length + 1}대` : '방 · 다른 기기를 기다리는 중';
  $('me-line').textContent = `나: ${peer.device} · 함께: ${list.map((m) => m.device).join(', ') || '아직 없음'}`;
  $('key-wait').hidden = peer.ready;
  if (!peer.ready) {
    $('key-wait').textContent = !list.length
      ? '방 열쇠를 건네줄 기기가 모두 나갔어요. [나가기]를 누르고 새 방을 만들어 주세요.'
      : Date.now() - joinedAt > 20_000
        ? '방 열쇠를 아직 받지 못했어요. 방을 만든 기기의 화면이 켜져 있는지 확인해 주세요.'
        : '방 열쇠를 받는 중이에요… (방에 있는 기기가 건네줘요)';
  }
  setStatus(peer.ready ? 'online' : 'connecting', peer.ready ? `${list.length + 1}대 연결됨` : '방 열쇠 받는 중…');
  const chips = [chip(0, '모두')].concat(list.map((m) => chip(m.id, m.device)));
  $('targets').replaceChildren(...chips);
}

function chip(id, label) {
  const button = el('button', 'chip');
  button.type = 'button';
  button.setAttribute('aria-pressed', String(target === id));
  button.append(el('span', 'chip-name', label));
  button.addEventListener('click', () => {
    target = id;
    renderRoom();
  });
  return button;
}

$('create').addEventListener('click', () => openRoom({ create: true }));
function joinRoom(code) {
  $('home-error').hidden = true;
  if (!/^\d{6}$/.test(code)) {
    $('home-error').hidden = false;
    $('home-error').textContent = '방 코드는 숫자 6자리예요.';
    return;
  }
  openRoom({ code });
}
$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  joinRoom($('join-code').value.replace(/\D/g, ''));
});
$('join-code').addEventListener('input', () => {
  const digits = $('join-code').value.replace(/\D/g, '');
  if (digits.length === 6) joinRoom(digits);
});
$('wait-cancel').addEventListener('click', goHome);
$('invite').addEventListener('click', () => ($('invite-box').hidden = !$('invite-box').hidden));
$('rename').addEventListener('click', () => {
  const name = prompt('이 방에서 보일 내 이름', peer?.device ?? myName());
  if (!name?.trim() || !peer) return;
  saveName(name.trim());
  peer.rename(name.trim());
});
$('leave').addEventListener('click', () => confirmLeave() && goHome());
$('gone-home').addEventListener('click', () => confirmLeave() && goHome());
$('notice-home').addEventListener('click', goHome);

// ---- 주고받은 것 목록 ----
function addRow(direction, iconId, name, who) {
  const row = el('li', 'xfer');
  const top = el('div', 'xfer-top');
  const nameEl = el('span', iconId === 'i-text' ? 'xfer-text' : 'xfer-name', name);
  const dir = el('span', 'dir', '');
  top.append(icon(iconId), nameEl, dir);
  row.append(top);
  const sub = el('div', 'dir', direction === 'out' ? `→ ${who}` : `← ${who}`);
  row.append(sub);
  $('log').prepend(row);
  $('log-card').hidden = false;
  return { row, top, dir };
}

function progressBar(row) {
  const bar = el('div', 'bar');
  const fill = el('div');
  fill.style.width = '0%';
  bar.append(fill);
  row.append(bar);
  return (done, total) => (fill.style.width = `${total ? Math.min(100, (done / total) * 100).toFixed(1) : 100}%`);
}

// ---- 보내기 ----
// 받는 기기들이 받은 만큼 알려 준다(FILE_PROGRESS). 진행률은 '상대가 실제로 받은 양'으로 보여 주고,
// 가장 느린 기기보다 WINDOW 이상 앞서 보내지 않는다 (중간에 쌓여 '보냄'이 먼저 뜨고 한참 기다리는 일이 없게).
const WINDOW = 8 * 1024 * 1024;
const STUCK_MS = 15_000; // 이만큼 아무 소식 없이 뒤처진 기기는 빼고 마저 보낸다 (잠든 휴대폰, 방 열쇠를 아직 못 받은 기기 등)
const LATE_MS = 4000; // 이만큼 소식이 없으면 '○○ 기다리는 중'으로 알린다
const skipping = new Set(); // 지금 보내는 파일에서 뺀 기기들 (중계 서버도 그 기기에는 보내지 않는다)
const missedTexts = new Map(); // 뺀 동안 '모두'에게 보낸 글: 기기 번호 → [{ id, text }] (그 기기가 다시 소식을 보내오면 따로 보낸다)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendFiles(files) {
  if (!peer?.ready) return toast('방 열쇠를 받은 뒤에 보낼 수 있어요.', 'error');
  if (!others().length) return toast('아직 방에 다른 기기가 없어요. [더 초대]로 코드를 알려 주세요.', 'error');
  for (const file of files) {
    const id = nextId++;
    const to = target;
    const view = addRow('out', 'i-file', file.name || '파일', to === 0 ? '모두' : nameOf(to));
    view.dir.textContent = `${formatSize(file.size)} · 기다리는 중`;
    const job = { abort: false, view, update: progressBar(view.row), size: file.size, to, acked: new Map(), heard: new Map(), done: new Set() };
    outgoing.set(id, job);
    sending = sending.then(() => sendOne(id, file, job)).catch(() => {});
  }
}

/** 받는 기기 중 가장 덜 받은 양 (받을 기기가 없으면 null) */
function slowest(job) {
  const left = [...job.acked.entries()].filter(([who]) => !job.done.has(who));
  if (!job.acked.size) return null;
  return left.length ? Math.min(...left.map(([, n]) => n)) : job.size;
}

function showSendProgress(job) {
  const got = slowest(job) ?? 0;
  job.update(got, job.size);
  const seconds = Math.max(0.5, (Date.now() - (job.startedAt || Date.now())) / 1000);
  const speed = got / seconds;
  const many = job.acked.size > 1 ? ` · ${job.done.size}/${job.acked.size}대 다 받음` : '';
  // 기다리게 하는 기기: 한참 뒤처졌거나(그 기기 때문에 더 못 보냄), 다 보낸 뒤 '다 받음' 소식이 없는 기기
  // 다른 기기와 견주어 본다: 중계 서버가 멈춘 기기 때문에 보내는 쪽을 잠시 세우면 모두 같이 멈추므로, 소식이 없다는 것만으로는 탓할 수 없다
  const best = Math.max(0, ...[...job.acked.values()]);
  const late = [...job.acked].filter(
    ([who, n]) =>
      !job.done.has(who) &&
      Date.now() - job.heard.get(who) > LATE_MS &&
      (job.ended || best - n >= 256 * 1024 || (job.acked.size === 1 && (job.sent ?? 0) - n > 1024 * 1024)),
  );
  const wait = late.length ? ` · ${late.map(([who]) => nameOf(who)).join(', ')} 기다리는 중` : '';
  job.view.dir.textContent = `${formatSize(got)} / ${formatSize(job.size)} · ${formatSize(speed)}/s${many}${wait}`;
}

async function sendOne(id, file, job) {
  const room = peer;
  if (!room || job.abort) return;
  // 보내기 시작할 때 방에 있는 받을 기기들
  const recipients = job.to === 0 ? others().filter((m) => keyHolders.has(m.id)).map((m) => m.id) : [job.to];
  job.track = recipients.length > 0; // 셀 기기가 없으면 (예전 화면을 쓰는 기기뿐 등) 보내기만 한다
  job.startedAt = Date.now();
  for (const who of recipients) {
    job.acked.set(who, 0);
    job.heard.set(who, job.startedAt);
  }
  job.forget = (who) => {
    if (!job.acked.delete(who)) return;
    job.done.delete(who);
    if (job.acked.size) return finishIfDone(id, job);
    // 받을 기기가 모두 나갔다: 보내는 중이면 아래 고리에서 멈추고, 다 보낸 뒤면 여기서 끝낸다
    if (job.ended) {
      outgoing.delete(id);
      job.view.dir.textContent = '받을 기기가 모두 빠졌어요';
      job.view.row.querySelector('.bar')?.remove();
    }
  };
  job.sent = 0;
  try {
    await room.send(job.to, FRAME.FILE_HEAD, id, { name: file.name || '파일', size: file.size, type: file.type || '', lastModified: file.lastModified || 0 });
    let sent = 0;
    while (sent < file.size) {
      if (job.abort || peer !== room || (job.track && !job.acked.size)) {
        await room.send(job.to, FRAME.FILE_CANCEL, id, {}).catch(() => {});
        job.view.dir.textContent = peer !== room ? '연결이 끊겨 멈췄어요' : job.acked.size || !job.track ? '취소됨' : '받을 기기가 모두 빠졌어요';
        job.view.row.querySelector('.bar')?.remove();
        outgoing.delete(id);
        return;
      }
      // 가장 느린 기기가 따라올 때까지 기다린다. 오래 소식이 없는 기기는 빼고 마저 보낸다.
      if (sent - (slowest(job) ?? sent) > WINDOW) {
        for (const [who, n] of job.acked) {
          if (sent - n > WINDOW && Date.now() - job.heard.get(who) > STUCK_MS) {
            toast(`${nameOf(who)}이(가) 받지 못하고 있어서 빼고 보내요.`, 'error');
            job.forget(who);
            // '모두'에게 보내는 중이면 중계 서버도 그 기기에는 그만 보낸다 (그 기기가 막혀 있으면 중계 서버가 보내는 쪽까지 멈추므로)
            if (job.to === 0) {
              skipping.add(who);
              await room.skip(skipping);
            }
          }
        }
        if (Date.now() - (job.shown || 0) > 500) {
          job.shown = Date.now();
          showSendProgress(job);
        }
        await sleep(40);
        continue;
      }
      const piece = new Uint8Array(await file.slice(sent, sent + CHUNK).arrayBuffer());
      await room.send(job.to, FRAME.FILE_DATA, id, piece);
      // 중계 서버가 멈춘 기기 때문에 잠시 받지 않을 때도 '○○ 기다리는 중'이 보이게 진행 표시를 고친다
      await room.drain(undefined, () => {
        if (Date.now() - (job.shown || 0) < 500) return;
        job.shown = Date.now();
        showSendProgress(job);
      });
      sent += piece.length;
      job.sent = sent;
      showSendProgress(job);
    }
    await room.send(job.to, FRAME.FILE_END, id, {});
    job.ended = true;
    if (!job.track) {
      outgoing.delete(id);
      job.view.dir.textContent = '보냄';
      job.view.row.querySelector('.bar')?.remove();
      return;
    }
    if (outgoing.has(id)) showSendProgress(job);
    // 다 보낸 뒤에도 오래 소식이 없는 기기는 빼고 끝낸다 (다음 파일은 기다리지 않고 바로 보낸다)
    const watch = setInterval(() => {
      if (!outgoing.has(id) || peer !== room) return clearInterval(watch);
      for (const who of [...job.acked.keys()]) {
        if (!job.done.has(who) && Date.now() - job.heard.get(who) > STUCK_MS) {
          toast(`${nameOf(who)}에서 받았다는 소식이 없어요.`, 'error');
          job.forget(who);
        }
      }
      if (outgoing.has(id)) showSendProgress(job);
    }, 1000);
  } catch {
    job.view.dir.textContent = '보내지 못함';
    outgoing.delete(id);
  } finally {
    // 이 파일을 다 보냈으니 다음 것은 다시 모두에게
    if (skipping.size) {
      skipping.clear();
      room.skip([]).catch(() => {});
    }
  }
}

/** 받을 기기가 모두 다 받았으면 끝 표시 */
function finishIfDone(id, job) {
  if (!job.acked.size || job.done.size < job.acked.size) return;
  outgoing.delete(id);
  job.update(job.size, job.size);
  job.view.dir.textContent = job.acked.size > 1 ? `${job.acked.size}대 모두 받았어요 ✓` : '받았어요 ✓';
  job.view.row.querySelector('.bar')?.remove();
}

async function sendText(text) {
  if (!peer?.ready) throw new Error('방 열쇠를 받은 뒤에 보낼 수 있어요.');
  if (!others().length) throw new Error('아직 방에 다른 기기가 없어요.');
  const id = nextId++;
  await peer.send(target, FRAME.TEXT, id, { text });
  if (target === 0) for (const who of skipping) missedTexts.set(who, [...(missedTexts.get(who) || []), { id, text }]);
  const view = addRow('out', 'i-text', text, target === 0 ? '모두' : nameOf(target));
  view.dir.textContent = '보냄';
}

// ---- 받기 ----
const decodeJson = (payload) => {
  try {
    return JSON.parse(new TextDecoder().decode(payload) || '{}');
  } catch {
    return {};
  }
};

function onFrame(from, type, id, payload) {
  const key = `${from}:${id}`;
  // 멈췄던 기기가 다시 소식을 보냈다: 그동안 못 받은 글을 따로 보낸다
  const missed = missedTexts.get(from);
  if (missed && !skipping.has(from)) {
    missedTexts.delete(from);
    for (const m of missed) peer?.send(from, FRAME.TEXT, m.id, { text: m.text }).catch(() => {});
  }
  if (type === FRAME.FILE_HEAD) {
    const head = decodeJson(payload);
    const name = String(head.name || '파일').slice(0, 200);
    const size = Math.max(0, Number(head.size) || 0);
    const view = addRow('in', 'i-file', name, nameOf(from));
    view.dir.textContent = `${formatSize(size)} · 받는 중`;
    incoming.set(key, { name, size, type: String(head.type || ''), chunks: [], received: 0, view, update: progressBar(view.row), from, lastAt: Date.now() });
    if (size > 1024 ** 3 && /Android|iPhone|iPad/.test(navigator.userAgent)) toast(`${name}: 1GB가 넘어 휴대폰에서는 받다가 멈출 수 있어요.`, 'error');
  } else if (type === FRAME.FILE_DATA) {
    const entry = incoming.get(key);
    if (!entry) return;
    entry.chunks.push(payload.slice());
    entry.received += payload.length;
    entry.lastAt = Date.now();
    // 보낸 기기에 받은 만큼 알린다 (256KB마다): 그 기기의 진행률과 보내는 속도 조절에 쓴다
    if (entry.received - (entry.reported || 0) >= 256 * 1024) {
      entry.reported = entry.received;
      peer?.send(from, FRAME.FILE_PROGRESS, id, { n: entry.received }).catch(() => {});
    }
    entry.update(entry.received, entry.size);
    entry.view.dir.textContent = `${formatSize(entry.received)} / ${formatSize(entry.size)}`;
  } else if (type === FRAME.FILE_END) {
    const entry = incoming.get(key);
    if (!entry) return;
    incoming.delete(key);
    finishIncoming(entry);
    peer?.send(from, FRAME.FILE_DONE, id, {}).catch(() => {});
  } else if (type === FRAME.FILE_CANCEL) {
    const entry = incoming.get(key);
    if (!entry) return;
    incoming.delete(key);
    entry.view.dir.textContent = '보낸 기기가 취소함';
  } else if (type === FRAME.ROOM_READY) {
    keyHolders.add(from);
    renderRoom();
  } else if (type === FRAME.FILE_PROGRESS) {
    const job = outgoing.get(id);
    if (!job || !job.acked.has(from)) return;
    job.acked.set(from, Math.max(job.acked.get(from), Number(decodeJson(payload).n) || 0));
    job.heard.set(from, Date.now());
    showSendProgress(job);
  } else if (type === FRAME.FILE_DONE) {
    const job = outgoing.get(id);
    if (!job || !job.acked.has(from)) return;
    job.acked.set(from, job.size);
    job.done.add(from);
    showSendProgress(job);
    finishIfDone(id, job);
  } else if (type === FRAME.TEXT) {
    const text = String(decodeJson(payload).text ?? '');
    const view = addRow('in', 'i-text', text, nameOf(from));
    const copy = el('button', 'btn small', '복사');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast('복사했어요.');
      } catch {
        toast('복사하지 못했어요. 글자를 길게 눌러 복사해 주세요.', 'error');
      }
    });
    view.top.append(copy);
    toast(`${nameOf(from)}에서 텍스트를 받았어요.`);
  }
}

/** 다 받은 파일: 저장 버튼 (사진이면 미리 보기도) */
function finishIncoming(entry) {
  const preview = /^image\/(png|jpeg|gif|webp)$/.test(entry.type);
  const blob = new Blob(entry.chunks, { type: preview ? entry.type : 'application/octet-stream' });
  entry.chunks = [];
  const url = URL.createObjectURL(blob);
  entry.view.dir.textContent = `${formatSize(blob.size)} · 받음`;
  const save = el('a', 'btn small primary', '저장');
  save.href = url;
  save.download = entry.name;
  save.addEventListener('click', () => (save.dataset.saved = '1'));
  entry.view.top.append(save);
  if (preview && blob.size < 30 * 1024 * 1024) {
    const img = el('img');
    img.alt = entry.name;
    img.onerror = () => img.remove(); // 사진으로 열리지 않으면 미리 보기는 빼고 저장 버튼만
    img.src = url;
    entry.view.row.append(img);
  }
  entry.view.row.querySelector('.bar')?.remove();
  toast(`${entry.name}을(를) 받았어요. [저장]을 눌러 주세요.`);
}

// ---- 입력 ----
for (const id of ['pick-media', 'pick-file', 'pick-any']) {
  $(id).addEventListener('change', (e) => {
    sendFiles([...e.target.files]);
    e.target.value = '';
  });
}
const input = $('text-input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
});
$('text-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  try {
    await sendText(text);
    input.value = '';
    input.style.height = 'auto';
  } catch (err) {
    toast(err.message || '보내지 못했어요. 연결을 확인해 주세요.', 'error');
  }
});
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dragging');
  }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (!$('session-view').hidden && e.dataTransfer?.files?.length) sendFiles([...e.dataTransfer.files]);
});
document.addEventListener('paste', (e) => {
  if (e.target === input || $('session-view').hidden) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    sendFiles(files.map((f) => (f.name && f.name !== 'image.png' ? f : new File([f], `캡처 ${new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-')}.png`, { type: f.type }))));
  }
});
window.addEventListener('beforeunload', (e) => {
  if (!$('session-view').hidden && $('log').querySelector('a[download]:not([data-saved])')) e.preventDefault(); // 받은 파일을 저장하지 않고 닫지 않게
});

// 보내던 기기가 말없이 멈추면 (화면이 꺼짐 등) 받던 것을 1분 뒤 정리한다
setInterval(() => {
  for (const [key, entry] of incoming) {
    if (Date.now() - entry.lastAt < 60_000) continue;
    incoming.delete(key);
    entry.chunks = [];
    entry.view.dir.textContent = '보내던 것이 멈췄어요';
    entry.view.row.querySelector('.bar')?.remove();
  }
}, 5000);

// 파일 고르기 버튼을 키보드로도 (Enter·스페이스)
for (const label of document.querySelectorAll('label.big-btn')) {
  label.tabIndex = 0;
  label.setAttribute('role', 'button');
  label.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    label.querySelector('input')?.click();
  });
}

start();
