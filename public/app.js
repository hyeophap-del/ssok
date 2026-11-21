// {{APP_NAME}} 웹 화면. PC(호스트)와 휴대폰이 같은 페이지를 쓰고, 세션 정보에 따라 화면이 바뀐다.
// 중계 서버(어디서나)로 열리면 PC와 직접 대신 암호화된 통로(relay.js)로 주고받는다.
import { RelayClient, fromHex } from './relay.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const APP_NAME = '{{APP_NAME}}'; // 서버가 보낼 때 실제 이름으로 바꿔 넣는다
const APP_ID = '{{APP_ID}}';
const DOWNLOADED_KEY = `${APP_ID}.downloaded`;
const TIP_KEY = `${APP_ID}.installTipClosed`;
const TARGET_KEY = `${APP_ID}.target`;
const APP_CARD_KEY = `${APP_ID}.appCardClosed`;
const ANDROID_PACKAGE = 'app.ssok.android';
/** 창 제목. PC 화면은 알림 영역 아이콘이 이 제목으로 창을 찾아 앞으로 가져온다 (server.js의 HOST_TITLE과 같아야 한다) */
const pageTitle = () => (state.session?.isHost ? `${APP_NAME} · PC` : APP_NAME);
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

// 중계 서버 주소(https://<중계>/p/<PC 번호>#<비밀 열쇠>)로 열렸으면 그 정보. 아니면 null (집 Wi-Fi로 PC에 바로 연결).
// 비밀 열쇠는 처음 열 때 # 뒤에서 읽어 이 휴대폰에 저장하고, 주소창에서는 지운다 (홈 화면 바로가기에는 남지 않게).
const RELAY = (() => {
  const m = /^\/p\/([0-9a-f]{16})\/?$/.exec(location.pathname);
  if (!m) return null;
  const key = `${APP_ID}.relay.${m[1]}`;
  let secret = location.hash.slice(1);
  if (/^[0-9a-f]{64}$/.test(secret)) {
    store.set(key, secret);
    history.replaceState(null, '', location.pathname);
  } else {
    secret = store.get(key, null);
  }
  return { pcId: m[1], secret };
})();

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
  if (RELAY && !RELAY.secret) return showLocked('relay');

  let session = null;
  let lastError = null;
  // 중계를 거치면 연결에 조금 걸릴 수 있어 빈 화면 대신 연결 중임을 보여 준다
  const slow = RELAY ? setTimeout(() => showLocked('connecting'), 1200) : null;
  for (let attempt = 0; attempt < 5 && !session; attempt++) {
    if (attempt > 0) await sleep(1000);
    try {
      const res = await request('GET', '/api/session');
      if (res.status === 401) return showLocked();
      if (res.ok) session = await res.json();
    } catch (err) {
      lastError = err; // 잠깐 끊겼을 수 있으니 다시 시도한다
      if (['BAD_KEY', 'PC_OFFLINE', 'PC_TIMEOUT', 'BUSY'].includes(err.code)) break; // 중계 서버가 알려 준 이유는 곧바로 다시 해 봐도 같다
    }
  }
  clearTimeout(slow);
  if (!session) {
    if (!RELAY) return showLocked();
    // 열쇠가 틀렸으면 QR을 다시 스캔해야 하고, 그 밖에는 PC가 꺼졌거나 잠깐 끊긴 것이라 저절로 다시 시도한다
    if (lastError?.code === 'BAD_KEY') return showLocked('relay');
    showLocked('pc-offline');
    return waitForPc();
  }
  state.session = session;

  document.title = pageTitle();
  const app = $('app');
  app.classList.add(session.isHost ? 'host' : 'remote');
  app.hidden = false;
  $('locked').hidden = true;

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
    document.title = pageTitle();
    if (!state.connected) reconnect();
  });

  connectEvents();
}

function showLocked(reason) {
  $('app').hidden = true;
  $('locked').hidden = false;
  events?.close();
  $('locked-note').hidden = reason === 'pc-offline' || reason === 'connecting';
  if (reason === 'connecting') {
    $('locked-title').textContent = 'PC에 연결하는 중…';
    $('locked-text').textContent = '집 밖에서는 연결에 몇 초 걸릴 수 있어요.';
  } else if (reason === 'pc-offline') {
    $('locked-title').textContent = 'PC에 연결하지 못했어요';
    $('locked-text').textContent = `PC가 켜져 있고 ${APP_NAME}이(가) 실행 중인지 확인해 주세요. 연결되면 이 화면이 저절로 열려요.`;
  } else if (reason === 'relay') {
    $('locked-title').textContent = 'PC 화면의 [어디서나] QR을 다시 스캔하세요';
    $('locked-text').textContent = '이 휴대폰에 저장된 연결 정보가 없거나 PC에서 바뀌었어요.';
  }
}

