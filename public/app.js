// {{APP_NAME}} 웹 화면. PC(호스트)와 휴대폰이 같은 페이지를 쓰고, 세션 정보에 따라 화면이 바뀐다.

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const APP_NAME = '{{APP_NAME}}'; // 서버가 보낼 때 실제 이름으로 바꿔 넣는다
const APP_ID = '{{APP_ID}}';
const DOWNLOADED_KEY = `${APP_ID}.downloaded`;
const TIP_KEY = `${APP_ID}.installTipClosed`;
const TARGET_KEY = `${APP_ID}.target`;
const PREVIEWABLE_IMAGES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

const store = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // 사생활 보호 모드 등에서는 저장하지 못해도 괜찮다
    }
  },
};

const state = {
  session: null,
  items: [],
  remotes: [],
  connected: false,
  unseen: 0,
  downloaded: new Set(store.get(DOWNLOADED_KEY, [])),
  // 다른 PC (PC 화면에서만)
  peers: [],
  target: store.get(TARGET_KEY, 'phone'), // 'phone' 또는 연결된 PC의 id
  pairing: null, // 이 PC가 보낸 연결 요청: { id, name, code, error }
  request: null, // 이 PC에 들어온 연결 요청
};

// ---- 시작 ----

async function init() {
  if (new URLSearchParams(location.search).has('k')) history.replaceState(null, '', '/');

  let session = null;
  for (let attempt = 0; attempt < 5 && !session; attempt++) {
    if (attempt > 0) await sleep(1000);
    try {
      const res = await fetch('/api/session', { cache: 'no-store' });
      if (res.status === 401) return showLocked();
      if (res.ok) session = await res.json();
    } catch {
      // 잠깐 끊겼을 수 있으니 다시 시도한다
    }
  }
  if (!session) return showLocked();
  state.session = session;

  const app = $('app');
  app.classList.add(session.isHost ? 'host' : 'remote');
  app.hidden = false;

  const input = $('text-input');
  input.placeholder = session.isHost ? '휴대폰으로 보낼 텍스트나 링크' : '텍스트나 링크';
  input.enterKeyHint = session.isHost ? 'send' : 'enter';

  if (session.isHost) setupHost();
  else setupRemote();
  setupTextForm();
  setupDragAndDrop();
  $('transfer-cancel').addEventListener('click', cancelTransfer);
  $('items').addEventListener('click', onItemClick);

  setInterval(refreshTimes, 30_000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    state.unseen = 0;
    document.title = APP_NAME;
    if (!state.connected) reconnect();
  });

  connectEvents();
}

function showLocked() {
  $('app').hidden = true;
  $('locked').hidden = false;
  events?.close();
}

function setupHost() {
  const { addresses, receivedDir, warnings = [] } = state.session;
  $('received-dir').textContent = receivedDir;
  if (warnings.length) {
    $('net-warning-text').textContent = warnings.join(' ');
    $('net-warning').hidden = false;
  }
  $('open-folder').addEventListener('click', () => post('/api/open-folder').catch(showError));
  setupSettings();

  if (addresses.length) {
    showAddress(0);
  } else {
    $('qr').replaceWith(el('p', { class: 'muted' }, `Wi-Fi 연결을 찾지 못했어요. 네트워크에 연결한 뒤 ${APP_NAME} 프로그램을 다시 실행해 주세요.`));
  }
  if (addresses.length > 1) {
    const select = $('addr-select');
    addresses.forEach((a, i) => select.append(el('option', { value: String(i) }, `${a.address} · ${a.iface}`)));
    select.addEventListener('change', () => showAddress(Number(select.value)));
    $('addr-picker').hidden = false;
  }

  $('pick-host').addEventListener('change', (e) => {
    enqueue([...e.target.files]);
    e.target.value = '';
  });
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    enqueue(files.map(nameScreenshot));
  });

  if (state.session.peerSupport) setupPeers();
  else document.querySelector('.targets').hidden = true;
}

function showAddress(index) {
  const address = state.session.addresses[index];
  $('qr').innerHTML = address.qrSvg; // 서버가 만든 SVG
  $('addr-url').textContent = address.url;
}

function setupRemote() {
  for (const id of ['pick-media', 'pick-file']) {
    $(id).addEventListener('change', (e) => {
      enqueue([...e.target.files]);
      e.target.value = '';
    });
  }
  const standalone = window.matchMedia('(display-mode: standalone)').matches;
  if (!store.get(TIP_KEY, false) && !standalone) $('install-tip').hidden = false;
  $('install-tip-close').addEventListener('click', () => {
    $('install-tip').hidden = true;
    store.set(TIP_KEY, true);
  });
}

