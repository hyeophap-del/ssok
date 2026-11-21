// 쏙 중계 서버 관리 화면 (이 PC에서만 열린다: http://127.0.0.1:8781)
const APP_NAME = '{{APP_NAME}}';
const APP_ID = '{{APP_ID}}';
const $ = (id) => document.getElementById(id);

/** 글자는 textContent로만 넣는다 (PC 이름·초대 이름은 다른 사람이 정한 값이라 HTML로 넣지 않는다) */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
}

function toast(message, type = '') {
  const box = $('toasts');
  const node = el('div', { class: `toast ${type}`.trim(), role: type === 'error' ? 'alert' : 'status' }, el('span', {}, message));
  box.append(node);
  while (box.children.length > 2) box.firstElementChild.remove();
  setTimeout(() => node.remove(), type === 'error' ? 6000 : 3000);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'X-Requested-With': APP_ID, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `처리하지 못했어요 (HTTP ${res.status}).`;
    try {
      message = (await res.json()).error || message;
    } catch {
      // 기본 문구
    }
    throw new Error(message);
  }
  return res.status === 204 || res.status === 202 ? null : res.json();
}

const run = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    toast(err.message, 'error');
  }
  refresh();
};

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function ago(time) {
  if (!time) return '';
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.round(hours / 24)}일 전`;
}

// ---- 터널 연결 단계 ----
const STEPS = [
  ['download', 'Cloudflare 프로그램(cloudflared) 내려받기'],
  ['login', 'Cloudflare 로그인'],
  ['tunnel', '터널 만들기'],
  ['dns', '주소 연결 (DNS)'],
  ['start', '터널 켜기'],
  ['check', '바깥에서 접속 확인'],
];

let state = null;
let editingAddress = false;
let lastHostname = '';

function renderSetup() {
  const { setup, hostname, tunnel, reach } = state;
  const showSteps = setup.running || setup.error || (setup.step && setup.step !== 'done');
  const configured = Boolean(hostname) && tunnel.configured;
  $('addr-done').hidden = !configured || setup.running || editingAddress;
  $('setup-form').hidden = (configured && !editingAddress) || setup.running;
  $('setup-start').disabled = setup.running;

  if (configured) {
    $('addr-value').textContent = `https://${hostname}`;
    const t = $('tunnel-fact');
    t.replaceChildren(
      'Cloudflare 터널: ',
      tunnel.ready
        ? el('span', { class: 'ok' }, `● 연결됨 (${tunnel.connections}개 연결)`)
        : el('span', { class: 'bad' }, tunnel.running ? '연결하는 중…' : `꺼짐${tunnel.error ? ` — ${tunnel.error}` : ''}`),
    );
    const r = $('reach-fact');
    r.replaceChildren(
      '바깥에서 접속: ',
      reach.checking
        ? el('span', { class: 'muted' }, '확인하는 중…')
        : reach.ok
          ? el('span', { class: 'ok' }, `● 잘 돼요${reach.checkedAt ? ` (${ago(reach.checkedAt)} 확인)` : ''}`)
          : el('span', { class: 'bad' }, reach.error || '아직 확인하지 않았어요'),
    );
  }

  $('steps').hidden = !showSteps;
  if (showSteps) {
    const current = STEPS.findIndex(([key]) => key === setup.step);
    $('steps').replaceChildren(
      ...STEPS.map(([key, label], i) => {
        const status = i < current ? 'done' : i === current ? (setup.error ? 'failed' : setup.running ? 'active' : 'done') : '';
        let note = null;
        if (key === 'download' && status === 'active' && setup.progress != null) note = `${setup.progress}%`;
        if (key === 'login' && status === 'active') {
          note = el(
            'span',
            {},
            '브라우저에 Cloudflare 로그인 창이 열려요. 로그인한 뒤 ',
            el('b', {}, lastHostname.split('.').slice(-2).join('.') || '도메인'),
            '을(를) 고르고 [Authorize]를 눌러 주세요. ',
            setup.loginUrl ? el('button', { class: 'btn small', type: 'button', onclick: run(() => api('POST', '/api/open-login')) }, '로그인 창 다시 열기') : null,
          );
        }
        if (key === 'check' && status === 'active') note = '주소가 인터넷에 퍼지는 데 1~2분 걸릴 수 있어요.';
        return el(
          'li',
          { class: `step ${status}`.trim() },
          el('span', { class: 'mark' }, status === 'done' ? '✓' : status === 'failed' ? '!' : String(i + 1)),
          el('span', {}, label, note ? el('span', { class: 'note' }, note) : null),
        );
      }),
    );
  }

  $('setup-error').hidden = !setup.error || setup.running;
  $('setup-error-text').textContent = setup.error || '';
  $('setup-relogin').hidden = !setup.needsRelogin;

  const lines = tunnel.lastLines || [];
  $('tunnel-log-box').hidden = !lines.length;
  $('tunnel-log').textContent = lines.join('\n');
}

