(function () {
  'use strict';
  const { api, init, show, explain } = window.VSS;
  const $ = (s) => document.querySelector(s);
  const PAGE = 12;
  let offset = 0;
  let total = 0;
  let current = null;

  const toUpload = $('#to-upload');
  toUpload.href = `${location.protocol}//${location.hostname}:${toUpload.dataset.port}/`;

  const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.ceil(n / 1024) + ' KB');

  function play(v) {
    current = v.id;
    const player = $('#player');
    // The browser sends the HttpOnly session cookie with these Range requests.
    player.src = `/api/videos/${encodeURIComponent(v.id)}/stream`;
    $('#np-title').textContent = v.title;
    $('#np-meta').textContent = `${fmtSize(v.size)} · ${v.contentType} · uploaded by ${v.uploadedBy} · ${new Date(v.createdAt).toLocaleString()}`;
    $('#np-desc').textContent = v.description || '';
    $('#player-section').classList.remove('hidden');
    document.querySelectorAll('.tile').forEach((t) => t.classList.toggle('active', t.dataset.id === v.id));
    player.play().catch(() => { /* autoplay may be blocked; controls remain */ });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  $('#player').addEventListener('error', () => {
    show($('#lib-msg'), 'Playback failed. The file service may be unavailable; try again shortly.', 'err');
  });

  async function load() {
    const tiles = $('#tiles');
    const msg = $('#lib-msg');
    show(msg, '');
    try {
      const data = await api(`/api/videos?limit=${PAGE}&offset=${offset}`);
      total = data.total;
      tiles.textContent = '';
      if (!data.videos.length) {
        tiles.innerHTML = '<div class="empty">No videos yet. Upload one from the Upload app.</div>';
      }
      for (const v of data.videos) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tile' + (v.id === current ? ' active' : '');
        b.dataset.id = v.id;
        const poster = document.createElement('div');
        poster.className = 'poster';
        poster.textContent = '▶';
        const t = document.createElement('span');
        t.className = 't';
        t.textContent = v.title;
        const m = document.createElement('span');
        m.className = 'meta';
        m.textContent = `${fmtSize(v.size)} · ${v.uploadedBy}`;
        b.append(poster, t, m);
        b.addEventListener('click', () => play(v));
        tiles.appendChild(b);
      }
      const end = Math.min(offset + PAGE, total);
      $('#page-info').textContent = total ? `${offset + 1}–${end} of ${total}` : '';
      $('#prev').disabled = offset === 0;
      $('#next').disabled = end >= total;
      $('#lib-sub').textContent = `${total} video${total === 1 ? '' : 's'} available. Pick one to start streaming.`;
    } catch (err) {
      show(msg, explain(err), 'err');
    }
  }

  $('#prev').addEventListener('click', () => { offset = Math.max(0, offset - PAGE); load(); });
  $('#next').addEventListener('click', () => { offset += PAGE; load(); });

  init(() => load());
})();