// ---- 서버와 실시간 연결 ----

let events = null;
let reconnectTimer = null;

function connectEvents() {
  events?.close();
  events = new EventSource('/api/events');

  events.addEventListener('snapshot', (e) => {
    const data = JSON.parse(e.data);
    state.items = data.items;
    state.remotes = data.presence.remotes;
    state.connected = true;
    renderItems();
    updateStatus();
    if (data.peers) {
      state.peers = data.peers;
      renderPeers();
      if (data.request) showRequest(data.request);
      else hideRequest();
    }
  });
  events.addEventListener('peers', (e) => {
    state.peers = JSON.parse(e.data).peers;
    renderPeers();
  });
  events.addEventListener('pair-request', (e) => showRequest(JSON.parse(e.data)));
  events.addEventListener('pair-request-done', (e) => {
    const { rid, decision } = JSON.parse(e.data);
    if (state.request?.rid !== rid) return;
    if (decision === 'timeout' || decision === 'gone') toast('연결 요청이 취소됐어요.');
    hideRequest();
  });
  events.addEventListener('pair-result', (e) => onPairResult(JSON.parse(e.data)));
  events.addEventListener('add', (e) => {
    const item = JSON.parse(e.data);
    if (state.items.some((i) => i.id === item.id)) return;
    state.items.unshift(item);
    renderItems(item.id);
    announce(item);
  });
  events.addEventListener('remove', (e) => {
    const { id } = JSON.parse(e.data);
    state.items = state.items.filter((i) => i.id !== id);
    renderItems();
  });
  events.addEventListener('presence', (e) => {
    state.remotes = JSON.parse(e.data).remotes;
    updateStatus();
  });
  events.addEventListener('open', () => {
    state.connected = true;
    updateStatus();
  });
  events.addEventListener('error', () => {
    state.connected = false;
    updateStatus();
    // 브라우저가 스스로 다시 붙지 않는 경우(서버가 오류로 응답 등)에만 직접 다시 연결한다
    if (events.readyState === EventSource.CLOSED) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(reconnect, 3000);
    }
  });
}

async function reconnect() {
  clearTimeout(reconnectTimer);
  try {
    const res = await fetch('/api/session', { cache: 'no-store' });
    if (res.status === 401) return showLocked();
  } catch {
    reconnectTimer = setTimeout(reconnect, 3000);
    return;
  }
  connectEvents();
}

function updateStatus() {
  const { isHost } = state.session;
  if (!state.connected) {
    return setStatus('offline', isHost ? `${APP_NAME} 프로그램이 꺼져 있어요` : 'PC와 연결이 끊겼어요 · 다시 연결 중');
  }
  if (!isHost) return setStatus('online', 'PC와 연결됨');
  const n = state.remotes.length;
  if (n === 0) return setStatus('waiting', '휴대폰 연결 대기 중');
  return setStatus('online', n === 1 ? `${state.remotes[0]} 연결됨` : `기기 ${n}대 연결됨`);
}

function setStatus(kind, text) {
  $('status').dataset.state = kind;
  $('status-text').textContent = text;
}

// ---- 새 항목 알림 ----

let arrivals = [];
let arrivalTimer = null;

function announce(item) {
  const fromOtherSide = (item.from === 'host') !== state.session.isHost;
  if (!fromOtherSide) return;

  if (document.hidden) {
    state.unseen++;
    document.title = `(${state.unseen}) ${APP_NAME}`;
  }

  if (!state.session.isHost) navigator.vibrate?.(60);

  // 여러 개가 한꺼번에 오면 알림을 하나로 묶는다
  arrivals.push(item);
  clearTimeout(arrivalTimer);
  arrivalTimer = setTimeout(flushArrivals, 800);
}

function flushArrivals() {
  const { isHost } = state.session;
  const files = arrivals.filter((i) => i.kind === 'file');
  const texts = arrivals.filter((i) => i.kind === 'text');
  const from = isHost ? `${arrivals[0].device || '휴대폰'}에서` : 'PC에서';
  const verb = isHost ? '받았어요' : '보냈어요';
  arrivals = [];

  if (files.length) {
    const message = files.length === 1 ? `${from} ‘${files[0].name}’을(를) ${verb}.` : `${from} 파일 ${files.length}개를 ${verb}.`;
    let action = null;
    if (isHost) action = { label: '폴더 열기', run: () => post('/api/open-folder').catch(showError) };
    else if (files.length === 1) action = { label: '받기', run: () => download(files[0]) };
    toast(message, '', action);
  }
  if (texts.length === 1) {
    toast(`${from} 텍스트를 ${verb}.`, '', { label: '복사', run: () => copyAndReport(texts[0].text) });
  } else if (texts.length > 1) {
    toast(`${from} 텍스트 ${texts.length}개를 ${verb}.`);
  }
}

