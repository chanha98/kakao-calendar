/**
 * 여러 사용자 관리
 *  - 관리자(나): Config의 SHARED_SECRET + CALENDAR_ID 사용, 횟수 제한 없음
 *  - 다른 사용자: 등록 페이지에서 받은 개인 코드. 스크립트 속성 USER_<코드> 에 저장
 */

const USER_PREFIX_ = 'USER_';

function resolveUser_(secret, cfg) {
  if (!secret) return null;
  if (cfg.secret && secret === cfg.secret) {
    return { code: 'owner', name: '관리자', calendarId: cfg.calendarId, isOwner: true, stateKey: 'LAST_TS' };
  }
  const raw = PropertiesService.getScriptProperties().getProperty(USER_PREFIX_ + secret);
  if (!raw) return null;
  const u = JSON.parse(raw);
  if (u.disabled) return null;
  u.code = secret;
  u.stateKey = 'LAST_TS_' + secret;
  return u;
}

/** 하루 사용 횟수 확인 + 1 증가. 초과면 false */
function useQuota_(user, cfg) {
  if (user.isOwner) return true;
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const p = PropertiesService.getScriptProperties();
    const key = 'COUNT_' + user.code;
    const today = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd');
    const c = JSON.parse(p.getProperty(key) || '{}');
    const n = c.d === today ? c.n : 0;
    if (n >= cfg.dailyLimit) return false;
    p.setProperty(key, JSON.stringify({ d: today, n: n + 1 }));
    return true;
  } finally {
    lock.releaseLock();
  }
}

function allUsers_() {
  const all = PropertiesService.getScriptProperties().getProperties();
  return Object.keys(all)
    .filter(function (k) { return k.indexOf(USER_PREFIX_) === 0; })
    .map(function (k) { const u = JSON.parse(all[k]); u.code = k.slice(USER_PREFIX_.length); return u; });
}

/** 등록 페이지(Register.html)에서 호출 */
function registerUser(form) {
  const cfg = getConfig_();
  const name = String(form.name || '').trim().slice(0, 30);
  const calId = String(form.calendarId || '').trim();
  if (cfg.invite && String(form.invite || '').trim() !== cfg.invite) throw new Error('초대 코드가 맞지 않습니다.');
  if (!name) throw new Error('이름을 입력해 주세요.');
  if (!calId) throw new Error('캘린더 ID를 입력해 주세요.');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const users = allUsers_();
    if (users.length >= cfg.maxUsers) throw new Error('등록 인원이 가득 찼습니다. 관리자에게 문의해 주세요.');
    if (users.some(function (u) { return u.calendarId === calId; })) {
      throw new Error('이미 등록된 캘린더입니다. 코드를 잃어버렸다면 관리자에게 문의해 주세요.');
    }

    const cal = connectCalendar_(calId);

    const code = 'kc-' + Utilities.getUuid().replace(/-/g, '').slice(0, 20);
    PropertiesService.getScriptProperties().setProperty(USER_PREFIX_ + code, JSON.stringify({
      name: name, calendarId: calId, calendarName: cal.getName(), created: iso_(new Date()),
    }));
    return { code: code, name: name, calendarName: cal.getName(), shortcutUrl: cfg.shortcutUrl };
  } finally {
    lock.releaseLock();
  }
}

/** 공유받은 캘린더에 연결하고 수정 권한까지 확인. 실패하면 이유를 담은 오류 */
function connectCalendar_(calId) {
  let cal = CalendarApp.getCalendarById(calId);
  if (!cal) {
    try { cal = CalendarApp.subscribeToCalendar(calId, { hidden: true, selected: false }); } catch (e) { cal = null; }
  }
  if (!cal) throw new Error('캘린더에 접근할 수 없습니다. ① 공유 대상 이메일 ② 권한 "일정 변경" ③ 캘린더 ID를 다시 확인해 주세요. 공유 직후라면 1~2분 뒤 다시 시도해 주세요.');
  if (cal.isOwnedByMe()) throw new Error('이 캘린더는 등록할 수 없습니다. 본인 캘린더의 ID를 입력해 주세요.');

  // 수정 권한 확인 (1년 뒤에 1분짜리 일정을 만들었다가 바로 삭제)
  try {
    const t = new Date(Date.now() + 365 * 86400000);
    cal.createEvent('[카톡캘린더 연결 확인]', t, new Date(t.getTime() + 60000)).deleteEvent();
  } catch (e) {
    throw new Error('캘린더를 볼 수만 있고 수정할 권한이 없습니다. 공유 권한을 "일정 변경"으로 바꿔 주세요.');
  }
  return cal;
}

