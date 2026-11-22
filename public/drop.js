// 링크 화면 (https://<중계 서버>/<링크 이름>, 예: ssok.example.com/minsu):
// 쏙이 없는 사람이 비밀번호를 넣고 그 PC로 보내거나, 그 PC가 보내 준 것을 받아 간다.
// 중계 서버를 거치지만, 열쇠는 이 브라우저와 그 PC가 그 자리에서 만들고(ECDH) 비밀번호는 암호화된 통로 안에서만 보낸다.
import { RelayClient } from './relay.js';

const APP_ID = '{{APP_ID}}';
const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';

const linkName = location.pathname.replace(/^\/|\/$/g, '').toLowerCase();
const PIN_KEY = `${APP_ID}.pin.${linkName}`;
const store = {
  get: () => {
    try {
      return localStorage.getItem(PIN_KEY);
    } catch {
      return null;
    }
  },
  set: (value) => {
    try {
      if (value) localStorage.setItem(PIN_KEY, value);
      else localStorage.removeItem(PIN_KEY);
    } catch {
      // 저장하지 못하면 다음에 다시 묻는다
    }
  },
};

let target = null; // { pcId, linkId }
let pin = store.get();
let connection = null;
let pcName = '상대 PC';
let current = null; // 보내는 중 { abort }
let inboxTimer = null;
const downloaded = new Set();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(id, className = 'icon') {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

function setStatus(state, text) {
  $('status').dataset.state = state;
  $('status-text').textContent = text;
}

function toast(message, type = '') {
  const node = el('div', `toast ${type}`.trim());
  node.setAttribute('role', type === 'error' ? 'alert' : 'status');
  node.append(el('span', '', message));
  $('toasts').append(node);
  while ($('toasts').children.length > 2) $('toasts').firstElementChild.remove();
  setTimeout(() => node.remove(), type === 'error' ? 6000 : 3000);
}

function show(...ids) {
  for (const id of ['pin-form', 'drop-ready', 'drop-main', 'transfer', 'inbox-card', 'locked']) $(id).hidden = !ids.includes(id);
}

function showLocked(title, text) {
  show('locked');
  $('locked-title').textContent = title;
  $('locked-text').textContent = text;
}

function askPin(error = '') {
  clearInterval(inboxTimer);
  show('pin-form');
  setStatus('waiting', '비밀번호 필요');
  $('pin-error').hidden = !error;
  $('pin-error').textContent = error;
  $('pin-input').value = '';
  $('pin-input').focus();
}

const expired = () => {
  clearInterval(inboxTimer);
  setStatus('offline', '쓸 수 없는 링크');
  showLocked('이 링크는 꺼졌거나 기간이 지났어요', '링크를 보낸 사람에게 새 링크를 달라고 해 주세요.');
};

function connect() {
  connection ??= RelayClient.connect(`wss://${location.host}/ws/c/${target.pcId}`, 'ecdh', {
    kid: `d:${target.linkId}`,
    auth: { pin: pin ?? '' },
    onClose: () => {
      connection = null;
      if (!current && !$('drop-main').hidden) setStatus('waiting', '잠시 끊김 · 다시 연결해요');
    },
  }).catch((err) => {
    connection = null;
    throw err;
  });
  return connection;
}

function closeConnection() {
  connection?.then((c) => c.close(), () => {});
  connection = null;
}

/** 링크 요청의 답이 '비밀번호 틀림·막힘·꺼짐'이면 화면을 바꾸고 true */
async function handleDenied(res) {
  if (res.status !== 401 && res.status !== 410) return false;
  let code = res.status === 410 ? 'gone' : 'wrong';
  try {
    code = (await res.json()).code || code;
  } catch {
    // 기본값
  }
  closeConnection();
  if (code === 'gone') expired();
  else if (code === 'locked') {
    clearInterval(inboxTimer);
    setStatus('offline', '잠시 막힘');
    showLocked('비밀번호를 너무 많이 틀렸어요', '10분 뒤에 이 화면을 새로 고쳐 다시 해 주세요.');
  } else {
    const hadPin = Boolean(pin);
    pin = null;
    store.set(null);
    askPin(hadPin ? '비밀번호가 맞지 않아요.' : '');
  }
  return true;
}

/** 링크를 찾고, 그 PC와 연결해 이름을 받아 온다. PC가 꺼져 있으면 켜질 때까지 가끔 다시 해 본다. */
async function start() {
  if (!/^[a-z0-9-]{3,30}$/.test(linkName)) return showLocked('링크가 올바르지 않아요', '받은 주소를 그대로 열어 주세요.');
  for (;;) {
    try {
      if (!target) {
        const res = await fetch(`/api/link/${encodeURIComponent(linkName)}`, { cache: 'no-store' });
        if (res.status === 404) {
          setStatus('offline', '없는 링크');
          return showLocked('이 링크를 찾을 수 없어요', '주소를 다시 확인하거나, 링크를 보낸 사람에게 물어봐 주세요.');
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        target = await res.json();
      }
      if (!pin) return askPin();
      const client = await connect();
      const res = await client.request('GET', '/api/drop-info');
      if (await handleDenied(res)) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      pcName = (await res.json()).name || pcName;
      store.set(pin);
      return ready();
    } catch (err) {
      if (err.code === 'UNKNOWN_PEER') return expired();
      setStatus('offline', '상대 PC에 연결하지 못함');
      showLocked('상대 PC가 꺼져 있는 것 같아요', '그 PC가 켜지면 이 화면이 저절로 열려요.');
      await new Promise((r) => setTimeout(r, document.hidden ? 30_000 : 8000));
    }
  }
}

/** '거실PC와', '민수 노트북과': 받침이 있으면 '과' */
function withWa(name) {
  const code = name.trim().slice(-1).charCodeAt(0);
  const batchim = code >= 0xac00 && code <= 0xd7a3 ? (code - 0xac00) % 28 !== 0 : /[lmnr]$/i.test(name.trim());
  return `${name}${batchim ? '과' : '와'}`;
}

function ready() {
  show('drop-ready', 'drop-main');
  $('drop-title').textContent = `${withWa(pcName)} 주고받기`;
  document.title = `${pcName} · 주고받기`;
  $('inbox-title').textContent = `${pcName}에서 받은 것`;
  setStatus('online', '연결됨');
  refreshInbox();
  clearInterval(inboxTimer);
  inboxTimer = setInterval(() => !document.hidden && !current && refreshInbox(), 8000);
}

// ---- 받은 것 (그 PC가 이 링크로 보낸 것) ----
async function refreshInbox() {
  try {
    const client = await connect();
    const res = await client.request('GET', '/api/drop-items');
    if (await handleDenied(res)) return;
    if (!res.ok) return;
    renderInbox((await res.json()).items);
    if ($('locked').hidden && !current) setStatus('online', '연결됨');
  } catch {
    // 다음 확인 때 다시
  }
}

function renderInbox(items) {
  $('inbox-card').hidden = items.length === 0;
  $('inbox').replaceChildren(
    ...items.map((item) => {
      const li = el('li');
      if (item.kind === 'text') {
        li.append(icon('i-text'), el('span', 'text', item.text));
        const copy = el('button', 'btn small', '복사');
        copy.type = 'button';
        copy.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(item.text);
            toast('복사했어요.');
          } catch {
            toast('복사하지 못했어요. 글자를 길게 눌러 복사해 주세요.', 'error');
          }
        });
        li.append(copy);
      } else {
        li.append(icon('i-file'), el('span', 'name', item.name), el('span', 'muted small', formatSize(item.size)));
        const get = el('button', downloaded.has(item.id) ? 'btn small' : 'btn small primary', downloading.has(item.id) ? '받는 중…' : downloaded.has(item.id) ? '다시 받기' : '받기');
        get.type = 'button';
        get.disabled = downloading.has(item.id);
        get.addEventListener('click', () => downloadItem(item, get));
        li.append(get);
      }
      return li;
    }),
  );
}

