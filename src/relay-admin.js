// 중계 서버의 관리 화면 (127.0.0.1에서만 열린다).
// 다른 웹사이트가 이 PC의 브라우저를 통해 몰래 요청하지 못하게:
//   - Host 헤더가 127.0.0.1/localhost가 아니면 거절 (DNS 리바인딩 방지)
//   - 바꾸는 요청은 X-Requested-With 헤더가 있어야 한다 (다른 사이트에서는 이 헤더를 붙여 보낼 수 없다)
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sendJson, sendText, sendEmpty, readJson } from './http.js';
import { APP_NAME, APP_ID } from './brand.js';

const FILES = {
  'relay-admin.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
  'icon.svg': 'image/svg+xml',
  'icon.ico': 'image/x-icon',
};
const INVITE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const PC_ID = /^[0-9a-f]{16}$/;

/**
 * @param {object} options
 * @param {string} options.publicDir
 * @param {number} options.port
 * @param {() => object} options.ping
 * @param {() => object} options.state
 * @param {Record<string, Function>} options.actions
 */
export function createAdminServer({ publicDir, port, ping, state, actions, log = () => {} }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!err.status) log('error', err);
      if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : '처리하지 못했어요.' });
    });
  });

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) return sendText(res, 403, 'Forbidden');
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    if (req.method === 'GET') {
      if (p === '/api/ping') return sendJson(res, 200, ping());
      if (p === '/api/state') return sendJson(res, 200, state());
      if (p === '/') return servePage(res);
      const name = p.slice(1);
      if (FILES[name]) return serveFile(res, name);
      return sendText(res, 404, 'Not Found');
    }

    if (req.headers['x-requested-with'] !== APP_ID) return sendText(res, 403, 'Forbidden');
    const body = req.method === 'POST' ? ((await readJson(req, 16 * 1024)) ?? {}) : {};
    let m;
    if (req.method === 'POST' && p === '/api/setup') {
      actions.setup(body);
      return sendEmpty(res, 202);
    }
    if (req.method === 'POST' && p === '/api/check') return sendJson(res, 200, await actions.check());
    if (req.method === 'POST' && p === '/api/open-login') {
      actions.openLogin();
      return sendEmpty(res);
    }
    if (req.method === 'POST' && p === '/api/invites') return sendJson(res, 201, actions.createInvite(String(body.label ?? '').trim()));
    if (req.method === 'POST' && (m = /^\/api\/invites\/([A-Z0-9-]+)$/.exec(p)) && INVITE.test(m[1])) {
      if (!actions.setInviteDisabled(m[1], Boolean(body.disabled))) return sendJson(res, 404, { error: '그 초대 코드가 없어요.' });
      return sendEmpty(res);
    }
    if (req.method === 'DELETE' && (m = /^\/api\/pcs\/([0-9a-f]+)$/.exec(p)) && PC_ID.test(m[1])) {
      actions.removePc(m[1]);
      return sendEmpty(res);
    }
    // 홈페이지 주고받기의 암호 (숫자 4자리, 비우면 끈다)
    if (req.method === 'POST' && p === '/api/web') {
      const pin = body.pin === null || body.pin === '' || body.pin === undefined ? null : String(body.pin).trim();
      actions.setWebPin(pin);
      return sendEmpty(res);
    }
    if (req.method === 'POST' && p === '/api/settings') {
      await actions.settings(body);
      return sendEmpty(res);
    }
    if (req.method === 'POST' && p === '/api/update') {
      actions.update();
      return sendEmpty(res, 202);
    }
    if (req.method === 'POST' && p === '/api/update/check') {
      await actions.checkUpdate();
      return sendEmpty(res);
    }
    if (req.method === 'POST' && p === '/api/open-log') {
      actions.openLog();
      return sendEmpty(res);
    }
    if (req.method === 'POST' && p === '/api/show') {
      actions.show();
      return sendEmpty(res);
    }
    if (req.method === 'POST' && p === '/api/quit') {
      sendEmpty(res);
      setTimeout(() => actions.quit(), 100);
      return;
    }
    return sendText(res, 404, 'Not Found');
  }

  async function servePage(res) {
    const html = (await fsp.readFile(path.join(publicDir, 'relay-admin.html'), 'utf8')).replaceAll('{{APP_NAME}}', APP_NAME);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
    });
    res.end(html);
  }

  async function serveFile(res, name) {
    let body;
    try {
      body = await fsp.readFile(path.join(publicDir, name));
    } catch {
      return sendText(res, 404, 'Not Found');
    }
    if (name.endsWith('.js')) body = Buffer.from(body.toString('utf8').replaceAll('{{APP_NAME}}', APP_NAME).replaceAll('{{APP_ID}}', APP_ID));
    res.writeHead(200, { 'Content-Type': FILES[name], 'Content-Length': body.length });
    res.end(body);
  }

  return server;
}