// ---- 초대 코드 ----
function renderInvites() {
  const { invites, hostname } = state;
  $('invites').replaceChildren(
    ...[...invites].reverse().map((invite) =>
      el(
        'li',
        { class: `invite${invite.disabled ? ' disabled' : ''}` },
        el(
          'div',
          { class: 'invite-head' },
          el('span', { class: 'invite-label' }, invite.label),
          el('span', { class: 'invite-code' }, invite.code),
          el(
            'button',
            {
              class: 'btn small',
              type: 'button',
              onclick: run(async () => {
                await navigator.clipboard.writeText(invite.code);
                toast('초대 코드를 복사했어요.');
              }),
            },
            '복사',
          ),
          el(
            'button',
            {
              class: 'btn small ghost',
              type: 'button',
              onclick: run(async () => {
                if (!invite.disabled && !confirm(`‘${invite.label}’ 초대 코드를 막을까요? 이 코드로 연결한 PC들이 바로 끊겨요.`)) return;
                await api('POST', `/api/invites/${invite.code}`, { disabled: !invite.disabled });
              }),
            },
            invite.disabled ? '막기 풀기' : '막기',
          ),
        ),
        el(
          'div',
          { class: 'muted small' },
          `${invite.disabled ? '막힘 · ' : ''}지금까지 ${formatSize(invite.bytes)} 주고받음 · ${new Date(invite.createdAt).toLocaleDateString('ko-KR')} 만듦`,
        ),
        invite.pcs.length
          ? el(
              'ul',
              { class: 'pcs' },
              invite.pcs.map((pc) =>
                el(
                  'li',
                  { class: 'pc' },
                  el('span', { class: `dot${pc.online ? ' on' : ''}`, 'aria-hidden': 'true' }),
                  el('span', { class: 'pc-name' }, pc.name),
                  el('span', { class: 'muted' }, pc.online ? (pc.sessions ? `연결됨 · 휴대폰 ${pc.sessions}대 주고받는 중` : '연결됨') : `꺼짐 · 마지막 연결 ${ago(pc.lastSeen)}`),
                  el(
                    'button',
                    {
                      class: 'btn small ghost',
                      type: 'button',
                      title: '이 PC를 목록에서 지워요 (초대 코드가 있으면 다시 연결할 수 있어요)',
                      onclick: run(async () => {
                        if (!confirm(`‘${pc.name}’을(를) 목록에서 지울까요?`)) return;
                        await api('DELETE', `/api/pcs/${pc.id}`);
                      }),
                    },
                    '지우기',
                  ),
                ),
              ),
            )
          : el('div', { class: 'muted small' }, '아직 이 코드로 연결한 PC가 없어요.'),
      ),
    ),
  );
  $('howto').hidden = !invites.length;
  if (invites.length) {
    $('howto').replaceChildren(
      '쓰는 방법: 각자 PC의 ',
      el('b', {}, APP_NAME),
      ' 화면 → [설정] → ‘어디서나 (중계 서버)’에 주소 ',
      el('b', {}, hostname || '(위의 인터넷 주소)'),
      '와(과) 초대 코드를 넣고 [저장]. 그러면 QR 카드에 [어디서나] 탭이 생겨요.',
    );
  }
}

// ---- 설정 ----
function renderWeb() {
  const { web, hostname } = state;
  if (!web) return;
  $('web-host').textContent = hostname ? `https://${hostname}` : '이 중계 서버 주소';
  $('web-off').hidden = !web.enabled;
  $('web-state').replaceChildren(
    web.enabled
      ? el('span', { class: 'ok' }, `● 켜짐 · 암호 ${web.pin}`)
      : el('span', { class: 'muted' }, '꺼짐 (암호를 정하면 켜져요)'),
    web.enabled ? el('span', { class: 'muted' }, `지금 방 ${web.rooms}개 기다림 · ${web.connected}쌍 주고받는 중 · 지금까지 ${formatSize(web.bytes)}`) : null,
  );
}