/** 어디서나(중계) 모드에서 PC가 꺼져 있으면, 켜질 때까지 가끔 확인하다가 연결되면 화면을 다시 연다 */
async function waitForPc() {
  for (;;) {
    await sleep(document.hidden ? 30_000 : 8000);
    try {
      const res = await request('GET', '/api/session');
      if (res.ok) return location.reload();
      if (res.status === 401) return showLocked('relay');
    } catch (err) {
      if (err.code === 'BAD_KEY') return showLocked('relay');
    }
  }
}

// ---- 받기 링크: 쏙이 없는 사람이 이 PC로 보낼 수 있는 링크 ----
function setupDrops() {
  if (!state.session.drops) return;
  $('drops-card').hidden = false;
  renderDrops();
  const openForm = (open) => {
    $('drop-form').hidden = !open;
    $('drop-new').hidden = open;
    if (!open) return;
    $('drop-host').textContent = `${state.session.relay?.host ?? ''}/`;
    $('drop-pin').value = String(Math.floor(Math.random() * 10_000)).padStart(4, '0'); // 바꿔도 된다
    $('drop-label').focus();
  };
  $('drop-new').addEventListener('click', () => openForm(true));
  $('drop-cancel').addEventListener('click', () => openForm(false));
  $('drop-label').addEventListener('input', () => {
    // 이름을 영문으로 쓰면 주소도 같이 채워 준다 (직접 고칠 수 있다)
    if ($('drop-name').dataset.touched) return;
    const guess = $('drop-label').value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    $('drop-name').value = guess.length >= 3 ? guess.slice(0, 30) : '';
  });
  $('drop-name').addEventListener('input', () => ($('drop-name').dataset.touched = '1'));
  $('drop-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = e.target.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const link = await api('/api/drops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: $('drop-label').value,
          name: $('drop-name').value.trim().toLowerCase(),
          pin: $('drop-pin').value.trim(),
          days: Number($('drop-days').value),
        }),
      });
      $('drop-label').value = '';
      $('drop-name').value = '';
      delete $('drop-name').dataset.touched;
      openForm(false);
      await copyDropLink(link, true);
    } catch (err) {
      showError(err);
    } finally {
      button.disabled = false;
    }
  });
  $('drops').addEventListener('click', async (e) => {
    const row = e.target.closest('[data-drop]');
    if (!row) return;
    const link = state.session.drops.find((l) => l.id === row.dataset.drop);
    if (!link) return;
    if (e.target.closest('[data-copy]')) return copyDropLink(link);
    if (e.target.closest('[data-off]')) {
      if (!confirm(`‘${link.label}’ 링크를 끌까요? 이 링크로는 더 주고받을 수 없게 돼요.`)) return;
      try {
        await api(`/api/drops/${link.id}`, { method: 'DELETE' });
        toast('링크를 껐어요.');
      } catch (err) {
        showError(err);
      }
    }
  });
}

async function copyDropLink(link, created = false) {
  if (!link.url) return toast('어디서나(중계 서버)가 꺼져 있어 링크를 만들 수 없어요.', 'error');
  const message = `${link.url}\n비밀번호: ${link.pin}`;
  try {
    await navigator.clipboard.writeText(message);
    toast(created ? `‘${link.label}’ 링크를 만들고 주소와 비밀번호를 복사했어요. 카카오톡 등으로 보내 주세요.` : '링크 주소와 비밀번호를 복사했어요.');
  } catch {
    prompt('이 주소와 비밀번호를 보내 주세요', message.replace('\n', ' '));
  }
}