// ---------------------------------------------------------------- 관리자용 (편집기에서 실행)

/** 등록된 사용자 목록과 오늘 사용 횟수 */
function listUsers() {
  const p = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd');
  const users = allUsers_();
  if (!users.length) { console.log('등록된 사용자가 없습니다.'); return; }
  users.forEach(function (u) {
    const c = JSON.parse(p.getProperty('COUNT_' + u.code) || '{}');
    console.log([
      u.disabled ? '[중지]' : '[사용]', u.name, '| 캘린더: ' + (u.calendarName || '') + ' (' + u.calendarId + ')',
      '| 오늘 ' + (c.d === today ? c.n : 0) + '회', '| 코드: ' + u.code, '| 등록: ' + u.created,
    ].join(' '));
  });
}

/**
 * 사용자 중지/재개/삭제: 아래 TARGET에 이름이나 코드를 적고 실행
 */
const ADMIN_TARGET = '';   // 예: '홍길동' 또는 'kc-xxxx'

function disableUser() { setUserState_(ADMIN_TARGET, 'disable'); }
function enableUser()  { setUserState_(ADMIN_TARGET, 'enable'); }
function deleteUser()  { setUserState_(ADMIN_TARGET, 'delete'); }

/**
 * 사용자의 캘린더만 바꾸기 (개인 코드·단축어는 그대로)
 * ADMIN_TARGET에 이름이나 코드, ADMIN_NEW_CALENDAR에 새 캘린더 ID를 적고 실행
 * 예: 테스트용 캘린더로 바꿨다가, 괜찮으면 원래 캘린더(지메일 주소)로 다시 바꾸기
 */
const ADMIN_NEW_CALENDAR = '';   // 예: 'xxxx@group.calendar.google.com' 또는 'xxxx@gmail.com'

function changeUserCalendar() {
  const target = ADMIN_TARGET;
  const calId = String(ADMIN_NEW_CALENDAR || '').trim();
  if (!target) throw new Error('Users.gs의 ADMIN_TARGET에 이름이나 코드를 적어 주세요.');
  if (!calId) throw new Error('Users.gs의 ADMIN_NEW_CALENDAR에 새 캘린더 ID를 적어 주세요.');

  const hits = allUsers_().filter(function (u) { return u.code === target || u.name === target; });
  if (hits.length !== 1) throw new Error('대상이 ' + hits.length + '명입니다. 코드로 지정해 주세요.');
  const u = hits[0];
  if (allUsers_().some(function (o) { return o.code !== u.code && o.calendarId === calId; })) {
    throw new Error('다른 사용자가 이미 쓰고 있는 캘린더입니다.');
  }

  const cal = connectCalendar_(calId);
  const p = PropertiesService.getScriptProperties();
  const key = USER_PREFIX_ + u.code;
  const data = JSON.parse(p.getProperty(key));
  const before = (data.calendarName || '') + ' (' + data.calendarId + ')';
  data.calendarId = calId;
  data.calendarName = cal.getName();
  p.setProperty(key, JSON.stringify(data));
  p.deleteProperty('LAST_TS_' + u.code);   // 대화 내보내기 처리 기록 초기화 (새 캘린더 기준으로 다시)
  console.log(u.name + ': 캘린더 변경 ' + before + ' → ' + cal.getName() + ' (' + calId + ')');
}

function setUserState_(target, op) {
  if (!target) throw new Error('Users.gs의 ADMIN_TARGET에 이름이나 코드를 적어 주세요.');
  const p = PropertiesService.getScriptProperties();
  const hits = allUsers_().filter(function (u) { return u.code === target || u.name === target; });
  if (hits.length !== 1) throw new Error('대상이 ' + hits.length + '명입니다. 코드로 지정해 주세요.');
  const u = hits[0];
  const key = USER_PREFIX_ + u.code;
  if (op === 'delete') {
    p.deleteProperty(key); p.deleteProperty('COUNT_' + u.code); p.deleteProperty('LAST_TS_' + u.code);
  } else {
    const data = JSON.parse(p.getProperty(key));
    data.disabled = op === 'disable';
    p.setProperty(key, JSON.stringify(data));
  }
  console.log(u.name + ': ' + op + ' 완료');
}
