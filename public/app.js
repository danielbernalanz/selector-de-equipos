(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const LS = {
    role: 'selEqRole',
    code: 'selEqCode',
    token: 'selEqToken',
    studentId: 'selEqStudentId',
    name: 'selEqName',
  };

  let session = null;
  let reconnectAttempts = 0;
  let roomData = null;
  let currentSocket = null;
  const pending = [];
  let pendingInit = null;

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

  function makeId() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function wsUrl() {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  }

  function send(msg) {
    if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
      currentSocket.send(JSON.stringify(msg));
    } else {
      pending.push(msg);
    }
  }

  function initMessage() {
    if (!session) return null;
    if (session.role === 'teacher') {
      return { type: 'teacherReconnect', code: session.code, token: session.token };
    }
    return { type: 'join', code: session.code, name: session.name, studentId: session.studentId };
  }

  function flushQueue() {
    if (!currentSocket || currentSocket.readyState !== WebSocket.OPEN) return;
    if (pendingInit) {
      currentSocket.send(pendingInit);
      pendingInit = null;
    } else if (session) {
      const msg = initMessage();
      if (msg) currentSocket.send(JSON.stringify(msg));
    }
    while (pending.length) {
      currentSocket.send(JSON.stringify(pending.shift()));
    }
  }

  function connect() {
    const socket = new WebSocket(wsUrl());
    currentSocket = socket;
    socket.onopen = () => {
      reconnectAttempts = 0;
      setBadge('on');
      flushQueue();
    };
    socket.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handle(msg);
    };
    socket.onclose = () => {
      if (currentSocket !== socket) return;
      currentSocket = null;
      if (session) {
        setBadge('warn');
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 6000);
        reconnectAttempts++;
        setTimeout(connect, delay);
      } else {
        setBadge('off');
      }
    };
    socket.onerror = () => socket.close();
  }

  function ensureConnected() {
    if (!currentSocket ||
        currentSocket.readyState === WebSocket.CLOSED ||
        currentSocket.readyState === WebSocket.CLOSING) {
      connect();
    }
  }

  function setBadge(state) {
    const b = $('#connBadge');
    b.className = 'badge badge-' + state;
    b.textContent = state === 'on' ? 'En línea'
      : state === 'warn' ? 'Reconectando…'
      : state === 'off' && session ? 'Reconectando…' : 'Sin conexión';
  }

  function handle(msg) {
    switch (msg.type) {
      case 'ready':
        if (msg.role === 'teacher') {
          session = { role: 'teacher', code: msg.code, token: msg.token };
        } else {
          session = {
            role: 'student',
            code: session ? session.code : (localStorage.getItem(LS.code) || ''),
            name: session && session.name ? session.name : (localStorage.getItem(LS.name) || ''),
            studentId: msg.studentId,
          };
        }
        saveSession();
        roomData = msg.room;
        goTo(msg.role === 'teacher' ? 'teacher' : 'student');
        if (msg.role === 'teacher') renderTeacher();
        else renderStudent();
        break;

      case 'room':
        roomData = msg.room;
        if (currentView() === 'teacher') renderTeacher();
        else if (currentView() === 'student') renderStudent();
        break;

      case 'error':
        if (currentView() === 'join') {
          $('#joinError').textContent = msg.message;
          $('#joinError').classList.remove('hidden');
        } else if (currentView() === 'teacher' || currentView() === 'student') {
          goHomeAndReset();
        }
        break;

      case 'closed':
        showClosedModal();
        break;
    }
  }

  function showClosedModal() {
    session = null;
    clearStorage();
    $('#closedModal').classList.remove('hidden');
  }

  function goHomeAndReset() {
    session = null;
    clearStorage();
    $('#closedModal').classList.add('hidden');
    goTo('home');
    if (currentSocket) currentSocket.close();
  }

  window.goHomeAndReset = goHomeAndReset;

  function saveSession() {
    if (!session) return;
    localStorage.setItem(LS.role, session.role);
    localStorage.setItem(LS.code, session.code);
    if (session.token) localStorage.setItem(LS.token, session.token);
    if (session.studentId) localStorage.setItem(LS.studentId, session.studentId);
    if (session.name) localStorage.setItem(LS.name, session.name);
  }

  function clearStorage() {
    Object.values(LS).forEach((k) => localStorage.removeItem(k));
  }

  function currentView() {
    const el = document.querySelector('.view:not(.hidden)');
    return el ? el.id.replace('view-', '') : 'home';
  }

  function goTo(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    $('#view-' + name).classList.remove('hidden');
    if (name === 'join') $('#joinError').classList.add('hidden');
  }

  // ---------- Home ----------
  window.goTo = goTo;

  // ---------- Create ----------
  const createBtn = $('#createForm button[type="submit"]');
  $('#createForm').addEventListener('submit', (e) => {
    e.preventDefault();
    session = null;
    clearStorage();
    pending.length = 0;
    pendingInit = null;
    ensureConnected();
    createBtn.disabled = true;
    createBtn.textContent = 'Creando…';
    send({
      type: 'create',
      teacherName: $('#cTeacherName').value,
      className: $('#cClassName').value,
      numTeams: Number($('#cNumTeams').value),
      defaultCapacity: Number($('#cDefaultCap').value),
    });
    setTimeout(() => {
      createBtn.disabled = false;
      createBtn.textContent = 'Crear sala';
    }, 8000);
  });

  // ---------- Join ----------
  const codeParam = new URLSearchParams(location.search).get('codigo');
  if (codeParam) {
    $('#jCode').value = codeParam;
    goTo('join');
  }

  $('#joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const sid = localStorage.getItem(LS.studentId) || makeId();
    localStorage.setItem(LS.studentId, sid);
    ['role', 'code', 'token', 'name'].forEach((k) => localStorage.removeItem(LS[k]));
    pending.length = 0;
    pendingInit = null;
    session = {
      role: 'student',
      code: $('#jCode').value.trim().toUpperCase(),
      name: $('#jName').value.trim(),
      studentId: sid,
    };
    saveSession();
    ensureConnected();
    if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
      currentSocket.send(JSON.stringify(initMessage()));
    } else {
      pendingInit = JSON.stringify(initMessage());
    }
  });

  // ---------- Teacher view ----------
  function renderTeacher() {
    if (!roomData) return;
    $('#tClassName').textContent = roomData.className || 'Sala sin título';
    $('#tTeacher').textContent = 'Profesor/a: ' + (roomData.teacherName || '—');
    $('#tCode').textContent = roomData.code;

    $('#teacherTeams').innerHTML = roomData.teams.map((t) => {
      const full = t.members.length >= t.capacity;
      return `
        <div class="team ${full ? 'full' : ''}">
          <div class="team-head">
            <span class="team-title">${esc(t.name)}</span>
            <span class="slots ${full ? 'full' : 'free'}">${t.members.length}/${t.capacity}</span>
          </div>
          <div class="teacher-controls">
            <label>Nombre
              <input value="${esc(t.name)}" maxlength="40"
                onchange="teacherSetName(${t.id}, this.value)">
            </label>
            <label>Límite
              <input type="number" min="1" max="20" value="${t.capacity}"
                oninput="teacherSetCap(${t.id}, this.value)">
            </label>
          </div>
          <div class="members">
            ${t.members.length
              ? t.members.map((m) => `
                  <div class="member">
                    <span>${esc(m.name)}</span>
                    <button class="x" title="Quitar" onclick="teacherRemove('${esc(m.id)}')">✕</button>
                  </div>`).join('')
              : '<span class="empty">Sin integrantes</span>'}
          </div>
        </div>`;
    }).join('');
  }

  window.teacherSetName = (teamId, value) => {
    if (!value.trim()) return;
    send({ type: 'setTeam', teamId, name: value });
  };

  window.teacherSetCap = (teamId, value) => {
    const cap = parseInt(value, 10);
    if (Number.isNaN(cap) || cap < 1) return;
    send({ type: 'setTeam', teamId, capacity: cap });
  };

  window.teacherRemove = (studentId) => {
    send({ type: 'removeMember', studentId });
  };

  window.closeRoom = () => {
    if (confirm('¿Cerrar la sala para todos? Se perderá la configuración.')) {
      send({ type: 'close' });
    }
  };

  window.copyLink = () => {
    const url = location.origin + location.pathname + '?codigo=' + roomData.code;
    navigator.clipboard.writeText(url).then(() => {
      showToast('Enlace copiado: ' + url);
    });
  };

  // ---------- Student view ----------
  function myTeam() {
    if (!roomData || !session || session.role !== 'student') return null;
    return roomData.teams.find((t) => t.members.some((m) => m.id === session.studentId)) || null;
  }

  function renderStudent() {
    if (!roomData || !session) return;
    $('#sClassName').textContent = roomData.className || 'Sala sin título';
    $('#sTeacher').textContent = 'Profesor/a: ' + (roomData.teacherName || '—');
    const mine = myTeam();
    $('#sStatus').textContent = mine
      ? 'Estás en el ' + mine.name + ' (' + mine.members.length + '/' + mine.capacity + ').'
      : 'Elige un equipo con hueco libre.';

    $('#studentTeams').innerHTML = roomData.teams.map((t) => {
      const full = t.members.length >= t.capacity;
      const iAmHere = mine && mine.id === t.id;
      return `
        <div class="team ${full ? 'full' : ''} ${iAmHere ? 'mine' : ''}">
          <div class="team-head">
            <span class="team-title">${esc(t.name)}</span>
            <span class="slots ${full ? 'full' : 'free'}">${t.members.length}/${t.capacity}</span>
          </div>
          <div class="members">
            ${t.members.length
              ? t.members.map((m) => `
                  <div class="member">
                    <span>${esc(m.name)}
                      ${m.id === session.studentId ? ' <span class="you">(tú)</span>' : ''}
                    </span>
                  </div>`).join('')
              : '<span class="empty">Sin integrantes</span>'}
          </div>
          <div class="team-actions">
            ${iAmHere
              ? '<button class="btn btn-outline" onclick="studentLeave()">Salir del equipo</button>'
              : `<button class="btn btn-primary" ${full ? 'disabled' : ''}
                    onclick="studentJoin(${t.id})">${full ? 'Lleno' : 'Unirme'}</button>`}
          </div>
        </div>`;
    }).join('');
  }

  window.studentJoin = (teamId) => {
    send({ type: 'joinTeam', teamId, studentId: session.studentId, name: session.name });
  };

  window.studentLeave = () => {
    send({ type: 'leaveTeam', studentId: session.studentId });
  };

  window.leaveRoom = () => {
    if (!session) return;
    if (session.role === 'student') {
      send({ type: 'leaveTeam', studentId: session.studentId });
    }
    session = null;
    clearStorage();
    roomData = null;
    goTo('home');
    if (currentSocket) currentSocket.close();
  };

  // ---------- Toast ----------
  function showToast(text) {
    let t = $('#toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), 2500);
  }

  // ---------- Restore session on reload ----------
  const storedRole = localStorage.getItem(LS.role);
  if (codeParam) {
    ['role', 'code', 'token', 'name'].forEach((k) => localStorage.removeItem(LS[k]));
  } else if (storedRole) {
    session = {
      role: storedRole,
      code: localStorage.getItem(LS.code) || '',
      token: localStorage.getItem(LS.token) || undefined,
      studentId: localStorage.getItem(LS.studentId) || undefined,
      name: localStorage.getItem(LS.name) || '',
    };
    if (session.role === 'teacher' && !session.token) {
      session = null;
      clearStorage();
    } else {
      goTo(storedRole === 'teacher' ? 'teacher' : 'student');
    }
  }

  connect();
})();