function renderDrops() {
  const links = state.session.drops || [];
  const relayOn = Boolean(state.session.relay?.url);
  $('drops-off').hidden = relayOn;
  $('drop-new').hidden = !relayOn || !$('drop-form').hidden;
  if (!relayOn) $('drop-form').hidden = true;
  $('drops').replaceChildren(
    ...links.map((link) => {
      const left = link.expiresAt === null ? '끌 때까지' : `${Math.max(1, Math.ceil((link.expiresAt - Date.now()) / 86_400_000))}일 남음`;
      const info = el('div', { class: 'drop-info' });
      info.append(
        el('div', { class: 'drop-name', title: link.label }, link.label),
        el('div', { class: 'drop-sub', title: link.url ?? link.name }, `${link.url ? link.url.replace(/^https:\/\//, '') : link.name} · 비밀번호 ${link.pin}`),
        el('div', { class: 'muted' }, `${left}${link.count ? ` · ${link.count}번 받음 (${formatSize(link.bytes)})` : ''}`),
      );
      const row = el('li', { class: 'drop-row', 'data-drop': link.id });
      row.append(
        info,
        el('button', { type: 'button', class: 'btn small', 'data-copy': '', disabled: !link.url }, '복사'),
        el('button', { type: 'button', class: 'btn small ghost', 'data-off': '' }, '끄기'),
      );
      return row;
    }),
  );
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
  setupDrops();

  setupAnywhere();
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

// 집 Wi-Fi QR과 '어디서나' QR을 탭으로 바꿔 보여 준다.
// 어디서나 주소는 중계 서버를 설정했으면 그 주소, 아니면 Tailscale 주소.
const QR_TAB_KEY = `${APP_ID}.qrTab`;
let qrTab = 'home';

function anywhereInfo() {
  const { relay, tailscale } = state.session;
  if (relay?.url) {
    const hint =
      relay.state === 'connected'
        ? '집 밖(LTE·5G 등)에서도 이 QR 주소로 열려요. 내용은 종단간 암호화돼요.'
        : relay.state === 'error'
          ? `중계 서버에 연결하지 못했어요: ${relay.error}`
          : '중계 서버에 연결하는 중이에요…';
    return { kind: 'relay', url: relay.url, qrSvg: relay.qrSvg, hint };
  }
  if (tailscale) return { kind: 'tailscale', url: tailscale.url, qrSvg: tailscale.qrSvg, hint: 'Tailscale을 켠 휴대폰은 집 밖에서도 이 QR 주소로 열려요.' };
  return null;
}

function setupAnywhere() {
  $('qr-tab-home').addEventListener('click', () => selectQrTab('home'));
  $('qr-tab-anywhere').addEventListener('click', () => selectQrTab('anywhere'));
  renderAnywhere();
  if (store.get(QR_TAB_KEY, 'home') === 'anywhere') queueMicrotask(() => selectQrTab('anywhere'));
}

function renderAnywhere() {
  const info = anywhereInfo();
  const { tailscale, port } = state.session;
  $('qr-tabs').hidden = !info;
  $('anywhere-help').hidden = Boolean(info);
  $('qr-tab-anywhere').textContent = info?.kind === 'tailscale' ? '어디서나 (Tailscale)' : '어디서나';
  // PC끼리 밖에서 연결할 때 쓰는 주소 (Tailscale)
  $('self-anywhere').hidden = !tailscale;
  if (tailscale) $('self-anywhere-address').textContent = port === 8765 ? tailscale.address : `${tailscale.address}:${port}`;
  if (qrTab === 'anywhere') selectQrTab(info ? 'anywhere' : 'home', false);
}

function selectQrTab(tab, remember = true) {
  if (!$('qr')) return; // 집 네트워크를 못 찾은 경우
  const info = anywhereInfo();
  const anywhere = tab === 'anywhere' && Boolean(info);
  qrTab = anywhere ? 'anywhere' : 'home';
  if (remember) store.set(QR_TAB_KEY, qrTab);
  $('qr-tab-home').setAttribute('aria-selected', String(!anywhere));
  $('qr-tab-anywhere').setAttribute('aria-selected', String(anywhere));
  $('addr-picker').hidden = anywhere || state.session.addresses.length < 2;
  if (anywhere) {
    $('qr').innerHTML = info.qrSvg; // 서버가 만든 SVG
    $('addr-url').textContent = info.kind === 'relay' ? info.url.replace(/#.*/, '#…') : info.url; // 비밀 열쇠는 화면에 다 보이지 않게
    $('qr-hint').textContent = info.hint;
  } else {
    showAddress(Number($('addr-select').value || 0));
    $('qr-hint').textContent = '휴대폰 카메라로 QR 코드를 스캔하면 바로 열려요.';
  }
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
  const android = /Android/i.test(navigator.userAgent);
  if (state.session.androidApp && android && !RELAY) {
    // 안드로이드에서는 홈 화면 바로가기보다 앱이 훨씬 편하다 (공유 메뉴, 화면 꺼져도 전송)
    if (!store.get(APP_CARD_KEY, false)) $('app-card').hidden = false;
    // 앱이 있으면 앱의 연결 화면이 열리고, 없으면 이 화면으로 돌아와 설치 안내를 띄운다
    const fallback = encodeURIComponent(`${location.origin}/#no-app`);
    $('app-pair').href = `intent://pair?host=${location.hostname}&port=${location.port || 80}#Intent;scheme=ssok;package=${ANDROID_PACKAGE};S.browser_fallback_url=${fallback};end`;
    $('app-card-close').addEventListener('click', () => {
      $('app-card').hidden = true;
      store.set(APP_CARD_KEY, true);
    });
    if (location.hash === '#no-app') {
      history.replaceState(null, '', '/');
      $('app-card').hidden = false;
      toast('먼저 ① 앱 설치 파일을 받아 설치한 뒤 다시 눌러 주세요.', 'error');
    }
  } else if (!store.get(TIP_KEY, false) && !standalone) {
    $('install-tip').hidden = false;
    // 아이폰 사파리는 메뉴(⋮)가 아니라 아래쪽 공유 버튼에 있다
    if (/iPhone|iPad/i.test(navigator.userAgent)) {
      $('install-tip-text').replaceChildren('아래쪽 공유 버튼(□↑)에서 ', el('b', {}, '‘홈 화면에 추가’'), '를 누르면 다음부터 앱처럼 바로 열려요.');
    }
  }

  const { shortcutUrl, shortcutRelayUrl } = state.session;
  if ((shortcutUrl || shortcutRelayUrl) && /iPhone|iPad/i.test(navigator.userAgent)) {
    // 아이폰은 앱 대신 '단축어'로 공유 메뉴에 보내기를 만든다.
    // PC가 중계 서버를 쓰면 어디서나 되는 주소를 먼저 권하고, 집 Wi-Fi 주소는 큰 동영상용으로 함께 보여 준다.
    const main = shortcutRelayUrl || shortcutUrl;
    $('ios-card').hidden = false;
    $('ios-url').textContent = main;
    $('ios-copy').addEventListener('click', () => copyAndReport(main));
    if (shortcutRelayUrl) {
      $('ios-note').textContent =
        '이 주소는 집에서도 밖에서도 돼요 (중계 서버를 거쳐요). 한 번에 100MB까지 보낼 수 있어요. 보내기 전용 열쇠가 들어 있으니 다른 사람에게 보여 주지 마세요. 이 경로는 휴대폰과 중계 서버 사이만 암호화돼요 (중계 서버가 내용을 볼 수 있어요).';
    }
    if (shortcutRelayUrl && shortcutUrl) {
      $('ios-alt').hidden = false;
      $('ios-alt-url').textContent = shortcutUrl;
      $('ios-alt-copy').addEventListener('click', () => copyAndReport(shortcutUrl));
    }
  }
  $('install-tip-close').addEventListener('click', () => {
    $('install-tip').hidden = true;
    store.set(TIP_KEY, true);
  });
}

// ---- 서버와 실시간 연결 ----

let events = null;
let reconnectTimer = null;

/** 서버가 보내는 실시간 알림 처리 (집 Wi-Fi의 EventSource와 어디서나(중계) 모드가 같이 쓴다) */
const EVENT_HANDLERS = {
  drops: (links) => {
    if (!state.session?.isHost) return;
    state.session.drops = links;
    renderDrops();
    renderTargets(); // 링크 상대도 보낼 곳에 나온다
  },
  relay: (info) => {
    if (!state.session?.isHost) return;
    state.session.relay = info;
    renderAnywhere();
    renderRelayStatus();
    // 중계 서버 주소가 바뀌면 받기 링크 주소도 바뀐다
    if (state.session.drops) {
      api('/api/drops')
        .then(({ links }) => {
          state.session.drops = links;
          renderDrops();
        })
        .catch(() => {});
    }
  },
  'snapshot': (data) => {
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
  },
  peers: (data) => {
    state.peers = data.peers;
    renderPeers();
  },
  'pair-request': (data) => showRequest(data),
  'pair-request-done': ({ rid, decision }) => {
    if (state.request?.rid !== rid) return;
    if (decision === 'timeout' || decision === 'gone') toast('연결 요청이 취소됐어요.');
    hideRequest();
  },
  'pair-result': (data) => onPairResult(data),
  'update': (data) => renderUpdate(data),
  'add': (item) => {
    if (state.items.some((i) => i.id === item.id)) return;
    state.items.unshift(item);
    renderItems(item.id);
    announce(item);
  },
  'remove': ({ id }) => {
    state.items = state.items.filter((i) => i.id !== id);
    renderItems();
  },
  presence: (data) => {
    state.remotes = data.remotes;
    updateStatus();
  },
};

function connectEvents() {
  if (RELAY) return connectRelayEvents();
  events?.close();
  events = new EventSource('/api/events');
  for (const [name, handle] of Object.entries(EVENT_HANDLERS)) {
    events.addEventListener(name, (e) => handle(JSON.parse(e.data)));
  }

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

/** 어디서나(중계) 모드의 실시간 알림: 암호화된 통로로 받은 text/event-stream을 직접 나눠 읽는다 */
async function connectRelayEvents() {
  let buffer = '';
  const decoder = new TextDecoder();
  try {
    const res = await request('GET', '/api/events', {
      onChunk: (chunk) => {
        buffer += decoder.decode(chunk, { stream: true });
        let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (name && data && EVENT_HANDLERS[name]) EVENT_HANDLERS[name](JSON.parse(data));
        }
      },
    });
    if (res.status === 401) return showLocked('relay');
    state.connected = true;
    updateStatus();
    await res.done;
  } catch {
    // 끊겼다: 아래에서 다시 연결한다
  }
  state.connected = false;
  updateStatus();
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(reconnect, 3000);
}

async function reconnect() {
  clearTimeout(reconnectTimer);
  try {
    const res = await request('GET', '/api/session');
    if (res.status === 401) return showLocked(RELAY ? 'relay' : undefined);
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
  if (!isHost) return setStatus('online', RELAY ? 'PC와 연결됨 · 어디서나' : 'PC와 연결됨');
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
    document.title = `(${state.unseen}) ${pageTitle()}`;
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
  if (item.kind === 'file' && PREVIEWABLE_IMAGES.has(item.mime) && (!RELAY || item.size <= 3 * 1024 * 1024)) {
    const img = el('img', { src: RELAY ? undefined : fileUrl(item, true), alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => img.remove());
    // 어디서나(중계) 모드에서는 암호화된 통로로 받아 화면에 붙인다
    if (RELAY) relayBlobUrl(fileUrl(item, true)).then((url) => (img.src = url), () => img.remove());
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
      href: RELAY ? '#' : fileUrl(item),
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
  if (state.session.isHost && item.to) return `${(state.session.drops || []).find((l) => l.id === item.to)?.label ?? '링크'}에게 보냄 (링크)`;
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
      if (RELAY) {
        e.preventDefault();
        relayDownload(item);
        break;
      }
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

/** 어디서나(중계) 모드에서 파일 받기: 암호화된 통로로 받아 휴대폰에 저장한다 */
async function relayDownload(item) {
  if (item.size > 500 * 1024 * 1024) toast('큰 파일이라 시간이 걸려요. 집 Wi-Fi에서 받으면 더 빨라요.');
  else toast(`‘${item.name}’ 받는 중…`);
  try {
    const res = await request('GET', fileUrl(item));
    if (!res.ok) throw new Error('PC에서 파일을 찾지 못했어요.');
    const url = URL.createObjectURL(await res.blob());
    const link = el('a', { href: url, download: item.name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    markDownloaded(item.id);
  } catch (err) {
    showError(err);
  }
}

const blobUrls = new Map();
async function relayBlobUrl(path) {
  if (!blobUrls.has(path)) {
    blobUrls.set(
      path,
      request('GET', path).then(async (res) => {
        if (!res.ok) throw new Error('미리보기를 받지 못했어요');
        return URL.createObjectURL(await res.blob());
      }),
    );
  }
  return blobUrls.get(path);
}

function download(item) {
  if (RELAY) return relayDownload(item);
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
      const toLink = peer?.kind === 'link';
      await api(peer && !toLink ? `/api/peers/${peer.id}/text` : '/api/text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toLink ? { text, to: peer.id } : { text }),
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
  if (RELAY) return relayUpload(file, onProgress);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    transfer.xhr = xhr;
    const params = new URLSearchParams({ name: file.name || 'file' });
    if (file.lastModified) params.set('lastModified', String(file.lastModified));
    // 다른 PC로 보낼 때는 이 PC의 프로그램이 받아서 그대로 그 PC로 흘려보낸다. 링크 상대에게는 이 PC에 두고 그 사람이 받아 간다.
    if (target?.kind === 'link') params.set('to', target.id);
    xhr.open('POST', `${target && target.kind !== 'link' ? `/api/peers/${target.id}/upload` : '/api/upload'}?${params}`);
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

/** 어디서나(중계) 모드에서 파일 보내기: 조각마다 암호화해서 보낸다 */
async function relayUpload(file, onProgress) {
  const params = new URLSearchParams({ name: file.name || 'file' });
  if (file.lastModified) params.set('lastModified', String(file.lastModified));
  const controller = new AbortController();
  transfer.abort = controller;
  try {
    const res = await request('POST', `/api/upload?${params}`, {
      headers: { 'x-requested-with': APP_ID, 'content-type': file.type || 'application/octet-stream' },
      body: file,
      onUploadProgress: onProgress,
      signal: controller.signal,
    });
    if (res.ok) return;
    if (res.status === 401) showLocked('relay');
    let message = '보내지 못했어요.';
    try {
      message = (await res.json()).error || message;
    } catch {
      // JSON이 아닌 응답
    }
    throw new Error(message);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw err.code ? new Error('연결이 끊겼어요.') : err;
  } finally {
    transfer.abort = null;
  }
}

function cancelTransfer() {
  transfer.abort?.abort();
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

  if (settings?.autoUpdate !== null && settings?.autoUpdate !== undefined) {
    $('update-row').hidden = false;
    $('autoupdate').checked = settings.autoUpdate;
    $('version-text').textContent = `지금 버전 ${settings.version}`;
    $('autoupdate').addEventListener('change', async (e) => {
      try {
        await saveSettings({ autoUpdate: e.target.checked });
      } catch (err) {
        e.target.checked = !e.target.checked;
        showError(err);
      }
    });
    $('update-check').addEventListener('click', async () => {
      try {
        const result = await post('/api/update/check');
        renderUpdate(result);
        if (!result.available && !result.error) toast('지금 버전이 최신이에요.');
        if (result.error) toast(result.error, 'error');
      } catch (err) {
        showError(err);
      }
    });
  }
  if (settings?.relay) {
    $('relay-form').hidden = false;
    $('relay-url').value = settings.relay.url.replace(/^https:\/\//, '');
    $('relay-invite').value = settings.relay.invite;
    renderRelayStatus();
    $('relay-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await saveSettings({ relay: { url: $('relay-url').value, invite: $('relay-invite').value } });
        toast($('relay-url').value.trim() ? '중계 서버에 연결하는 중이에요. 잠시 뒤 [어디서나] QR이 생겨요.' : '어디서나(중계)를 껐어요.');
      } catch (err) {
        showError(err);
      }
    });
  }
  if (state.session.canOpenLog) {
    $('log-row').hidden = false;
    $('open-log').addEventListener('click', () => post('/api/open-log').catch(showError));
  }
  if (state.session.update) renderUpdate(state.session.update);
  $('update-apply').addEventListener('click', applyUpdate);

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

// ---- 업데이트 (PC 화면 전용) ----

let restartingTo = null;

function renderUpdate(update) {
  const card = $('update-card');
  if (!update || (!update.available && !update.progress && !update.restarting)) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const { available, progress } = update;
  if (update.restarting) {
    $('update-title').textContent = `${available?.version ?? '새'} 버전으로 다시 켜는 중…`;
    $('update-notes').textContent = '잠시 뒤 이 화면이 저절로 새로 고쳐져요.';
    $('update-progress').hidden = true;
    $('update-apply').hidden = true;
    waitForRestart(available?.version);
    return;
  }
  if (progress) {
    const percent = Math.floor((progress.received / progress.size) * 100);
    $('update-title').textContent = `${progress.version} 버전 내려받는 중… ${percent}%`;
    $('update-progress').hidden = false;
    $('update-bar').style.width = `${percent}%`;
    $('update-apply').hidden = true;
    return;
  }
  $('update-title').textContent = `새 버전 ${available.version}이(가) 있어요`;
  $('update-notes').textContent = available.notes || '';
  $('update-progress').hidden = true;
  $('update-apply').hidden = false;
  $('update-apply').disabled = false;
}

async function applyUpdate() {
  $('update-apply').disabled = true;
  try {
    renderUpdate(await post('/api/update/apply'));
  } catch (err) {
    $('update-apply').disabled = false;
    showError(err);
  }
}

/** 새 버전이 뜰 때까지 기다렸다가 화면을 새로 고친다 */
async function waitForRestart(version) {
  if (restartingTo) return;
  restartingTo = version || 'any';
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    try {
      const res = await fetch('/api/ping', { cache: 'no-store' });
      const info = await res.json();
      if (info.version !== state.session.version && (!version || info.version === version)) {
        location.reload();
        return;
      }
    } catch {
      // 바뀌는 동안에는 잠깐 꺼져 있다
    }
  }
  restartingTo = null;
  toast(`업데이트가 끝나지 않은 것 같아요. 시작 메뉴에서 ${APP_NAME}을(를) 다시 실행해 주세요.`, 'error');
}

function renderRelayStatus() {
  const relay = state.session.relay;
  const text = !relay
    ? '중계 서버 주소와 초대 코드를 넣으면 집 밖에서도 QR만으로 보낼 수 있어요.'
    : relay.state === 'connected'
      ? `● ${relay.host}에 연결됨`
      : relay.state === 'error'
        ? `연결하지 못했어요: ${relay.error}`
        : `${relay.host}에 연결하는 중…`;
  $('relay-status').textContent = text;
  $('relay-status').classList.toggle('ok', relay?.state === 'connected');
}

const saveSettings = (patch) =>
  api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });

// ---- 다른 PC (PC 화면 전용) ----

let earlyPairResult = null; // 연결 요청 응답보다 결과 알림이 먼저 도착한 경우

const peerById = (id) => state.peers.find((p) => p.id === id);

/** 지금 보낼 곳: 연결된 PC면 그 PC, 링크 상대면 { kind: 'link', id, name }, 휴대폰이면 null */
function currentTarget() {
  const link = currentLink();
  if (link) return { kind: 'link', id: link.id, name: link.label };
  const peer = peerById(state.target);
  return peer?.paired && peer.kind === 'pc' ? peer : null;
}

function currentLink() {
  const m = /^link:([0-9a-f]{16})$/.exec(state.target || '');
  return m ? ((state.session.drops || []).find((l) => l.id === m[1]) ?? null) : null;
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
  $('remote-code-make').addEventListener('click', makeRemoteCode);

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
  const links = state.session.drops || [];
  const add = el('button', { type: 'button', class: 'chip add', 'data-add': '' });
  add.append(icon('i-plus'), el('span', {}, paired.length ? 'PC 추가' : '다른 PC'));
  $('targets').replaceChildren(
    targetChip('phone', 'i-phone', '휴대폰', undefined, !peer),
    ...paired.map((p) => targetChip(p.id, 'i-pc', p.name, p.online, peer?.id === p.id, p.via)),
    ...links.map((l) => targetChip(`link:${l.id}`, 'i-link', l.label, undefined, peer?.kind === 'link' && peer.id === l.id)),
    add,
  );

  const offline = Boolean(peer && peer.kind !== 'link' && !peer.online);
  $('dropzone').classList.toggle('offline', offline);
  if (peer?.kind === 'link') {
    const link = currentLink();
    $('dropzone-title').textContent = `${peer.name}에게 보낼 파일을 여기에 끌어다 놓으세요`;
    $('dropzone-hint').textContent = `링크(${link.url ? link.url.replace(/^https:\/\//, '') : link.name})로 ${peer.name}에게 가요. 받아 갈 수 있게 이 PC를 켜 두세요.`;
    $('text-input').placeholder = `${peer.name}에게 보낼 텍스트나 링크`;
  } else if (peer) {
    $('dropzone-title').textContent = `${peer.name}에 보낼 파일을 여기에 끌어다 놓으세요`;
    $('dropzone-hint').textContent = offline
      ? peer.relay
        ? `지금은 꺼져 있는 것 같아요. 그 PC에서 ${APP_NAME} 프로그램을 켜 주세요.`
        : `같은 네트워크에서 보이지 않아요. 그 PC가 켜져 있는지 확인해 주세요. 집 밖에서도 보내려면 두 PC 모두 [설정]의 ‘어디서나 (중계 서버)’를 켜 두세요.`
      : peer.via === 'relay'
        ? '집 밖에 있어 중계 서버를 거쳐 보내요 (종단간 암호화). 같은 Wi-Fi일 때보다 느릴 수 있어요.'
        : '그 PC의 받은 파일 폴더에 바로 저장돼요. 캡처한 화면은 Ctrl+V로 붙여 넣으세요.';
    $('text-input').placeholder = `${peer.name}에 보낼 텍스트나 링크`;
  } else {
    $('dropzone-title').textContent = '휴대폰으로 보낼 파일을 여기에 끌어다 놓으세요';
    $('dropzone-hint').textContent = '클릭해서 고르거나, 캡처한 화면을 Ctrl+V로 붙여 넣어도 돼요';
    $('text-input').placeholder = '휴대폰으로 보낼 텍스트나 링크';
  }
}

function targetChip(id, iconId, label, online, selected, via = null) {
  const chip = el('button', {
    type: 'button',
    class: 'chip',
    'data-target': id,
    'aria-pressed': String(selected),
    title: online === false ? `${label} · 꺼져 있음` : via === 'relay' ? `${label} · 어디서나 (중계 서버로 보내요)` : label,
  });
  chip.append(icon(iconId), el('span', { class: 'chip-name' }, label));
  if (online !== undefined) chip.append(el('span', { class: online ? (via === 'relay' ? 'chip-dot relay' : 'chip-dot') : 'chip-dot off', 'aria-hidden': 'true' }));
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
    if (peer.paired) sub.append(el('span', { class: peer.online ? 'on' : '' }, peer.via === 'relay' ? '어디서나 (중계)' : peer.online ? '켜져 있음' : '꺼져 있음'), ' · ');
    // 다른 곳에서 연결한 PC는 같은 네트워크 주소를 모른다
    sub.append(peer.via === 'relay' ? '집 밖에서도 보낼 수 있어요' : peer.address || '다른 곳에서 연결한 PC');
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

/** 다른 곳의 PC가 이 PC에 연결할 때 넣을 코드를 만들어 보여 준다 (10분 동안) */
let remoteCodeTimer = null;
async function makeRemoteCode() {
  const button = $('remote-code-make');
  button.disabled = true;
  try {
    const { code, expires, relay } = await api('/api/peers/remote-code', { method: 'POST' });
    $('remote-code').textContent = code;
    $('remote-code-other').textContent = `상대 PC가 다른 중계 서버를 쓴다면: ${relay}/${code}`;
    $('remote-code-box').hidden = false;
    button.textContent = '새 코드 만들기';
    clearInterval(remoteCodeTimer);
    const tick = () => {
      const left = Math.ceil((expires - Date.now()) / 60_000);
      if (left <= 0) {
        clearInterval(remoteCodeTimer);
        $('remote-code-box').hidden = true;
        button.textContent = '이 PC의 연결 코드 만들기';
        return;
      }
      $('remote-code-left').textContent = `(${left}분 동안 쓸 수 있어요)`;
    };
    tick();
    remoteCodeTimer = setInterval(tick, 15_000);
  } catch (err) {
    showError(err);
  } finally {
    button.disabled = false;
  }
}

/** 'ABCD-EFGH', 'ssok.example.com/ABCD-EFGH' 같은 연결 코드인지 (서버의 parseRemoteCode와 같은 모양) */
const looksLikeRemoteCode = (text) => /^(?:(?:https?:\/\/)?[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?::\d+)?[\s/]+)?[A-Za-z0-9]{4}(?:\s*-\s*|\s+)[A-Za-z0-9]{4}$/.test(text.trim());

async function connectByAddress(e) {
  e.preventDefault();
  const input = $('connect-address');
  const button = e.target.querySelector('button');
  button.disabled = true;
  state.pairing = null;
  renderPairing();
  if (looksLikeRemoteCode(input.value)) {
    // 다른 곳의 PC: 코드로 찾아 바로 연결을 시작한다 (확인 숫자가 뜬다)
    earlyPairResult = null;
    try {
      const { id, name, code } = await api('/api/peers/connect-remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: input.value }),
      });
      input.value = '';
      state.pairing = { id, name, code };
      renderPeerDialog();
      if (earlyPairResult?.id === id) onPairResult(earlyPairResult);
    } catch (err) {
      state.pairing = { id: null, error: err.message };
      renderPairing();
    } finally {
      button.disabled = false;
    }
    return;
  }
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
  $('request-address').textContent =
    request.kind === 'app' ? ` (휴대폰 앱 · ${request.address})` : request.address ? ` (${request.address})` : ' (다른 곳 · 중계 서버를 거쳐)';
  $('request-code').textContent = formatCode(request.code);
  const dialog = $('request-dialog');
  if (!dialog.open) dialog.showModal();
  if (document.hidden) document.title = `연결 요청 · ${pageTitle()}`;
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

/**
 * PC의 쏙에 요청한다. 집 Wi-Fi에서는 그냥 fetch, 어디서나(중계) 모드에서는 암호화된 통로로 보낸다.
 * 돌려주는 값: { status, ok, json(), text(), blob() } (중계 모드는 done, 그리고 onChunk로 조각을 받을 수 있다)
 */
async function request(method, url, { headers = {}, body = null, onUploadProgress, onChunk, signal } = {}) {
  if (!RELAY) {
    const res = await fetch(url, { method, headers, body, cache: 'no-store', signal });
    return { status: res.status, ok: res.ok, json: () => res.json(), text: () => res.text(), blob: () => res.blob() };
  }
  const client = await relayClient();
  return client.request(method, url, { headers: { 'user-agent': navigator.userAgent, ...headers }, body, onUploadProgress, onChunk, signal });
}

let relayConnection = null;
function relayClient() {
  if (!relayConnection) {
    relayConnection = RelayClient.connect(`wss://${location.host}/ws/c/${RELAY.pcId}`, fromHex(RELAY.secret), {
      onClose: () => {
        relayConnection = null; // 다음 요청 때 다시 연결한다
      },
    }).catch((err) => {
      relayConnection = null;
      throw err;
    });
  }
  return relayConnection;
}

async function api(url, options = {}) {
  const res = await request(options.method || 'GET', url, {
    body: options.body ?? null,
    headers: { 'X-Requested-With': APP_ID, ...options.headers },
  });
  if (res.status === 401) {
    showLocked(RELAY ? 'relay' : undefined);
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