const downloading = new Set(); // 받는 중인 항목 번호
async function downloadItem(item, button) {
  if (downloading.has(item.id)) return;
  if (item.size > 500 * 1024 * 1024 && !confirm(`‘${item.name}’은(는) ${formatSize(item.size)}예요. 이 기기의 메모리에 모았다가 저장해서, 휴대폰에서는 받다가 멈출 수 있어요. 가능하면 PC에서 받아 주세요.\n\n그래도 받을까요?`)) return;
  downloading.add(item.id);
  button.disabled = true;
  const label = button.textContent;
  button.textContent = '받는 중…';
  try {
    const client = await connect();
    const res = await client.request('GET', `/api/drop-files/${item.id}`);
    if (await handleDenied(res)) return;
    if (!res.ok) throw new Error('받지 못했어요.');
    const blob = await res.blob(item.mime);
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = item.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    downloaded.add(item.id);
    button.textContent = '다시 받기';
    button.className = 'btn small';
    toast(`받았어요 (${formatSize(blob.size)}).`);
  } catch (err) {
    button.textContent = label;
    toast(err.code ? '연결이 끊겼어요. 다시 해 주세요.' : err.message, 'error');
  } finally {
    downloading.delete(item.id);
    button.disabled = false;
    refreshInbox(); // 그사이 목록을 새로 그렸으면 단추가 바뀌었을 수 있다
  }
}

