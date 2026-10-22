// Shared login / register / logout handling for both web apps.
// The session token lives in an HttpOnly cookie; this script never sees it.
(function () {
  'use strict';
  const $ = (sel) => document.querySelector(sel);

  async function api(path, opts = {}) {
    const headers = Object.assign({ 'X-Requested-With': 'fetch' }, opts.headers || {});
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.json);
    }
    const res = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body, credentials: 'same-origin' });
    let data = {};
    try { data = await res.json(); } catch (_) { /* empty */ }
    if (!res.ok) {
      const err = new Error(data.error || `request failed (${res.status})`);
      err.status = res.status;
      err.fields = data.fields;
      throw err;
    }
    return data;
  }

  function show(msgEl, text, kind) {
    msgEl.textContent = text || '';
    msgEl.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function explain(err) {
    if (err.status === 503) return 'A backend service is unavailable right now. Please try again shortly.';
    if (err.fields) return `${err.message}: check ${err.fields.join(', ')}`;
    return err.message;
  }

  function init(onSignedIn) {
    const authView = $('#auth-view');
    const appView = $('#app-view');
    const form = $('#login-form');
    const msg = $('#login-msg');
    let mode = 'login';

    const setMode = (m) => {
      mode = m;
      $('#tab-login').classList.toggle('on', m === 'login');
      $('#tab-register').classList.toggle('on', m === 'register');
      $('#login-submit').textContent = m === 'login' ? 'Sign in' : 'Create viewer account';
      show(msg, '');
    };
    $('#tab-login').addEventListener('click', () => setMode('login'));
    $('#tab-register').addEventListener('click', () => setMode('register'));

    const enter = (user) => {
      $('#who').textContent = user.username;
      $('#who-role').textContent = user.role;
      $('#user-chip').classList.remove('hidden');
      authView.classList.add('hidden');
      appView.classList.remove('hidden');
      onSignedIn(user);
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = form.username.value.trim();
      const password = form.password.value;
      const btn = $('#login-submit');
      btn.disabled = true;
      try {
        if (mode === 'register') {
          await api('/api/register', { method: 'POST', json: { username, password } });
        }
        const user = await api('/api/login', { method: 'POST', json: { username, password } });
        form.reset();
        enter(user);
      } catch (err) {
        show(msg, explain(err), 'err');
      } finally {
        btn.disabled = false;
      }
    });

    $('#logout').addEventListener('click', async () => {
      try { await api('/api/logout', { method: 'POST' }); } catch (_) { /* ignore */ }
      location.reload();
    });

    api('/api/me').then(enter).catch((err) => {
      authView.classList.remove('hidden');
      if (err.status === 503) show(msg, explain(err), 'err');
    });
  }

  window.VSS = { api, init, show, explain };
})();
