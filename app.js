'use strict';

// stt: 音声認識・読み上げ用 / tr: 翻訳用
const LANGS = [
  { stt: 'ja-JP', tr: 'ja', name: '日本語' },
  { stt: 'en-US', tr: 'en', name: 'English' },
  { stt: 'zh-CN', tr: 'zh-CN', name: '中文（简体）' },
  { stt: 'zh-TW', tr: 'zh-TW', name: '中文（繁體）' },
  { stt: 'ko-KR', tr: 'ko', name: '한국어' },
  { stt: 'es-ES', tr: 'es', name: 'Español' },
  { stt: 'fr-FR', tr: 'fr', name: 'Français' },
  { stt: 'de-DE', tr: 'de', name: 'Deutsch' },
  { stt: 'it-IT', tr: 'it', name: 'Italiano' },
  { stt: 'pt-BR', tr: 'pt', name: 'Português' },
  { stt: 'ru-RU', tr: 'ru', name: 'Русский' },
  { stt: 'th-TH', tr: 'th', name: 'ไทย' },
  { stt: 'vi-VN', tr: 'vi', name: 'Tiếng Việt' },
  { stt: 'id-ID', tr: 'id', name: 'Bahasa Indonesia' },
  { stt: 'fil-PH', tr: 'tl', name: 'Filipino' },
  { stt: 'hi-IN', tr: 'hi', name: 'हिन्दी' },
  { stt: 'ar-SA', tr: 'ar', name: 'العربية' },
];
const PEER_PREFIX = 'xortalk-';
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem('xt_' + k); return v == null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('xt_' + k, v); } catch (e) {} },
};
const langOf = code => LANGS.find(l => l.stt === code) || LANGS[1];

// role: host（日本側・翻訳担当） / guest（相手側） / solo（1台）
const S = { role: null, me: null, peer: null, peerObj: null, conn: null, rec: null, recBtn: null, seq: 0 };

function show(id) {
  document.querySelectorAll('section').forEach(s => { s.hidden = s.id !== id; });
}
function fillSelect(sel, value) {
  sel.innerHTML = '';
  LANGS.forEach(l => { const o = document.createElement('option'); o.value = l.stt; o.textContent = l.name; sel.appendChild(o); });
  sel.value = value;
}

// ---------- 翻訳（日本側だけが呼ぶ） ----------
function decodeEntities(s) { const t = document.createElement('textarea'); t.innerHTML = s; return t.value; }

async function translate(text, from, to) {
  if (from.tr === to.tr) return text;
  const url = store.get('gasUrl', ''), token = store.get('gasToken', '');
  if (!url || !token) throw new Error('翻訳 URL とトークンが未設定です');
  // text/plain にすると CORS の事前確認が出ず、Apps Script がそのまま受けられる
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ k: token, sl: from.tr, tl: to.tr, q: text }),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error === 'bad_token' ? 'トークンが違います' : '翻訳エラー: ' + j.error);
  return decodeEntities(j.text);
}

// ---------- 読み上げ ----------
let voices = [];
function loadVoices() { voices = speechSynthesis.getVoices(); }
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }

function unlockAudio() {
  // iOS は最初のタップの中で一度鳴らさないと、あとから読み上げできない
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  speechSynthesis.speak(u);
}
function speak(text, lang) {
  if (!('speechSynthesis' in window) || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang.stt;
  const base = lang.stt.split('-')[0];
  u.voice = voices.find(v => v.lang.replace('_', '-') === lang.stt) || voices.find(v => v.lang.startsWith(base)) || null;
  speechSynthesis.speak(u);
}

let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.role) keepAwake(); });

// ---------- 会話ログ ----------
function addMsg({ mine, main, sub, meta, sayLang, sayText }) {
  $('#empty').hidden = true;
  const el = document.createElement('div');
  el.className = 'msg' + (mine ? ' me' : '');
  const m = document.createElement('div'); m.className = 'main'; m.dir = 'auto'; m.textContent = main;
  const s = document.createElement('div'); s.className = 'sub'; s.dir = 'auto'; s.textContent = sub || '';
  const t = document.createElement('div'); t.className = 'meta'; t.textContent = meta || '';
  el.append(m, s, t);
  if (sayLang) el.addEventListener('click', () => speak(sayText, sayLang));
  $('#log').appendChild(el);
  el.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return { el, main: m, sub: s, meta: t };
}

