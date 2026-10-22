(function () {
  'use strict';
  const { api, init, show, explain } = window.VSS;
  const $ = (s) => document.querySelector(s);
  const MAX_MB = 500;
  const TYPES = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'];

  const toWatch = $('#to-watch');
  toWatch.href = `${location.protocol}//${location.hostname}:${toWatch.dataset.port}/`;
  $('#max-mb').textContent = MAX_MB;

  const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.ceil(n / 1024) + ' KB');
  const fmtDate = (d) => new Date(d).toLocaleString();

  async function loadMine() {
    const body = $('#mine');
    body.textContent = '';
    try {
      const { videos } = await api('/api/videos');
      $('#mine-empty').classList.toggle('hidden', videos.length > 0);
      for (const v of videos) {
        const tr = document.createElement('tr');
        for (const [text, cls] of [[v.title], [fmtSize(v.size), 'num'], [fmtDate(v.createdAt), 'num']]) {
          const td = document.createElement('td');
          td.textContent = text; // textContent: user data is never parsed as HTML
          if (cls) td.className = cls;
          tr.appendChild(td);
        }
        body.appendChild(tr);
      }
    } catch (err) {
      $('#mine-empty').textContent = explain(err);
      $('#mine-empty').classList.remove('hidden');
    }
  }

  function upload(file, title, description) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/videos');
      xhr.setRequestHeader('X-Requested-With', 'fetch');
      xhr.setRequestHeader('Content-Type', file.type);
      xhr.setRequestHeader('X-Video-Title', encodeURIComponent(title));
      xhr.setRequestHeader('X-Video-Description', encodeURIComponent(description));
      const bar = $('#progress');
      bar.classList.remove('hidden');
      bar.value = 0;
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.value = (e.loaded / e.total) * 100; };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch (_) { /* empty */ }
        if (xhr.status === 201) return resolve(data);
        const err = new Error(data.error || `upload failed (${xhr.status})`);
        err.status = xhr.status;
        err.fields = data.fields;
        reject(err);
      };
      xhr.onerror = () => reject(new Error('network error during upload'));
      xhr.send(file);
    });
  }

  $('#upload-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#upload-msg');
    const file = $('#file').files[0];
    const title = $('#title').value.trim();
    const description = $('#description').value.trim();
    if (!file) return show(msg, 'Choose a video file.', 'err');
    if (!TYPES.includes(file.type)) return show(msg, `Unsupported type "${file.type || 'unknown'}".`, 'err');
    if (file.size > MAX_MB * 1048576) return show(msg, `File is larger than ${MAX_MB} MB.`, 'err');
    if (!title) return show(msg, 'Give the video a title.', 'err');

    const btn = $('#upload-btn');
    btn.disabled = true;
    show(msg, 'Uploading…');
    try {
      const r = await upload(file, title, description);
      show(msg, `Uploaded "${r.title}" (${fmtSize(r.size)}).`, 'ok');
      e.target.reset();
      loadMine();
    } catch (err) {
      const text = err.status === 403
        ? 'Your account is a viewer. Ask an admin to give you the uploader role.'
        : explain(err);
      show(msg, text, 'err');
    } finally {
      btn.disabled = false;
      setTimeout(() => $('#progress').classList.add('hidden'), 800);
    }
  });

  $('#admin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#admin-msg');
    const btn = $('#admin-btn');
    btn.disabled = true;
    try {
      const r = await api('/api/admin/users', { method: 'POST', json: {
        username: $('#new-username').value.trim(), password: $('#new-password').value, role: $('#new-role').value } });
      show(msg, `Created ${r.username} (${r.role}).`, 'ok');
      e.target.reset();
    } catch (err) {
      show(msg, explain(err), 'err');
    } finally {
      btn.disabled = false;
    }
  });

  init((user) => {
    if (user.role === 'admin') $('#admin-form').classList.remove('hidden');
    if (user.role === 'viewer') {
      show($('#upload-msg'), 'Signed in as a viewer: uploads will be refused (403). Ask an admin for the uploader role.', 'err');
    }
    loadMine();
  });
})();