// ---- 목록 그리기 ----

const nodes = new Map();

function renderItems(freshId) {
  const list = $('items');
  const ids = new Set(state.items.map((i) => i.id));
  for (const [id, node] of nodes) {
    if (!ids.has(id)) {
      node.remove();
      nodes.delete(id);
    }
  }
  let prev = null;
  for (const item of state.items) {
    let node = nodes.get(item.id);
    if (!node) {
      node = renderItem(item);
      if (item.id === freshId) node.classList.add('fresh');
      nodes.set(item.id, node);
    }
    const expected = prev ? prev.nextSibling : list.firstChild;
    if (node !== expected) list.insertBefore(node, expected);
    prev = node;
  }
  $('empty').hidden = state.items.length > 0;
}

function rerenderItem(id) {
  const item = state.items.find((i) => i.id === id);
  const old = nodes.get(id);
  if (!item || !old) return;
  const node = renderItem(item);
  old.replaceWith(node);
  nodes.set(id, node);
}

function renderItem(item) {
  const { isHost } = state.session;
  const li = el('li', { class: 'item', 'data-id': item.id });

  const thumb = el('div', { class: 'thumb' });
  thumb.append(icon(iconFor(item)));
  if (item.kind === 'file' && PREVIEWABLE_IMAGES.has(item.mime)) {
    const img = el('img', { src: fileUrl(item, true), alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => img.remove());
    thumb.append(img);
  }

  const body = el('div', { class: 'item-body' });
  if (item.kind === 'text') {
    const text = el('div', { class: 'item-text' });
    linkify(text, item.text);
    body.append(text);
    if (item.text.length > 160 || item.text.split('\n').length > 4) {
      body.append(el('button', { type: 'button', class: 'more', 'data-action': 'more' }, '더 보기'));
    }
  } else {
    body.append(el('div', { class: 'item-title', title: item.name }, item.name));
  }

  const meta = el('div', { class: 'item-meta' });
  if (item.kind === 'file') meta.append(el('span', {}, formatSize(item.size)));
  meta.append(el('span', {}, routeLabel(item)));
  meta.append(el('span', { class: 'time', 'data-time': String(item.createdAt) }, timeAgo(item.createdAt)));
  const received = !isHost && item.kind === 'file' && item.from === 'host' && state.downloaded.has(item.id);
  if (received) meta.append(el('span', { class: 'done' }, '받음'));
  body.append(meta);

  const actions = el('div', { class: 'item-actions' });
  if (item.kind === 'text') {
    actions.append(labeledButton('copy', 'i-copy', '복사', 'btn'));
  } else if (isHost) {
    actions.append(iconButton('open', 'i-open', '열기'), iconButton('reveal', 'i-folder', '폴더에서 보기'));
  } else {
    const primary = item.from === 'host' && !received;
    const link = el('a', {
      class: primary ? 'btn primary' : 'btn',
      href: fileUrl(item),
      download: item.name,
      'data-action': 'download',
    });
    link.append(icon('i-download'), el('span', { class: 'btn-label' }, '받기'));
    actions.append(link);
  }
  actions.append(iconButton('delete', 'i-x', '목록에서 지우기', 'danger'));

  li.append(thumb, body, actions);
  return li;
}

function routeLabel(item) {
  if (state.session.isHost) return item.from === 'host' ? '휴대폰으로 보냄' : `${item.device || '휴대폰'}에서 받음`;
  if (item.from === 'peer') return `${item.device} → PC`;
  return item.from === 'host' ? 'PC에서 받음' : 'PC로 보냄';
}

function iconFor(item) {
  if (item.kind === 'text') return 'i-text';
  const mime = item.mime || '';
  if (mime.startsWith('image/')) return 'i-image';
  if (mime.startsWith('video/')) return 'i-video';
  if (mime.startsWith('audio/')) return 'i-audio';
  if (/zip|rar|7z|tar|gzip/.test(mime)) return 'i-archive';
  return 'i-file';
}

function refreshTimes() {
  for (const node of document.querySelectorAll('.time[data-time]')) {
    node.textContent = timeAgo(Number(node.dataset.time));
  }
}

// ---- 항목 버튼 ----

async function onItemClick(e) {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const li = target.closest('.item');
  const item = state.items.find((i) => i.id === li?.dataset.id);
  if (!item) return;

  switch (target.dataset.action) {
    case 'download':
      // <a download>가 내려받기를 처리한다. 표시만 바꾼다.
      markDownloaded(item.id);
      break;
    case 'copy':
      copyAndReport(item.text);
      break;
    case 'more': {
      const text = li.querySelector('.item-text');
      const expanded = text.classList.toggle('expanded');
      target.textContent = expanded ? '접기' : '더 보기';
      break;
    }
    case 'open':
    case 'reveal':
      post(`/api/items/${item.id}/${target.dataset.action}`).catch(showError);
      break;
    case 'delete':
      try {
        await api(`/api/items/${item.id}`, { method: 'DELETE' });
        const keepsFile = state.session.isHost && item.kind === 'file' && item.from !== 'host';
        toast(keepsFile ? '목록에서 지웠어요. 파일은 폴더에 그대로 있어요.' : '목록에서 지웠어요.');
      } catch (err) {
        showError(err);
      }
      break;
  }
}

function download(item) {
  const link = el('a', { href: fileUrl(item), download: item.name });
  document.body.append(link);
  link.click();
  link.remove();
  markDownloaded(item.id);
}

function markDownloaded(id) {
  if (state.downloaded.has(id)) return;
  state.downloaded.add(id);
  store.set(DOWNLOADED_KEY, [...state.downloaded].slice(-500));
  // 클릭한 링크가 내려받기를 시작한 뒤에 버튼 모양을 바꾼다
  setTimeout(() => rerenderItem(id), 300);
}

// ---- 텍스트 보내기 ----

function setupTextForm() {
  const form = $('text-form');
  const input = $('text-input');
  const button = form.querySelector('button');

  const grow = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight + 2, 180)}px`;
    input.style.overflowY = input.scrollHeight + 2 > 180 ? 'auto' : 'hidden';
  };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => {
    // PC에서는 Enter로 보내고 Shift+Enter로 줄을 바꾼다. 한글 조합 중인 Enter는 무시한다.
    if (!state.session.isHost || e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    form.requestSubmit();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value;
    if (!text.trim()) {
      input.focus();
      return;
    }
    button.disabled = true;
    const peer = state.session.isHost ? currentTarget() : null;
    try {
      await api(peer ? `/api/peers/${peer.id}/text` : '/api/text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      input.value = '';
      grow();
      toast(peer ? `‘${peer.name}’에 보냈어요.` : state.session.isHost ? '휴대폰으로 보냈어요.' : 'PC로 보냈어요.');
    } catch (err) {
      showError(err);
    } finally {
      button.disabled = false;
    }
  });
}

// ---- 파일 보내기 ----

const transfer = {
  queue: [],
  running: false,
  cancelled: false,
  xhr: null,
  current: null,
  currentTarget: null, // 보내는 곳이 다른 PC면 그 PC
  targetNames: new Set(),
  totalBytes: 0,
  doneBytes: 0,
  count: 0,
  index: 0,
  sent: 0,
  failed: 0,
  startedAt: 0,
};

function enqueue(files) {
  files = files.filter(Boolean);
  if (!files.length) return;
  if (!transfer.running) {
    Object.assign(transfer, { totalBytes: 0, doneBytes: 0, count: 0, index: 0, sent: 0, failed: 0, cancelled: false, targetNames: new Set() });
  }
  // 고른 순간의 보낼 곳을 기억한다 (보내는 도중에 보낼 곳을 바꿔도 섞이지 않게)
  const target = state.session.isHost ? currentTarget() : null;
  transfer.queue.push(...files.map((file) => ({ file, target })));
  transfer.totalBytes += files.reduce((sum, f) => sum + f.size, 0);
  transfer.count += files.length;
  if (transfer.running) renderTransfer(0);
  else runQueue();
}

async function runQueue() {
  transfer.running = true;
  transfer.startedAt = performance.now();
  $('transfer').hidden = false;

  while (transfer.queue.length && !transfer.cancelled) {
    const { file, target } = transfer.queue.shift();
    transfer.index++;
    transfer.current = file;
    transfer.currentTarget = target;
    transfer.targetNames.add(target ? target.name : '');
    renderTransfer(0);
    try {
      await uploadFile(file, target, (loaded) => renderTransfer(loaded));
      transfer.sent++;
    } catch (err) {
      if (err.name === 'AbortError') break;
      transfer.failed++;
      toast(`${file.name}: ${err.message}`, 'error');
    }
    transfer.doneBytes += file.size;
  }

  const { sent, failed, cancelled } = transfer;
  const names = [...transfer.targetNames];
  transfer.queue = [];
  transfer.running = false;
  transfer.current = null;
  transfer.currentTarget = null;
  $('transfer').hidden = true;

  if (cancelled) {
    toast('보내기를 취소했어요.');
  } else if (sent) {
    const failNote = failed ? ` (${failed}개 실패)` : '';
    let message = `${sent}개를 보냈어요.`;
    if (!state.session.isHost) message = `PC로 ${sent}개를 보냈어요.`;
    else if (names.length === 1 && names[0]) message = `‘${names[0]}’에 ${sent}개를 보냈어요.`;
    else if (names.length === 1) message = `${sent}개를 올렸어요. 휴대폰에서 받을 수 있어요.`;
    toast(message + failNote);
  }
}

function uploadFile(file, target, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    transfer.xhr = xhr;
    const params = new URLSearchParams({ name: file.name || 'file' });
    if (file.lastModified) params.set('lastModified', String(file.lastModified));
    // 다른 PC로 보낼 때는 이 PC의 프로그램이 받아서 그대로 그 PC로 흘려보낸다
    xhr.open('POST', `${target ? `/api/peers/${target.id}/upload` : '/api/upload'}?${params}`);
    xhr.setRequestHeader('X-Requested-With', APP_ID);
    xhr.upload.addEventListener('progress', (e) => onProgress(e.loaded));
    xhr.addEventListener('load', () => {
      transfer.xhr = null;
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      if (xhr.status === 401) showLocked();
      let message = '보내지 못했어요.';
      try {
        message = JSON.parse(xhr.responseText).error || message;
      } catch {
        // 서버가 JSON이 아닌 응답을 보냈다
      }
      reject(new Error(message));
    });
    xhr.addEventListener('error', () => {
      transfer.xhr = null;
      reject(new Error('연결이 끊겼어요.'));
    });
    xhr.addEventListener('abort', () => {
      transfer.xhr = null;
      reject(new DOMException('취소됨', 'AbortError'));
    });
    xhr.send(file);
  });
}

function cancelTransfer() {
  transfer.cancelled = true;
  transfer.xhr?.abort();
}

function renderTransfer(loaded) {
  if (!transfer.current) return;
  const bytes = transfer.doneBytes + loaded;
  const percent = transfer.totalBytes ? (bytes / transfer.totalBytes) * 100 : 100;
  $('transfer-bar').style.width = `${Math.min(100, percent).toFixed(1)}%`;
  $('transfer-title').textContent =
    transfer.count > 1 ? `${transfer.index}/${transfer.count} · ${transfer.current.name}` : transfer.current.name;

  const elapsed = (performance.now() - transfer.startedAt) / 1000;
  const speed = elapsed > 0.5 ? bytes / elapsed : 0;
  const parts = [`${formatSize(bytes)} / ${formatSize(transfer.totalBytes)}`];
  if (transfer.currentTarget) parts.unshift(`${transfer.currentTarget.name}에 보내는 중`);
  if (speed > 0) {
    parts.push(`${formatSize(speed)}/s`);
    const remaining = (transfer.totalBytes - bytes) / speed;
    if (remaining >= 1) parts.push(`${formatDuration(remaining)} 남음`);
  }
  if (!state.session.isHost) parts.push('보내는 동안 화면을 켜 두세요');
  $('transfer-detail').textContent = parts.join(' · ');
}

function nameScreenshot(file) {
  // 클립보드 이미지는 보통 "image.png"라는 이름으로 들어온다
  if (file.name && !/^image\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)) return file;
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const name = `캡처 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
  return new File([file], name, { type: file.type, lastModified: Date.now() });
}