function setLive(t) { $('#live').textContent = t || ''; }
function setOnline(on) { $('#dot').classList.toggle('on', !!on); }

// ---------- 音声認識 ----------
function stopListening() { if (S.rec) { try { S.rec.stop(); } catch (e) {} } }

function listen(lang, btn) {
  return new Promise((resolve, reject) => {
    const r = new Recognition();
    r.lang = lang.stt;
    r.interimResults = true;
    r.continuous = false;
    let text = '';
    r.onresult = e => {
      text = Array.from(e.results).map(x => x[0].transcript).join('');
      setLive(text);
    };
    r.onerror = e => { if (e.error !== 'no-speech' && e.error !== 'aborted') reject(new Error(e.error)); };
    r.onend = () => { S.rec = null; btn.classList.remove('rec'); resolve(text.trim()); };
    S.rec = r; S.recBtn = btn;
    btn.classList.add('rec');
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    r.start();
  });
}

async function onMic(btn, lang, side) {
  if (S.rec) { stopListening(); return; }
  if (!Recognition) { setLive(S.role === 'guest' ? 'Voice input is not supported here. Please type.' : 'このブラウザは音声入力に未対応です。文字で入力してください'); $('#type-in').focus(); return; }
  setLive(S.role === 'guest' ? 'Listening…' : '聞いています…');
  let text = '';
  try { text = await listen(lang, btn); }
  catch (e) {
    setLive(e.message === 'not-allowed'
      ? (S.role === 'guest' ? 'Microphone is blocked. Allow it in the browser settings.' : 'マイクが許可されていません。ブラウザの設定で許可してください')
      : 'Error: ' + e.message);
    return;
  }
  setLive('');
  if (text) send(text, side);
}

// side: 'me'（自分） / 'them'（1台モードの相手）
async function send(text, side) {
  if (S.role === 'guest') {
    if (!S.conn || !S.conn.open) { setLive('Not connected.'); return; }
    const id = ++S.seq;
    const v = addMsg({ mine: true, main: text, meta: 'Sending…' });
    pending.set(id, v);
    S.conn.send({ t: 'say', id, text });
    return;
  }
  const from = side === 'them' ? S.peer : S.me;
  const to = side === 'them' ? S.me : S.peer;
  const v = addMsg({ mine: side !== 'them', main: text, meta: '翻訳中…' });
  try {
    const tr = await translate(text, from, to);
    v.sub.textContent = tr;
    v.meta.textContent = '';
    v.el.addEventListener('click', () => speak(tr, to));
    if (S.role === 'solo') { speak(tr, to); return; }
    if (S.conn && S.conn.open) S.conn.send({ t: 'msg', orig: text, trans: tr });
    else v.meta.textContent = '相手とつながっていません';
  } catch (e) {
    v.meta.textContent = e.message;
  }
}

// 相手の発言を受けた（日本側）
async function onGuestSay(d) {
  const v = addMsg({ mine: false, main: '…', sub: d.text, meta: '翻訳中…' });
  try {
    const tr = await translate(String(d.text).slice(0, 2000), S.peer, S.me);
    v.main.textContent = tr;
    v.meta.textContent = '';
    v.el.addEventListener('click', () => speak(tr, S.me));
    speak(tr, S.me);
    S.conn.send({ t: 'ack', id: d.id });
  } catch (e) {
    v.main.textContent = d.text;
    v.meta.textContent = e.message;
    S.conn.send({ t: 'fail', id: d.id });
  }
}
const pending = new Map();

// ---------- 会話画面 ----------
function enterTalk() {
  show('s-talk');
  const g = S.role === 'guest';
  $('#pair').textContent = S.me.name + ' ⇄ ' + (S.peer ? S.peer.name : '…');
  $('#b-end').textContent = g ? 'Leave' : '終了';
  $('#type-send').textContent = g ? 'Send' : '送信';
  $('#type-in').placeholder = g ? 'Or type here' : '文字でも送れます';
  $('#empty').textContent = g
    ? 'Tap the button and speak. Tap a message to hear it again.'
    : 'ボタンを押して話してください。吹き出しをタップすると、もう一度読み上げます。';
  const mics = $('#mics');
  mics.innerHTML = '';
  const mk = (label, lang, side, alt) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mic' + (alt ? ' alt' : '');
    b.textContent = label;
    b.addEventListener('click', () => onMic(b, lang, side));
    mics.appendChild(b);
  };
  if (S.role === 'solo') {
    mk('🎤 ' + S.me.name, S.me, 'me');
    mk('🎤 ' + S.peer.name, S.peer, 'them', true);
  } else {
    mk(g ? '🎤 Speak' : '🎤 話す', S.me, 'me');
  }
  setOnline(S.role === 'solo' || (S.conn && S.conn.open));
  keepAwake();
}

