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
const outgoing = new Map(); // 보내는 중: 번호 → { abort, view, update, expected, done }
const incoming = new Map(); // 받는 중: '보낸 기기:번호' → { name, size, type, chunks, received, view, update, from }
let sending = Promise.resolve(); // 보낼 파일은 하나씩 차례로

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
  closeRoom();
  show('home-view');
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
  $('log').replaceChildren();
  $('log-card').hidden = true;
  $('invite-box').hidden = true;
}

async function openRoom(options) {
  closeRoom();
  setStatus('connecting', options.create ? '방을 만드는 중…' : '들어가는 중…');
  let room;
  try {
    room = await RoomPeer.open(wsUrl, { ...options, device: deviceName() });
  } catch (err) {
    if (err.code === 'CONNECT' || err.code === 'CLOSED') return notice('연결하지 못했어요', '암호가 바뀌었을 수 있어요. 새로 고쳐 다시 해 주세요.');
    return notice(err.code === 'no-room' ? '방을 찾지 못했어요' : '방에 들어가지 못했어요', err.message);
  }
  peer = room;
  room.onMembers = (list, change) => {
    if (peer !== room) return;
    if (change?.joined) toast(`${nameOf(change.joined.id)}이(가) 들어왔어요.`);
    if (change?.left) {
      toast(`${change.left.device}이(가) 나갔어요.`);
      if (target === change.left.id) target = 0;
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
  room.onClose = () => {
    if (peer === room) notice('연결이 끊겼어요', '다시 주고받으려면 새로 시작하세요.');
  };
  for (const [id, code, host] of [['room-code', 'room-qr', 'room-host'], ['invite-code', 'invite-qr', 'invite-host']]) {
    $(id).textContent = `${room.code.slice(0, 3)} ${room.code.slice(3)}`;
    $(code).innerHTML = room.qrSvg; // 중계 서버가 만든 SVG
    $(host).textContent = location.host;
  }
  room.keyed.then(() => peer === room && renderRoom());
  renderRoom();
}

/** 방 화면: 혼자면 코드를 보여 주며 기다리고, 누가 있으면 주고받는 화면 */
function renderRoom() {
  if (!peer) return;
  const list = others();
  const inSession = !$('session-view').hidden;
  // 방을 만들고 아직 아무도 안 들어왔으면 코드를 크게 보여 주며 기다린다 (주고받다가 모두 나가면 그 화면에 그대로 둔다)
  if (!list.length && !inSession) {
    show('wait-view');
    setStatus('waiting', '다른 기기를 기다리는 중');
    return;
  }
  show('session-view');
  $('peer-name').textContent = list.length ? `방 · ${list.length + 1}대` : '방 · 다른 기기를 기다리는 중';
  $('key-wait').hidden = peer.ready;
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
$('leave').addEventListener('click', () => {
  if (incoming.size && !confirm('받는 중인 파일이 있어요. 그래도 나갈까요?')) return;
  goHome();
});
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
function sendFiles(files) {
  if (!peer?.ready) return toast('방 열쇠를 받은 뒤에 보낼 수 있어요.', 'error');
  if (!others().length) return toast('아직 방에 다른 기기가 없어요. [더 초대]로 코드를 알려 주세요.', 'error');
  for (const file of files) {
    const id = nextId++;
    const to = target;
    const expected = to === 0 ? others().length : 1;
    const view = addRow('out', 'i-file', file.name || '파일', to === 0 ? '모두' : nameOf(to));
    view.dir.textContent = `${formatSize(file.size)} · 기다리는 중`;
    const job = { abort: false, view, update: progressBar(view.row), expected, done: 0 };
    outgoing.set(id, job);
    sending = sending.then(() => sendOne(id, to, file, job)).catch(() => {});
  }
}

async function sendOne(id, to, file, job) {
  const room = peer;
  if (!room || job.abort) return;
  try {
    await room.send(to, FRAME.FILE_HEAD, id, { name: file.name || '파일', size: file.size, type: file.type || '', lastModified: file.lastModified || 0 });
    let done = 0;
    while (done < file.size) {
      if (job.abort || peer !== room) {
        await room.send(to, FRAME.FILE_CANCEL, id, {}).catch(() => {});
        job.view.dir.textContent = '취소됨';
        return;
      }
      const piece = new Uint8Array(await file.slice(done, done + CHUNK).arrayBuffer());
      await room.send(to, FRAME.FILE_DATA, id, piece);
      await room.drain();
      done += piece.length;
      job.update(done, file.size);
      job.view.dir.textContent = `${formatSize(done)} / ${formatSize(file.size)}`;
    }
    await room.send(to, FRAME.FILE_END, id, {});
    job.view.dir.textContent = `${formatSize(file.size)} · 보냄 (받는 중)`;
  } catch {
    job.view.dir.textContent = '보내지 못함';
    outgoing.delete(id);
  }
}

async function sendText(text) {
  if (!peer?.ready) throw new Error('방 열쇠를 받은 뒤에 보낼 수 있어요.');
  if (!others().length) throw new Error('아직 방에 다른 기기가 없어요.');
  await peer.send(target, FRAME.TEXT, nextId++, { text });
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
  if (type === FRAME.FILE_HEAD) {
    const head = decodeJson(payload);
    const name = String(head.name || '파일').slice(0, 200);
    const size = Math.max(0, Number(head.size) || 0);
    const view = addRow('in', 'i-file', name, nameOf(from));
    view.dir.textContent = `${formatSize(size)} · 받는 중`;
    incoming.set(key, { name, size, type: String(head.type || ''), chunks: [], received: 0, view, update: progressBar(view.row), from });
    if (size > 1024 ** 3 && /Android|iPhone|iPad/.test(navigator.userAgent)) toast(`${name}: 1GB가 넘어 휴대폰에서는 받다가 멈출 수 있어요.`, 'error');
  } else if (type === FRAME.FILE_DATA) {
    const entry = incoming.get(key);
    if (!entry) return;
    entry.chunks.push(payload.slice());
    entry.received += payload.length;
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
  } else if (type === FRAME.FILE_DONE) {
    const job = outgoing.get(id);
    if (!job) return;
    job.done += 1;
    job.view.dir.textContent = job.expected > 1 ? `${job.done}/${job.expected}대 받음` : '받았어요 ✓';
    if (job.done >= job.expected) {
      outgoing.delete(id);
      job.view.dir.textContent = job.expected > 1 ? `${job.expected}대 모두 받았어요 ✓` : '받았어요 ✓';
      job.view.row.querySelector('.bar')?.remove();
    }
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
  const blob = new Blob(entry.chunks, { type: entry.type || 'application/octet-stream' });
  entry.chunks = [];
  const url = URL.createObjectURL(blob);
  entry.view.dir.textContent = `${formatSize(blob.size)} · 받음`;
  const save = el('a', 'btn small primary', '저장');
  save.href = url;
  save.download = entry.name;
  entry.view.top.append(save);
  if (/^image\/(png|jpeg|gif|webp)$/.test(entry.type) && blob.size < 30 * 1024 * 1024) {
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
  if (!$('session-view').hidden && $('log').querySelector('a[download]')) e.preventDefault(); // 받은 파일을 저장하지 않고 닫지 않게
});

start();