function setupDragAndDrop() {
  const overlay = $('drop-overlay');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;

    const files = [];
    let folders = 0;
    for (const entry of e.dataTransfer.items) {
      if (entry.kind !== 'file') continue;
      if (entry.webkitGetAsEntry?.()?.isDirectory) {
        folders++;
        continue;
      }
      const file = entry.getAsFile();
      if (file) files.push(file);
    }
    if (folders) toast('폴더는 그대로 보낼 수 없어요. 압축(zip)해서 보내 주세요.', 'error');
    enqueue(files);
  });
}

// ---- 설정 (PC 화면 전용) ----

function setupSettings() {
  const { settings, canQuit } = state.session;
  if (!settings && !canQuit) return;
  $('settings').hidden = false;

  if (settings) {
    $('pc-name').value = settings.name;
    $('name-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const saved = await saveSettings({ name: $('pc-name').value });
        $('pc-name').value = saved.name;
        $('self-name').textContent = saved.name;
        toast('이름을 바꿨어요.');
      } catch (err) {
        showError(err);
      }
    });
    if (settings.autostart !== null) {
      $('autostart-row').hidden = false;
      $('autostart').checked = settings.autostart;
      $('autostart').addEventListener('change', async (e) => {
        try {
          const saved = await saveSettings({ autostart: e.target.checked });
          e.target.checked = saved.autostart;
          toast(saved.autostart ? 'PC를 켜면 자동으로 실행돼요.' : '자동 실행을 껐어요.');
        } catch (err) {
          e.target.checked = !e.target.checked;
          showError(err);
        }
      });
    }
  }

  if (canQuit) {
    $('quit').hidden = false;
    $('quit').addEventListener('click', async () => {
      if (!confirm(`${APP_NAME} 프로그램을 끌까요?
휴대폰이나 다른 PC에서 보내도 받지 못하게 돼요. 다시 켜려면 시작 메뉴에서 ${APP_NAME}을(를) 실행하세요.`)) return;
      try {
        await post('/api/quit');
        toast('껐어요. 이 창은 닫아도 돼요.');
      } catch (err) {
        showError(err);
      }
    });
  }
}

