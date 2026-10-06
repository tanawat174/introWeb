/* ============================================================
   KM – ระบบกลางของเว็บรับสมัคร (จำลองเพื่อการศึกษา)
   เก็บข้อมูลในเบราว์เซอร์ (localStorage / sessionStorage / IndexedDB)
   ไม่มีเซิร์ฟเวอร์จริง → ห้ามใช้เก็บข้อมูลหรือเงินจริง
   ============================================================ */
var KM = (function () {
  /* ---------- ตั้งค่า (แก้ได้ตรงนี้) ---------- */
  var CFG = {
    FEE: 300,                       // ค่าสมัคร (บาท) – ปรับให้ตรงประกาศจริง
    BILLER_ID: '010000000000000',   // Biller ID 15 หลัก – ใส่ของมหาวิทยาลัยจริง
    PAY_DAYS: 3,                    // กำหนดชำระภายใน (วัน) นับจากวันยื่นใบสมัคร
    CHECK_ID_SUM: true,             // ตรวจเลขตรวจสอบ (หลักที่ 13) ของเลขบัตร ปชช.
    MAX_FILE_MB: 5,
    RESULTS: {}                     // ผลประกาศ: {'เลขบัตร': {status:'pass'|'fail', note:'...'}}
  };
  var DOCS = [
    ['doc_id', 'สำเนาบัตรประจำตัวประชาชน'],
    ['doc_house', 'สำเนาทะเบียนบ้าน'],
    ['doc_edu', 'หลักฐานการศึกษา หน้า-หลัง'],
    ['doc_photo', 'รูปถ่ายชุดนักเรียน/นักศึกษา 1-2 นิ้ว'],
    ['doc_talent', 'หลักฐานแสดงความสามารถเฉพาะด้าน (ถ้ามี)']
  ];
  var PAGE = location.pathname.split('/').pop() || 'index.html';
  var AUTH_PAGES = ['admission1.html', 'admission2.html', 'status.html', 'payment.html'];

  /* ---------- storage ---------- */
  function jget(s, k, d) { try { var v = s.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function jset(s, k, v) { s.setItem(k, JSON.stringify(v)); }
  function users() { return jget(localStorage, 'km_users', {}); }
  function apps() { return jget(localStorage, 'km_apps', {}); }
  function saveApps(a) { jset(localStorage, 'km_apps', a); }
  function session() { return jget(sessionStorage, 'km_session', null) || jget(localStorage, 'km_session', null); }
  function me() { var s = session(); return s ? users()[s.id] && { id: s.id, u: users()[s.id] } : null; }
  function myApp() { var s = session(); return s ? apps()[s.id] || null : null; }
  function draftKey() { return 'km_draft_' + (session() || {}).id; }

  /* ---------- helpers ---------- */
  function sha(text) {
    var salt = 'kmutnb-sim:';
    if (window.crypto && crypto.subtle && window.TextEncoder) {
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + text)).then(function (b) {
        return [].map.call(new Uint8Array(b), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      });
    }
    var h = 5381; for (var i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return Promise.resolve('f' + h);
  }
  function thaiIdOk(id) {
    if (!/^\d{13}$/.test(id)) return false;
    if (!CFG.CHECK_ID_SUM) return true;
    var s = 0; for (var i = 0; i < 12; i++) s += +id[i] * (13 - i);
    return (11 - (s % 11)) % 10 === +id[12];
  }
  function fmtDate(t, withTime) {
    var o = { day: 'numeric', month: 'short', year: 'numeric' };
    if (withTime) { o.hour = '2-digit'; o.minute = '2-digit'; }
    return new Date(t).toLocaleString('th-TH', o) + (withTime ? ' น.' : '');
  }
  function baht(n) { return Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2 }) + ' บาท'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fullName(u) { return u.fname + ' ' + u.lname; }
  function msg(form, text, ok) {
    var m = form.querySelector('.form-msg');
    if (!m) { m = document.createElement('p'); m.className = 'form-msg'; m.setAttribute('role', 'alert'); form.insertBefore(m, form.querySelector('button[type=submit], .sumit, .btn-submit')); }
    m.style.color = ok ? '#0f7a55' : ''; m.textContent = text || '';
  }
  function go(url) { location.href = url; }

  /* ---------- IndexedDB (เก็บไฟล์เอกสาร) ---------- */
  function idb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open('km_files', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('f'); };
      r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); };
    });
  }
  function idbPut(k, blob) { return idb().then(function (d) { return new Promise(function (res, rej) { var t = d.transaction('f', 'readwrite'); t.objectStore('f').put(blob, k); t.oncomplete = res; t.onerror = function () { rej(t.error); }; }); }); }
  function idbGet(k) { return idb().then(function (d) { return new Promise(function (res, rej) { var q = d.transaction('f').objectStore('f').get(k); q.onsuccess = function () { res(q.result); }; q.onerror = function () { rej(q.error); }; }); }); }

  /* ---------- เมนูบนหัวเว็บ + ตรวจสิทธิ์ ---------- */
  function nav() {
    var s = me(), btn = document.querySelector('.ui .btn-login');
    if (!s || !btn) return;
    var hello = document.createElement('span'); hello.className = 'hello'; hello.textContent = 'สวัสดี, ' + s.u.fname;
    btn.parentNode.insertBefore(hello, btn);
    btn.textContent = 'ออกจากระบบ'; btn.href = '#';
    btn.onclick = function (e) { e.preventDefault(); KM.logout(); };
  }
  function guard() {
    if (AUTH_PAGES.indexOf(PAGE) > -1 && !me()) { go('login.html?next=' + encodeURIComponent(PAGE)); return false; }
    var a = myApp();
    if ((PAGE === 'admission1.html' || PAGE === 'admission2.html') && a) { go('status.html'); return false; }
    if (PAGE === 'admission2.html' && !jget(localStorage, draftKey(), null)) { go('admission1.html'); return false; }
    if (PAGE === 'payment.html' && !a) { go('status.html'); return false; }
    return true;
  }

  /* ---------- QR Bill Payment (Thai QR / EMV) ---------- */
  function tlv(t, v) { return t + ('0' + v.length).slice(-2) + v; }
  function crc16(s) {
    var c = 0xFFFF;
    for (var i = 0; i < s.length; i++) { c ^= s.charCodeAt(i) << 8; for (var b = 0; b < 8; b++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF; }
    return ('000' + c.toString(16).toUpperCase()).slice(-4);
  }
  function qrPayload(app) {
    var p = tlv('00', '01') + tlv('01', '12') +
      tlv('30', tlv('00', 'A000000677010112') + tlv('01', CFG.BILLER_ID) + tlv('02', app.id) + tlv('03', app.no)) +
      tlv('53', '764') + tlv('54', CFG.FEE.toFixed(2)) + tlv('58', 'TH') + '6304';
    return p + crc16(p);
  }
  function qrSvg(text) {
    if (!window.qrcode) return '';
    var q = qrcode(0, 'M'); q.addData(text); q.make();
    return q.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
  }

  /* ---------- API สาธารณะ ---------- */
  var KM = {
    CFG: CFG, DOCS: DOCS, fmtDate: fmtDate, baht: baht, esc: esc, fullName: fullName,
    user: function () { var s = me(); return s && Object.assign({ id: s.id }, s.u); },
    app: myApp,

    logout: function () { sessionStorage.removeItem('km_session'); localStorage.removeItem('km_session'); go('index.html'); },

    /* ผู้สมัครจ่ายเงิน: หมดเขต = วันยื่น + PAY_DAYS */
    deadline: function (a) { return a.submittedAt + CFG.PAY_DAYS * 86400000; },

    /* ยื่นใบสมัคร (เรียกจาก admission2.html) */
    submit: function () {
      var s = session(); if (!s) return Promise.reject(new Error('no session'));
      var draft = jget(localStorage, draftKey(), null); if (!draft) return Promise.reject(new Error('no draft'));
      var all = apps(); if (all[s.id]) return Promise.resolve(all[s.id]);
      var docs = {}, puts = [];
      [].forEach.call(document.querySelectorAll('#docForm input[type=file]'), function (inp) {
        var f = inp.files[0];
        if (f) { docs[inp.name] = { name: f.name, size: f.size, type: f.type }; puts.push(idbPut(s.id + ':' + inp.name, f)); }
      });
      return Promise.all(puts).then(function () {
        var seq = (jget(localStorage, 'km_seq', 0) || 0) + 1; jset(localStorage, 'km_seq', seq);
        var app = {
          id: s.id, no: '70' + ('000000' + seq).slice(-6), submittedAt: Date.now(),
          form: draft, docs: docs, pay: { status: 'unpaid', amount: CFG.FEE }
        };
        all = apps(); all[s.id] = app; saveApps(all);
        localStorage.removeItem(draftKey());
        return app;
      });
    },

    /* ชำระเงิน (จำลอง) */
    pay: function (bank) {
      var all = apps(), s = session(), a = s && all[s.id];
      if (!a) return null;
      if (a.pay.status === 'paid') return a;
      a.pay = { status: 'paid', amount: CFG.FEE, bank: bank, paidAt: Date.now(),
                ref: 'PAY' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + ('00000' + Math.floor(Math.random() * 99999)).slice(-5) };
      saveApps(all); return a;
    },

    openDoc: function (key) {
      var s = session(); if (!s) return;
      var w = window.open('', '_blank');
      idbGet(s.id + ':' + key).then(function (b) {
        if (!b) { if (w) w.close(); alert('ไม่พบไฟล์เอกสาร'); return; }
        var url = URL.createObjectURL(b); if (w) w.location = url; else window.open(url);
      }).catch(function () { if (w) w.close(); alert('เปิดไฟล์ไม่สำเร็จ'); });
    },

    restoreDraft: function () {
      var d = jget(localStorage, draftKey(), null); if (!d) return;
      ['level', 'school', 'province', 'major', 'gpax', 'campus', 'faculty', 'program', 'qualification', 'project'].forEach(function (n) {
        var el = document.getElementById(n); if (!el || d[n] == null) return;
        el.value = d[n];
        if (n === 'campus' || n === 'faculty') el.dispatchEvent(new Event('change'));
      });
    },

    qr: function (app) { return { payload: qrPayload(app), svg: qrSvg(qrPayload(app)) }; },

    lookupResult: function (id) {
      var u = users()[id], a = apps()[id], r = CFG.RESULTS[id];
      if (!u && !a) return { type: 'no', html: 'ไม่พบข้อมูลผู้สมัครที่ใช้เลขประจำตัวประชาชนนี้ กรุณาตรวจสอบเลขอีกครั้ง' };
      if (!a) return { type: 'no', html: 'พบการลงทะเบียน แต่ยังไม่ได้ยื่นใบสมัคร <a href="admission1.html">ไปกรอกใบสมัคร</a>' };
      var head = '<b>' + esc(fullName(u)) + '</b><br>เลขที่ใบสมัคร ' + esc(a.no) + '<br>' + esc(a.form.faculty) + ' สาขา' + esc(a.form.program) + '<br>';
      if (r) return { type: r.status === 'pass' ? 'ok' : 'no', html: head + (r.status === 'pass' ? '<b>ผ่านการคัดเลือก</b>' : '<b>ไม่ผ่านการคัดเลือก</b>') + (r.note ? '<br>' + esc(r.note) : '') };
      if (a.pay.status !== 'paid') return { type: 'no', html: head + 'ยังไม่ได้ชำระค่าสมัคร จึงยังไม่เข้าสู่การพิจารณา <a href="payment.html">ชำระเงิน</a>' };
      return { type: 'ok', html: head + 'ชำระค่าสมัครแล้ว · อยู่ระหว่างการพิจารณา ยังไม่ถึงกำหนดประกาศผล กรุณาตรวจสอบกำหนดการที่หน้า <a href="schedule.html">กำหนดการรับสมัคร</a>' };
    }
  };

  /* ---------- ผูกฟอร์มแต่ละหน้า ---------- */
  function on(id, ev, fn) { var el = document.getElementById(id); if (el) el.addEventListener(ev, fn); }

  document.addEventListener('DOMContentLoaded', function () {
    nav();
    if (!guard()) return;

    /* terms */
    var agree = document.getElementById('agree'), acc = document.getElementById('accept');
    if (agree && acc) {
      agree.addEventListener('change', function () { acc.disabled = !agree.checked; });
      acc.addEventListener('click', function () { go(me() ? 'admission1.html' : 'register.html'); });
    }

    /* register */
    on('regForm', 'submit', function (e) {
      e.preventDefault();
      var f = e.target, v = function (n) { return f.elements[n].value.trim(); };
      var id = v('idcard');
      if (!thaiIdOk(id)) return msg(f, 'เลขบัตรประชาชนไม่ถูกต้อง (ต้องเป็นตัวเลข 13 หลักและผ่านการตรวจสอบเลขท้าย)');
      if (f.elements.password.value.length < 8) return msg(f, 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร');
      if (f.elements.password.value !== f.elements.confirm.value) return msg(f, 'รหัสผ่านและการยืนยันรหัสผ่านไม่ตรงกัน');
      if (!/^0\d{8,9}$/.test(v('tel').replace(/[-\s]/g, ''))) return msg(f, 'เบอร์โทรศัพท์ไม่ถูกต้อง');
      var all = users(); if (all[id]) return msg(f, 'เลขบัตรประชาชนนี้ลงทะเบียนแล้ว กรุณาเข้าสู่ระบบ');
      sha(f.elements.password.value).then(function (h) {
        all[id] = { pw: h, fname: v('fname'), lname: v('lname'), email: v('email'), tel: v('tel').replace(/[-\s]/g, '') };
        jset(localStorage, 'km_users', all);
        alert('ลงทะเบียนสำเร็จ กรุณาเข้าสู่ระบบ'); go('login.html');
      });
    });

    /* login */
    on('loginForm', 'submit', function (e) {
      e.preventDefault();
      var f = e.target, id = f.elements.idcard.value.trim(), u = users()[id];
      sha(f.elements.password.value).then(function (h) {
        if (!u || u.pw !== h) return msg(f, 'เลขบัตรประชาชนหรือรหัสผ่านไม่ถูกต้อง');
        var store = f.elements.remember.checked ? localStorage : sessionStorage;
        jset(store, 'km_session', { id: id });
        var next = new URLSearchParams(location.search).get('next');
        go(apps()[id] ? 'status.html' : (/^[a-z0-9]+\.html$/.test(next || '') ? next : 'admission1.html'));
      });
    });

    /* admission1: เก็บฉบับร่างแล้วไปขั้นถัดไป */
    on('admissionForm', 'submit', function (e) {
      e.preventDefault();
      var d = {}; [].forEach.call(e.target.elements, function (el) { if (el.name) d[el.name] = el.value; });
      if (+d.gpax < 0 || +d.gpax > 4) return alert('GPAX ต้องอยู่ระหว่าง 0.00 - 4.00');
      jset(localStorage, draftKey(), d); go('admission2.html');
    });

    /* result */
    var rf = document.getElementById('resForm');
    if (rf) {
      var u = me(); if (u) document.getElementById('rid').value = u.id;
      rf.addEventListener('submit', function (e) {
        e.preventDefault();
        var r = KM.lookupResult(document.getElementById('rid').value.trim());
        document.getElementById('resOut').innerHTML = '<div class="res ' + r.type + '">' + r.html + '</div>';
      });
    }
  });

  return KM;
})();