$('#typer').addEventListener('submit', e => {
  e.preventDefault();
  const t = $('#type-in').value.trim();
  if (!t) return;
  $('#type-in').value = '';
  send(t, 'me');
});

$('#b-end').addEventListener('click', () => {
  stopListening();
  if (S.conn) try { S.conn.close(); } catch (e) {}
  if (S.peerObj) try { S.peerObj.destroy(); } catch (e) {}
  S.conn = null; S.peerObj = null;
  if (wakeLock) wakeLock.release().catch(() => {});
  const role = S.role;
  S.role = null;
  $('#log').innerHTML = '<div class="empty" id="empty"></div>';
  if (role === 'guest') { show('s-join'); } else { show('s-home'); }
});

// ---------- 接続 ----------
const ROOM_RE = /^[a-z0-9]{20}$/;
function randomCode() {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  const r = crypto.getRandomValues(new Uint32Array(20));
  let s = '';
  for (let i = 0; i < 20; i++) s += a[r[i] % a.length];
  return s;
}
function joinUrl(code) { return location.origin + location.pathname + '?r=' + code; }

function startHost() {
  if (!store.get('gasUrl', '') || !store.get('gasToken', '')) { $('#home-err').textContent = '先に設定で翻訳 URL とトークンを入れてください'; return; }
  unlockAudio();
  S.role = 'host';
  S.me = langOf(store.get('myLang', 'ja-JP'));
  S.peer = null;
  let code = randomCode();
  show('s-wait');
  $('#wait-msg').textContent = '準備中…';
  $('#qr').innerHTML = ''; $('#room-link').textContent = '';

  const open = () => {
    const peer = new Peer(PEER_PREFIX + code);
    S.peerObj = peer;
    peer.on('open', () => {
      const url = joinUrl(code);
      $('#qr').innerHTML = '';
      new QRCode($('#qr'), { text: url, width: 260, height: 260, correctLevel: QRCode.CorrectLevel.M });
      $('#room-link').textContent = url;
      $('#wait-msg').textContent = '相手の接続を待っています…';
    });
    peer.on('connection', c => {
      if (S.conn && S.conn.open) { c.on('open', () => { try { c.send({ t: 'busy' }); } catch (e) {} setTimeout(() => c.close(), 300); }); return; }
      bindConn(c);
    });
    peer.on('disconnected', () => { if (S.role === 'host' && !peer.destroyed) peer.reconnect(); });
    peer.on('error', e => {
      if (e.type === 'unavailable-id') { peer.destroy(); code = randomCode(); open(); return; }
      $('#wait-msg').textContent = '接続エラー: ' + e.type;
    });
  };
  open();
}

function startGuest(code) {
  unlockAudio();
  S.role = 'guest';
  S.me = langOf($('#guest-lang').value);
  store.set('guestLang', S.me.stt);
  $('#join-msg').textContent = 'Connecting…';
  $('#b-join').disabled = true;
  const peer = new Peer();
  S.peerObj = peer;
  const timer = setTimeout(() => {
    if (!S.conn || !S.conn.open) { $('#join-msg').textContent = 'Could not connect. Ask the other person to show the QR code again.'; $('#b-join').disabled = false; }
  }, 15000);
  peer.on('open', () => {
    const c = peer.connect(PEER_PREFIX + code, { reliable: true });
    bindConn(c);
    c.on('open', () => { clearTimeout(timer); c.send({ t: 'hello', lang: S.me.stt }); });
  });
  peer.on('error', e => {
    clearTimeout(timer);
    $('#join-msg').textContent = e.type === 'peer-unavailable' ? 'The other phone is not waiting. Ask them to open the QR screen.' : 'Connection error: ' + e.type;
    $('#b-join').disabled = false;
  });
}