const saveSettings = (patch) =>
  api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });

// ---- 다른 PC (PC 화면 전용) ----

let earlyPairResult = null; // 연결 요청 응답보다 결과 알림이 먼저 도착한 경우

const peerById = (id) => state.peers.find((p) => p.id === id);

/** 지금 보낼 곳이 연결된 PC면 그 PC, 휴대폰이면 null */
function currentTarget() {
  const peer = peerById(state.target);
  return peer?.paired && peer.kind === 'pc' ? peer : null;
}

function setTarget(id) {
  state.target = id;
  store.set(TARGET_KEY, id);
  renderTargets();
}

function setupPeers() {
  const { name, addresses, port } = state.session;
  $('self-name').textContent = name;
  const address = addresses[0]?.address;
  $('self-address').textContent = address ? (port === 8765 ? address : `${address}:${port}`) : '네트워크 없음';

  $('targets').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-target]');
    if (chip) setTarget(chip.dataset.target);
    else if (e.target.closest('[data-add]')) openPeersDialog();
  });

  const dialog = $('peers-dialog');
  dialog.addEventListener('click', (e) => {
    // 창 바깥(어두운 배경)을 누르면 닫는다
    const rect = dialog.getBoundingClientRect();
    const outside = e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom;
    if (e.target === dialog && outside) return dialog.close();
    if (e.target.closest('[data-close]')) return dialog.close();
    const pairButton = e.target.closest('[data-pair]');
    if (pairButton) return startPairing(pairButton.dataset.pair);
    const unpairButton = e.target.closest('[data-unpair]');
    if (unpairButton) return unpair(unpairButton.dataset.unpair);
  });
  dialog.addEventListener('close', () => {
    if (state.pairing?.error) state.pairing = null;
  });
  $('pairing-close').addEventListener('click', () => {
    state.pairing = null;
    renderPairing();
  });
  $('connect-form').addEventListener('submit', connectByAddress);

  $('request-accept').addEventListener('click', () => decideRequest('accept'));
  $('request-deny').addEventListener('click', () => decideRequest('deny'));
  $('request-dialog').addEventListener('cancel', (e) => {
    e.preventDefault(); // Esc는 거절로 처리한다
    decideRequest('deny');
  });

  renderTargets();
}