function renderSettings() {
  const { settings, version, update } = state;
  $('autostart-row').hidden = settings.autostart === null;
  $('autostart').checked = Boolean(settings.autostart);
  $('autoupdate-row').hidden = settings.autoUpdate === null;
  $('autoupdate').checked = Boolean(settings.autoUpdate);
  let text = `지금 버전 ${version}`;
  if (update?.updating || update?.progress) text += ` · ${update.available?.version ?? '새 버전'}(으)로 업데이트하는 중…`;
  else if (update?.available) text += ` · 새 버전 ${update.available.version}이(가) 있어요. 주고받는 사람이 없을 때 바꿔요.`;
  $('version-text').textContent = text;
}

function renderStatus() {
  const { hostname, tunnel, reach, relayError, invites } = state;
  const online = invites.reduce((n, i) => n + i.pcs.filter((p) => p.online).length, 0);
  let mode = 'waiting';
  let text = '인터넷 주소를 연결해 주세요';
  if (relayError) [mode, text] = ['offline', '중계 서버를 켜지 못했어요'];
  else if (hostname && tunnel.ready && reach.ok) [mode, text] = ['online', `동작 중 · PC ${online}대 연결됨`];
  else if (hostname && tunnel.ready) [mode, text] = ['waiting', '터널 연결됨 · 바깥 접속 확인 중'];
  else if (hostname) [mode, text] = ['offline', '터널이 끊겼어요'];
  $('status').dataset.state = mode;
  $('status-text').textContent = text;
  $('relay-error').hidden = !relayError;
  $('relay-error-text').textContent = relayError || '';
}

let failures = 0;
async function refresh() {
  try {
    state = await (await fetch('/api/state', { cache: 'no-store' })).json();
    failures = 0;
  } catch {
    if (++failures >= 2) {
      $('status').dataset.state = 'offline';
      $('status-text').textContent = '중계 서버가 꺼졌어요';
    }
    return;
  }
  if (!lastHostname && state.hostname) lastHostname = state.hostname;
  if (!$('hostname').value && state.hostname && document.activeElement !== $('hostname')) $('hostname').value = state.hostname;
  renderStatus();
  renderSetup();
  renderInvites();
  renderSettings();
  renderWeb();
}

let timer = null;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await refresh();
    schedule();
  }, state?.setup.running ? 1000 : 2500);
}

// ---- 버튼 ----
function startSetup(freshLogin = false) {
  return run(async () => {
    lastHostname = $('hostname').value.trim() || state?.hostname || '';
    await api('POST', '/api/setup', { hostname: lastHostname, freshLogin });
    editingAddress = false;
  })();
}

$('setup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  startSetup(false);
});
$('setup-retry').addEventListener('click', () => startSetup(false));
$('setup-relogin').addEventListener('click', () => startSetup(true));
$('change-addr').addEventListener('click', () => {
  editingAddress = true;
  renderSetup();
  $('hostname').focus();
});
$('recheck').addEventListener('click', run(() => api('POST', '/api/check')));
$('invite-form').addEventListener(
  'submit',
  run(async (e) => {
    e.preventDefault();
    const invite = await api('POST', '/api/invites', { label: $('invite-label').value.trim() });
    $('invite-label').value = '';
    toast(`초대 코드 ${invite.code}를 만들었어요.`);
  }),
);
$('web-form').addEventListener(
  'submit',
  run(async (e) => {
    e.preventDefault();
    const pin = $('web-pin').value.trim();
    if (!/^\d{4}$/.test(pin)) throw new Error('암호는 숫자 4자리로 정해 주세요.');
    await api('POST', '/api/web', { pin });
    $('web-pin').value = '';
    toast(`홈페이지 암호를 ${pin}(으)로 정했어요.`);
  }),
);
$('web-off').addEventListener(
  'click',
  run(async () => {
    if (!confirm('홈페이지에서 바로 주고받기를 끌까요? 기다리던 방도 닫혀요.')) return;
    await api('POST', '/api/web', { pin: null });
  }),
);
$('autostart').addEventListener('change', run(() => api('POST', '/api/settings', { autostart: $('autostart').checked })));
$('autoupdate').addEventListener('change', run(() => api('POST', '/api/settings', { autoUpdate: $('autoupdate').checked })));
$('open-log').addEventListener('click', run(() => api('POST', '/api/open-log')));
$('quit').addEventListener(
  'click',
  run(async () => {
    if (!confirm('중계 서버를 끌까요? 끄면 집 밖에서 쏙으로 주고받을 수 없어요. 다시 켜려면 시작 메뉴의 ‘쏙 중계 서버’를 실행하세요.')) return;
    await api('POST', '/api/quit');
  }),
);

await refresh();
schedule();
