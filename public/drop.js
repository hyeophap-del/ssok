// 받기 링크 화면: 쏙이 없는 사람이 링크(https://<중계 서버>/d/<PC 번호>#<링크 번호>.<비밀 열쇠>)를 열어
// 그 PC로 파일·텍스트를 보낸다. 중계 서버를 거치지만 내용은 받는 PC와의 사이에서 종단간 암호화된다 (relay.js).
// 받는 PC는 이 링크로 온 요청에 보내기만 허락한다 (목록·받기는 안 됨).
import { RelayClient, fromHex } from './relay.js';

const APP_ID = '{{APP_ID}}';
const $ = (id) => document.getElementById(id);

const pcId = /^\/d\/([0-9a-f]{16})\/?$/.exec(location.pathname)?.[1] ?? null;
const [linkId = '', secretHex = ''] = location.hash.slice(1).split('.');
const valid = Boolean(pcId) && /^[0-9a-f]{16}$/.test(linkId) && /^[0-9a-f]{64}$/.test(secretHex);

let connection = null;
let pcName = '받는 PC';
let current = null; // 보내는 중인 것 { abort: AbortController }

function setStatus(state, text) {
  $('status').dataset.state = state;
  $('status-text').textContent = text;
}

function toast(message, type = '') {
  const node = document.createElement('div');
  node.className = `toast ${type}`.trim();
  node.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const span = document.createElement('span');
  span.textContent = message;
  node.append(span);
  $('toasts').append(node);
  while ($('toasts').children.length > 2) $('toasts').firstElementChild.remove();
  setTimeout(() => node.remove(), type === 'error' ? 6000 : 3000);
}

function showLocked(title, text) {
  for (const id of ['drop-ready', 'drop-main', 'transfer']) $(id).hidden = true;
  $('locked').hidden = false;
  $('locked-title').textContent = title;
  $('locked-text').textContent = text;
}

function showReady() {
  $('locked').hidden = true;
  $('drop-ready').hidden = false;
  $('drop-main').hidden = false;
  $('drop-title').textContent = `${pcName}에게 보내기`;
  document.title = `${pcName}에게 보내기`;
  setStatus('online', '연결됨');
}

const expired = () => {
  setStatus('offline', '쓸 수 없는 링크');
  showLocked('이 링크는 꺼졌거나 기간이 지났어요', '링크를 보낸 사람에게 새 링크를 달라고 해 주세요.');
};

function connect() {
  connection ??= RelayClient.connect(`wss://${location.host}/ws/c/${pcId}`, fromHex(secretHex), {
    kid: `d:${linkId}`,
    onClose: () => {
      connection = null;
      if (!current) setStatus('waiting', '잠시 끊김 · 보낼 때 다시 연결해요');
    },
  }).catch((err) => {
    connection = null;
    throw err;
  });
  return connection;
}

/** 받는 PC와 연결하고 이름을 받아 온다. PC가 꺼져 있으면 켜질 때까지 가끔 다시 해 본다. */
async function start() {
  if (!valid) {
    setStatus('offline', '잘못된 링크');
    return showLocked('링크가 올바르지 않아요', '받은 링크 전체(# 뒤까지)를 그대로 열어 주세요.');
  }
  for (;;) {
    try {
      const client = await connect();
      const res = await client.request('GET', '/api/drop-info');
      if (res.status === 401 || res.status === 410) return expired();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      pcName = (await res.json()).name || pcName;
      return showReady();
    } catch (err) {
      if (err.code === 'UNKNOWN_PEER') return expired();
      setStatus('offline', '받는 PC에 연결하지 못함');
      showLocked('받는 PC가 꺼져 있는 것 같아요', '그 PC가 켜지면 이 화면이 저절로 열려요.');
      await new Promise((r) => setTimeout(r, document.hidden ? 30_000 : 8000));
    }
  }
}

async function errorOf(res) {
  if (res.status === 401 || res.status === 410) {
    expired();
    return '이 링크는 꺼졌거나 기간이 지났어요.';
  }
  try {
    return (await res.json()).error || '보내지 못했어요.';
  } catch {
    return '보내지 못했어요.';
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
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
  const li = document.createElement('li');
  li.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${iconId}"/></svg>`;
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = label;
  const check = document.createElement('span');
  check.className = 'muted small';
  check.textContent = '보냄';
  li.append(name, check);
  $('sent').prepend(li);
  $('sent-card').hidden = false;
}

/** 파일을 하나씩 보낸다 (진행률 표시, 취소 가능) */
async function sendFiles(files) {
  const list = [...files].filter((f) => f.size >= 0);
  if (!list.length || current) return;
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
      addSent(file.name, 'i-file');
    }
    toast(list.length > 1 ? `${list.length}개를 보냈어요.` : '보냈어요.');
  } catch (err) {
    if (err.name === 'AbortError') toast('보내기를 취소했어요.');
    else toast(err.code ? '연결이 끊겼어요. 다시 보내 주세요.' : err.message, 'error');
  } finally {
    current = null;
    $('transfer').hidden = true;
    if ($('locked').hidden) setStatus('online', '연결됨');
  }
}

async function sendText(text) {
  const client = await connect();
  const res = await client.request('POST', '/api/text', {
    headers: { 'x-requested-with': APP_ID, 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(await errorOf(res));
  addSent(text.replace(/\s+/g, ' ').slice(0, 80), 'i-text');
  toast('보냈어요.');
}

// ---- 화면 ----
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
  if (!$('drop-main').hidden && e.dataTransfer?.files?.length) sendFiles(e.dataTransfer.files);
});
document.addEventListener('paste', (e) => {
  if (e.target === input || $('drop-main').hidden) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    sendFiles(files.map((f) => (f.name && f.name !== 'image.png' ? f : new File([f], `캡처 ${new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-')}.png`, { type: f.type }))));
  }
});

start();