function renderPeers() {
  if (!state.session.isHost || !state.session.peerSupport) return;
  renderTargets();
  if ($('peers-dialog').open) renderPeerDialog();
}

function renderTargets() {
  const peer = currentTarget();
  const paired = state.peers.filter((p) => p.paired && p.kind === 'pc');
  const add = el('button', { type: 'button', class: 'chip add', 'data-add': '' });
  add.append(icon('i-plus'), el('span', {}, paired.length ? 'PC 추가' : '다른 PC'));
  $('targets').replaceChildren(
    targetChip('phone', 'i-phone', '휴대폰', undefined, !peer),
    ...paired.map((p) => targetChip(p.id, 'i-pc', p.name, p.online, peer?.id === p.id)),
    add,
  );

  const offline = Boolean(peer && !peer.online);
  $('dropzone').classList.toggle('offline', offline);
  if (peer) {
    $('dropzone-title').textContent = `${peer.name}에 보낼 파일을 여기에 끌어다 놓으세요`;
    $('dropzone-hint').textContent = offline
      ? `지금은 꺼져 있는 것 같아요. 그 PC에서 ${APP_NAME} 프로그램을 켜 주세요.`
      : '그 PC의 받은 파일 폴더에 바로 저장돼요. 캡처한 화면은 Ctrl+V로 붙여 넣으세요.';
    $('text-input').placeholder = `${peer.name}에 보낼 텍스트나 링크`;
  } else {
    $('dropzone-title').textContent = '휴대폰으로 보낼 파일을 여기에 끌어다 놓으세요';
    $('dropzone-hint').textContent = '클릭해서 고르거나, 캡처한 화면을 Ctrl+V로 붙여 넣어도 돼요';
    $('text-input').placeholder = '휴대폰으로 보낼 텍스트나 링크';
  }
}