function bindConn(c) {
  S.conn = c;
  c.on('data', d => onData(c, d));
  c.on('close', () => {
    if (S.conn !== c) return;
    setOnline(false);
    setLive(S.role === 'guest' ? 'Disconnected.' : '相手との接続が切れました。相手がQRを読み直すと再接続します');
    if (S.role === 'host') { $('#wait-msg').textContent = '相手の接続を待っています…'; }
  });
}

function onData(c, d) {
  if (!d || typeof d !== 'object') return;
  if (S.role === 'host') {
    if (d.t === 'hello') {
      S.peer = langOf(String(d.lang));
      c.send({ t: 'welcome', lang: S.me.stt });
      if ($('#s-talk').hidden) enterTalk(); else { $('#pair').textContent = S.me.name + ' ⇄ ' + S.peer.name; setOnline(true); setLive(''); }
    } else if (d.t === 'say' && S.peer) {
      onGuestSay(d);
    }
  } else if (S.role === 'guest') {
    if (d.t === 'busy') {
      $('#join-msg').textContent = 'This conversation already has a partner.';
      $('#b-join').disabled = false;
    } else if (d.t === 'welcome') {
      S.peer = langOf(String(d.lang));
      enterTalk();
    } else if (d.t === 'msg') {
      const tr = String(d.trans || '');
      addMsg({ mine: false, main: tr, sub: String(d.orig || ''), sayLang: S.me, sayText: tr });
      speak(tr, S.me);
    } else if (d.t === 'ack' || d.t === 'fail') {
      const v = pending.get(d.id);
      if (v) { v.meta.textContent = d.t === 'ack' ? 'Delivered ✓' : 'Translation failed'; pending.delete(d.id); }
    }
  }
}

// ---------- 画面のボタン ----------
$('#b-host').addEventListener('click', startHost);
$('#b-solo').addEventListener('click', () => {
  if (!store.get('gasUrl', '') || !store.get('gasToken', '')) { $('#home-err').textContent = '先に設定で翻訳 URL とトークンを入れてください'; return; }
  unlockAudio();
  S.role = 'solo';
  S.me = langOf(store.get('myLang', 'ja-JP'));
  S.peer = langOf($('#solo-lang').value);
  store.set('soloLang', S.peer.stt);
  enterTalk();
});
$('#b-wait-back').addEventListener('click', () => {
  if (S.peerObj) try { S.peerObj.destroy(); } catch (e) {}
  S.peerObj = null; S.role = null;
  show('s-home');
});
$('#b-copy').addEventListener('click', async () => {
  const t = $('#room-link').textContent;
  try { await navigator.clipboard.writeText(t); $('#wait-msg').textContent = 'コピーしました'; }
  catch (e) { const r = document.createRange(); r.selectNodeContents($('#room-link')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
});
$('#b-settings').addEventListener('click', () => {
  fillSelect($('#my-lang'), store.get('myLang', 'ja-JP'));
  $('#gas-url').value = store.get('gasUrl', '');
  $('#gas-token').value = store.get('gasToken', '');
  $('#set-msg').textContent = '';
  show('s-settings');
});
function saveSettings() {
  store.set('myLang', $('#my-lang').value);
  store.set('gasUrl', $('#gas-url').value.trim());
  store.set('gasToken', $('#gas-token').value.trim());
}
$('#b-save').addEventListener('click', () => { saveSettings(); $('#home-err').textContent = ''; show('s-home'); });
$('#b-test').addEventListener('click', async () => {
  saveSettings();
  $('#set-msg').textContent = '確認中…';
  try {
    const t = await translate('こんにちは。今日はよろしくお願いします。', LANGS[0], LANGS[1]);
    $('#set-msg').textContent = 'OK: ' + t;
  } catch (e) { $('#set-msg').textContent = e.message; }
});

// ---------- 起動 ----------
(function boot() {
  const room = new URLSearchParams(location.search).get('r');
  if (room && ROOM_RE.test(room)) {
    document.documentElement.lang = 'en';
    const nav = (navigator.language || 'en-US');
    const guess = LANGS.find(l => l.stt === nav) || LANGS.find(l => l.stt.split('-')[0] === nav.split('-')[0] && l.stt !== 'ja-JP') || LANGS[1];
    fillSelect($('#guest-lang'), store.get('guestLang', guess.stt));
    $('#b-join').addEventListener('click', () => startGuest(room));
    show('s-join');
    return;
  }
  fillSelect($('#solo-lang'), store.get('soloLang', 'en-US'));
  show('s-home');
})();