// ---- 보내기 ----
async function errorOf(res) {
  if (await handleDenied(res)) return '이 링크로는 더 보낼 수 없어요.';
  try {
    return (await res.json()).error || '보내지 못했어요.';
  } catch {
    return '보내지 못했어요.';
  }
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

function addSent(label, iconId) {
  const li = el('li');
  li.append(icon(iconId, 'icon sent-icon'), el('span', 'name', label), el('span', 'muted small', '보냄'));
  $('sent').prepend(li);
  $('sent-card').hidden = false;
}

/** 파일을 하나씩 보낸다 (진행률 표시, 취소 가능) */
async function sendFiles(files) {
  const list = [...files];
  if (!list.length || current || $('drop-main').hidden) return;
  const total = list.reduce((n, f) => n + f.size, 0);
  let done = 0;
  current = { abort: null };
  $('transfer').hidden = false;
  setStatus('online', '보내는 중…');
  try {
    for (const [index, file] of list.entries()) {
      const render = (loaded) => {
        const percent = total ? ((done + loaded) / total) * 100 : 100;
        $('transfer-bar').style.width = `${Math.min(100, percent).toFixed(1)}%`;
        $('transfer-title').textContent = list.length > 1 ? `보내는 중 (${index + 1}/${list.length})` : '보내는 중';
        $('transfer-detail').textContent = `${file.name} · ${formatSize(done + loaded)} / ${formatSize(total)}`;
      };
      render(0);
      current.abort = new AbortController();
      const params = new URLSearchParams({ name: file.name || 'file' });
      if (file.lastModified) params.set('lastModified', String(file.lastModified));
      const client = await connect();
      const res = await client.request('POST', `/api/upload?${params}`, {
        headers: { 'x-requested-with': APP_ID, 'content-type': file.type || 'application/octet-stream' },
        body: file,
        onUploadProgress: render,
        signal: current.abort.signal,
      });
      if (!res.ok) throw new Error(await errorOf(res));
      done += file.size;
      addSent(file.name, 'i-check');
    }
    toast(list.length > 1 ? `${list.length}개를 보냈어요.` : '보냈어요.');
  } catch (err) {
    if (err.name === 'AbortError') toast('보내기를 취소했어요.');
    else toast(err.code ? '연결이 끊겼어요. 다시 보내 주세요.' : err.message, 'error');
  } finally {
    current = null;
    $('transfer').hidden = true;
    if ($('locked').hidden && $('pin-form').hidden) setStatus('online', '연결됨');
  }
}

async function sendText(text) {
  const client = await connect();
  const res = await client.request('POST', '/api/text', {
    headers: { 'x-requested-with': APP_ID, 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(await errorOf(res));
  addSent(text.replace(/\s+/g, ' ').slice(0, 80), 'i-check');
  toast('보냈어요.');
}

// ---- 화면 ----
$('pin-form').addEventListener('submit', (e) => {
  e.preventDefault();
  pin = $('pin-input').value.trim();
  if (!pin) return;
  closeConnection(); // 새 비밀번호로 다시 연결한다
  setStatus('connecting', '확인 중…');
  start();
});

for (const id of ['pick-media', 'pick-file', 'pick-any']) {
  $(id).addEventListener('change', (e) => {
    sendFiles(e.target.files);
    e.target.value = '';
  });
}
$('transfer-cancel').addEventListener('click', () => current?.abort?.abort());

const input = $('text-input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
});
$('text-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  const button = e.target.querySelector('button');
  button.disabled = true;
  try {
    await sendText(text);
    input.value = '';
    input.style.height = 'auto';
  } catch (err) {
    toast(err.code ? '연결이 끊겼어요. 다시 보내 주세요.' : err.message, 'error');
  } finally {
    button.disabled = false;
  }
});

// 끌어다 놓기, 붙여 넣기 (PC)
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
  if (e.dataTransfer?.files?.length) sendFiles(e.dataTransfer.files);
});
document.addEventListener('paste', (e) => {
  if (e.target === input || e.target === $('pin-input') || $('drop-main').hidden) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    sendFiles(files.map((f) => (f.name && f.name !== 'image.png' ? f : new File([f], `캡처 ${new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-')}.png`, { type: f.type }))));
  }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('drop-main').hidden) refreshInbox();
});

start();

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