function targetChip(id, iconId, label, online, selected) {
  const chip = el('button', {
    type: 'button',
    class: 'chip',
    'data-target': id,
    'aria-pressed': String(selected),
    title: online === false ? `${label} · 꺼져 있음` : label,
  });
  chip.append(icon(iconId), el('span', { class: 'chip-name' }, label));
  if (online !== undefined) chip.append(el('span', { class: online ? 'chip-dot' : 'chip-dot off', 'aria-hidden': 'true' }));
  return chip;
}

function openPeersDialog() {
  renderPeerDialog();
  const dialog = $('peers-dialog');
  if (!dialog.open) dialog.showModal();
  post('/api/peers/scan').catch(() => {}); // 주변 PC를 바로 다시 찾는다
}

function renderPeerDialog() {
  const nearby = state.peers.filter((p) => !p.paired);
  const paired = state.peers.filter((p) => p.paired);
  $('nearby').replaceChildren(...nearby.map((p) => peerRow(p)));
  $('nearby-empty').hidden = nearby.length > 0;
  $('paired').replaceChildren(...paired.map((p) => peerRow(p)));
  $('paired-section').hidden = paired.length === 0;
  renderPairing();
}

function peerRow(peer) {
  const li = el('li', { class: 'peer-row' });
  const info = el('div', { class: 'peer-info' });
  info.append(el('div', { class: 'peer-name', title: peer.name }, peer.name));
  const sub = el('div', { class: 'peer-sub' });
  if (peer.kind === 'app') sub.append('휴대폰 앱');
  else {
    if (peer.paired) sub.append(el('span', { class: peer.online ? 'on' : '' }, peer.online ? '켜져 있음' : '꺼져 있음'), ' · ');
    sub.append(peer.address);
  }
  info.append(sub);

  let button;
  if (peer.paired) {
    button = el('button', { type: 'button', class: 'btn', 'data-unpair': peer.id }, '연결 해제');
  } else {
    const waiting = state.pairing?.id === peer.id && !state.pairing.error;
    button = el('button', { type: 'button', class: 'btn primary', 'data-pair': peer.id, disabled: waiting }, waiting ? '기다리는 중' : '연결');
  }
  li.append(icon(peer.kind === 'app' ? 'i-phone' : 'i-pc'), info, button);
  return li;
}

function renderPairing() {
  const pairing = state.pairing;
  $('pairing').hidden = !pairing;
  if (!pairing) return;
  $('pairing').classList.toggle('error', Boolean(pairing.error));
  $('pairing-code').hidden = Boolean(pairing.error || !pairing.code);
  $('pairing-code').textContent = formatCode(pairing.code);
  $('pairing-text').textContent = pairing.error || `${pairing.name} 화면에 같은 숫자가 떴는지 확인하고, 그 PC에서 ‘허용’을 눌러 주세요.`;
  $('pairing-close').hidden = !pairing.error;
}

async function startPairing(id) {
  const peer = peerById(id);
  const name = peer?.name ?? '상대 PC';
  earlyPairResult = null;
  try {
    const { code } = await api(`/api/peers/${id}/pair`, { method: 'POST' });
    state.pairing = { id, name, code };
  } catch (err) {
    state.pairing = { id, name, error: err.message };
  }
  renderPeerDialog();
  if (earlyPairResult?.id === id) onPairResult(earlyPairResult);
}

function onPairResult(result) {
  if (state.pairing?.id !== result.id || state.pairing.error) {
    earlyPairResult = result;
    return;
  }
  earlyPairResult = null;
  if (result.ok) {
    state.pairing = null;
    $('peers-dialog').close();
    setTarget(result.id);
    toast(`${result.name} 연결 완료! 이제 파일을 끌어다 놓으면 그 PC로 바로 가요.`);
  } else {
    state.pairing = { ...state.pairing, error: result.error };
  }
  renderPeerDialog();
}

async function unpair(id) {
  const peer = peerById(id);
  if (!confirm(`${peer?.name ?? '이 PC'} 연결을 해제할까요?\n다시 보내려면 처음처럼 연결해야 해요.`)) return;
  try {
    await api(`/api/peers/${id}`, { method: 'DELETE' });
    toast('연결을 해제했어요.');
  } catch (err) {
    showError(err);
  }
}

async function connectByAddress(e) {
  e.preventDefault();
  const input = $('connect-address');
  const button = e.target.querySelector('button');
  button.disabled = true;
  state.pairing = null;
  renderPairing();
  try {
    const { peer } = await api('/api/peers/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: input.value }),
    });
    input.value = '';
    if (!peerById(peer.id)) state.peers.push(peer);
    if (peer.paired) {
      $('peers-dialog').close();
      setTarget(peer.id);
      toast(`이미 연결된 PC예요: ${peer.name}`);
    } else {
      await startPairing(peer.id);
    }
  } catch (err) {
    state.pairing = { id: null, error: err.message };
    renderPairing();
  } finally {
    button.disabled = false;
  }
}

function showRequest(request) {
  state.request = request;
  $('request-name').textContent = request.name;
  $('request-address').textContent = request.kind === 'app' ? ` (휴대폰 앱 · ${request.address})` : ` (${request.address})`;
  $('request-code').textContent = formatCode(request.code);
  const dialog = $('request-dialog');
  if (!dialog.open) dialog.showModal();
  if (document.hidden) document.title = `연결 요청 · ${APP_NAME}`;
}

function hideRequest() {
  state.request = null;
  const dialog = $('request-dialog');
  if (dialog.open) dialog.close();
}

async function decideRequest(decision) {
  const request = state.request;
  if (!request) return;
  hideRequest();
  try {
    await api(`/api/pair-requests/${request.rid}/${decision}`, { method: 'POST' });
    if (decision === 'accept') toast(`${request.name} 연결 완료! 이제 서로 파일을 보낼 수 있어요.`);
  } catch (err) {
    showError(err);
  }
}

// ---- 공통 도구 ----

async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'X-Requested-With': APP_ID, ...options.headers },
  });
  if (res.status === 401) {
    showLocked();
    throw new Error('다시 연결해야 해요.');
  }
  if (!res.ok) {
    let message = '요청을 처리하지 못했어요.';
    try {
      message = (await res.json()).error || message;
    } catch {
      // JSON이 아닌 오류 응답
    }
    throw new Error(message);
  }
  return res.status === 204 ? null : res.json();
}

const post = (url) => api(url, { method: 'POST' });

function showError(err) {
  toast(err?.message || '문제가 생겼어요.', 'error');
}

function copyAndReport(text) {
  copyText(text).then((ok) => toast(ok ? '복사했어요.' : '복사하지 못했어요. 글자를 길게 눌러 직접 복사해 주세요.', ok ? '' : 'error'));
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 아래 방식으로 다시 시도
    }
  }
  // 휴대폰은 http 주소라서 Clipboard API를 못 쓴다. 예전 방식으로 복사한다.
  const area = el('textarea', { readonly: true, 'aria-hidden': 'true' });
  area.value = text;
  Object.assign(area.style, { position: 'fixed', top: '0', left: '0', opacity: '0', pointerEvents: 'none' });
  document.body.append(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

function toast(message, type = '', action = null) {
  const box = $('toasts');
  const node = el('div', { class: `toast ${type}`.trim(), role: type === 'error' ? 'alert' : 'status' });
  node.append(el('span', {}, message));
  if (action) {
    const button = el('button', { type: 'button' }, action.label);
    button.addEventListener('click', () => {
      action.run();
      node.remove();
    });
    node.append(button);
  }
  box.append(node);
  while (box.children.length > 2) box.firstElementChild.remove();
  setTimeout(() => node.remove(), action ? 8000 : type === 'error' ? 6000 : 3500);
}

function linkify(parent, text) {
  const pattern = /https?:\/\/[^\s<>"']+/gi;
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    const url = match[0].replace(/[),.;:!?\]}'"]+$/, '');
    if (match.index > last) parent.append(text.slice(last, match.index));
    parent.append(el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url));
    last = match.index + url.length;
    pattern.lastIndex = last;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    node.setAttribute(key, value === true ? '' : value);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(id) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

function iconButton(action, iconId, label, extraClass = '') {
  const button = el('button', {
    type: 'button',
    class: `icon-btn ${extraClass}`.trim(),
    'data-action': action,
    'aria-label': label,
    title: label,
  });
  button.append(icon(iconId));
  return button;
}

function labeledButton(action, iconId, label, className) {
  const button = el('button', { type: 'button', class: className, 'data-action': action });
  button.append(icon(iconId), el('span', { class: 'btn-label' }, label));
  return button;
}

const formatCode = (code = '') => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);
const fileUrl = (item, inline = false) => `/api/files/${item.id}${inline ? '?inline=1' : ''}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatSize(bytes) {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.ceil(seconds)}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 ${Math.ceil(seconds % 60)}초`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

function timeAgo(timestamp) {
  const diff = (Date.now() - timestamp) / 1000;
  const date = new Date(timestamp);
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (diff < 60) return '방금';
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return hm;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `어제 ${hm}`;
  return `${date.getMonth() + 1}월 ${date.getDate()}일 ${hm}`;
}

init();
