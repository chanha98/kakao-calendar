/**
 * 카톡 단톡방 메시지 → 구글 캘린더 반자동 반영
 *
 * iOS 단축어가 이 웹앱으로 POST(JSON) 요청을 보냅니다.
 *   { "secret": "...", "action": "parse", "text": "카톡 내용", "images": "base64 (여러 장이면 줄바꿈으로 구분, 선택)" }
 *     → { ok, summary, token }   (token이 비어 있으면 반영할 내용 없음)
 *   { "secret": "...", "action": "apply", "token": "..." }
 *     → { ok, summary }
 */

const TZ = 'Asia/Seoul';
const CACHE_TTL_SEC = 600;          // 미리보기 후 10분 안에 승인해야 함
const EVENT_LOOKAHEAD_DAYS = 90;    // 기존 일정 매칭 범위 (앞으로)
const EVENT_LOOKBACK_DAYS = 7;      // 기존 일정 매칭 범위 (지난 일정)

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const cfg = getConfig_();
    const user = resolveUser_(String(body.secret || '').trim(), cfg);
    if (!user) {
      return json_({ ok: false, summary: '인증 실패: 개인 코드가 맞지 않거나 사용이 중지되었습니다. 관리자에게 문의해 주세요.' });
    }
    if (body.action === 'parse') {
      if (!useQuota_(user, cfg)) {
        return json_({ ok: false, summary: '오늘 사용 횟수(' + cfg.dailyLimit + '회)를 모두 썼습니다. 내일 다시 이용해 주세요.' });
      }
      return json_(handleParse_(String(body.text || ''), cfg, user, parseImages_(body.images)));
    }
    if (body.action === 'apply') return json_(handleApply_(String(body.token || ''), cfg, user));
    return json_({ ok: false, summary: '알 수 없는 action: ' + body.action });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, summary: '오류: ' + (err && err.message ? err.message : err) });
  }
}

// 브라우저로 열면 등록 페이지
function doGet() {
  const t = HtmlService.createTemplateFromFile('Register');
  t.ownerEmail = CalendarApp.getDefaultCalendar().getId();  // 기본 캘린더 ID = 관리자 이메일 (추가 권한 불필요)
  return t.evaluate()
    .setTitle('카톡→캘린더 등록')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function getConfig_() {
  const p = PropertiesService.getScriptProperties();
  const get = function (k) { return p.getProperty(k) || CONFIG[k] || ''; };
  const cfg = {
    apiKey: get('CLAUDE_API_KEY'),
    calendarId: get('CALENDAR_ID') || 'primary',
    secret: get('SHARED_SECRET'),
    roomName: get('ROOM_NAME'),
    model: get('CLAUDE_MODEL') || 'claude-sonnet-5-5',
    invite: get('INVITE_CODE'),
    dailyLimit: Number(get('DAILY_LIMIT')) || 20,
    maxUsers: Number(get('MAX_USERS')) || 30,
    shortcutUrl: get('SHORTCUT_URL'),
  };
  if (!/^sk-ant-/.test(cfg.apiKey)) throw new Error('Config.gs의 CLAUDE_API_KEY가 설정되지 않았습니다.');
  return cfg;
}

function getCalendar_(calendarId) {
  const cal = calendarId === 'primary'
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(calendarId);
  if (!cal) throw new Error('캘린더에 접근할 수 없습니다. 캘린더 공유가 해제되었는지 확인해 주세요.');
  return cal;
}

// ---------------------------------------------------------------- parse

function handleParse_(text, cfg, user, images) {
  images = images || [];
  const extracted = extractMessages_(text, user.stateKey);
  if (!extracted.messages.trim() && !images.length) {
    return { ok: true, summary: extracted.isExport
      ? '지난번 이후 새 메시지가 없습니다.'
      : '분석할 텍스트가 없습니다.\n\n' + receivedInfo_(text, images) };
  }

  const cal = getCalendar_(user.calendarId);
  const events = listEvents_(cal);
  const actions = callClaude_(extracted.messages, events, cfg, images);

  if (!actions.length) {
    // 새 메시지는 확인했으니 다음엔 건너뛰도록 처리 시각만 저장
    if (extracted.latestTs) saveLastTs_(user.stateKey, extracted.latestTs);
    return { ok: true, summary: '일정·소품 관련 내용이 없습니다.\n\n' + receivedInfo_(text, images) };
  }

  const token = Utilities.getUuid();
  CacheService.getScriptCache().put(
    'pending:' + token,
    JSON.stringify({ user: user.code, actions: actions, latestTs: extracted.latestTs }),
    CACHE_TTL_SEC
  );

  const byId = {};
  events.forEach(function (ev) { byId[ev.id] = ev; });
  return { ok: true, token: token, summary: formatSummary_(actions, byId) };
}

/** 결과가 없을 때 서버가 실제로 받은 내용을 알려줌 (단축어가 이미지를 못 보낸 경우 등 원인 파악용) */
function receivedInfo_(text, images) {
  const t = String(text || '').trim();
  const head = t.replace(/\s+/g, ' ').slice(0, 40);
  return '(받은 내용: 이미지·PDF ' + images.length + '개, 글 ' + t.length + '자' +
    (t && !images.length ? ' "' + head + (t.length > 40 ? '…' : '') + '"' : '') + ')';
}

const MAX_IMAGES_ = 8;
const MAX_IMAGE_B64_ = 6.5 * 1024 * 1024;   // base64 기준 약 5MB (Claude API 이미지 한도)

/**
 * 단축어가 보낸 이미지(base64) 정리.
 * 문자열(여러 장이면 쉼표로 구분) 또는 배열 모두 받음. data:...;base64, 접두어도 허용(쉼표로 잘린 뒤 버려짐).
 */
function parseImages_(raw) {
  if (!raw) return [];
  // 구분자는 쉼표(,)만. base64 인코딩 옵션에 따라 중간에 줄바꿈이 들어갈 수 있어 공백·줄바꿈은 지움
  const parts = Array.isArray(raw) ? raw : String(raw).split(',');
  const list = parts
    .map(function (s) { return String(s || '').replace(/\s+/g, '').replace(/^data:[^;]*;base64$/, ''); })
    .filter(function (s) { return s.length > 100; });   // 빈 값·찌꺼기 제외
  if (list.length > MAX_IMAGES_) throw new Error('이미지는 한 번에 ' + MAX_IMAGES_ + '장까지 보낼 수 있습니다.');
  return list.map(function (data, i) {
    if (data.length > MAX_IMAGE_B64_ && data.indexOf('JVBERi0') !== 0) throw new Error((i + 1) + '번째 이미지가 너무 큽니다. 단축어의 크기 조절 단계를 확인해 주세요.');
    const mediaType = imageMediaType_(data);
    if (!mediaType) throw new Error((i + 1) + '번째 파일 형식을 읽을 수 없습니다. 이미지(JPEG) 또는 PDF만 보낼 수 있습니다.');
    return { mediaType: mediaType, data: data };
  });
}

/** base64 앞부분으로 이미지 형식 판별 (HEIC 등 미지원 형식은 '') */
function imageMediaType_(b64) {
  if (b64.indexOf('/9j/') === 0) return 'image/jpeg';
  if (b64.indexOf('iVBORw0KGgo') === 0) return 'image/png';
  if (b64.indexOf('R0lGOD') === 0) return 'image/gif';
  if (b64.indexOf('UklGR') === 0) return 'image/webp';
  if (b64.indexOf('JVBERi0') === 0) return 'application/pdf';   // PDF는 이미지로 바꾸지 않고 그대로 Claude에 보냄
  return '';
}

function listEvents_(cal) {
  const now = new Date();
  const from = new Date(now.getTime() - EVENT_LOOKBACK_DAYS * 86400000);
  const to = new Date(now.getTime() + EVENT_LOOKAHEAD_DAYS * 86400000);
  return cal.getEvents(from, to).map(function (ev) {
    const allDay = ev.isAllDayEvent();
    return {
      id: ev.getId(),
      title: ev.getTitle(),
      all_day: allDay,
      start: iso_(allDay ? ev.getAllDayStartDate() : ev.getStartTime()),
      end: iso_(allDay ? ev.getAllDayEndDate() : ev.getEndTime()),
      location: ev.getLocation(),
      description: (ev.getDescription() || '').slice(0, 300),
    };
  });
}

// ---------------------------------------------------------------- apply

function handleApply_(token, cfg, user) {
  if (!token) return { ok: true, summary: '반영할 내용이 없습니다. 캘린더는 바뀌지 않았습니다.' };
  const cache = CacheService.getScriptCache();
  const raw = cache.get('pending:' + token);
  const pending = raw && JSON.parse(raw);
  if (!pending || pending.user !== user.code) {
    return { ok: false, summary: '승인 시간(10분)이 지났거나 이미 반영했습니다. 다시 실행해 주세요.' };
  }
  cache.remove('pending:' + token);
  const cal = getCalendar_(user.calendarId);

  const lines = pending.actions.map(function (a, i) {
    try {
      return (i + 1) + '. ✅ ' + applyAction_(cal, a);
    } catch (err) {
      console.error(err);
      return (i + 1) + '. ❌ ' + (a.title || a.event_id) + ': ' + err.message;
    }
  });

  if (pending.latestTs) saveLastTs_(user.stateKey, pending.latestTs);
  return { ok: true, summary: '캘린더 반영 결과\n' + lines.join('\n') };
}

// ---------------------------------------------------------------- utils

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function iso_(d) {
  return Utilities.formatDate(d, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

const WEEKDAYS_ = ['일', '월', '화', '수', '목', '금', '토'];

function fmtDate_(d, withTime) {
  const wd = WEEKDAYS_[Number(Utilities.formatDate(d, TZ, 'u')) % 7];
  return Utilities.formatDate(d, TZ, 'M/d') + '(' + wd + ')' +
    (withTime ? ' ' + Utilities.formatDate(d, TZ, 'HH:mm') : '');
}

function fmtRange_(start, end, allDay) {
  if (!start) return '';
  const s = new Date(start);
  if (allDay) return fmtDate_(s, false) + ' 종일';
  if (!end) return fmtDate_(s, true);
  const e = new Date(end);
  const sameDay = Utilities.formatDate(s, TZ, 'yyyyMMdd') === Utilities.formatDate(e, TZ, 'yyyyMMdd');
  return fmtDate_(s, true) + '~' + (sameDay ? Utilities.formatDate(e, TZ, 'HH:mm') : fmtDate_(e, true));
}

function formatSummary_(actions, eventsById) {
  const label = { create: '새 일정', update: '변경', cancel: '취소' };
  const out = actions.map(function (a, i) {
    const old = a.event_id && eventsById[a.event_id];
    const lines = [];
    let head = (i + 1) + '. [' + (label[a.type] || a.type) + '] ';
    if (a.type === 'create') {
      head += (a.title || '(제목 없음)') + ' · ' + fmtRange_(a.start, a.end, a.all_day);
    } else {
      head += (old ? old.title : (a.title || a.event_id));
      if (old) head += ' (' + fmtRange_(old.start, old.end, old.all_day) + ')';
    }
    if (a.important) head += '  ❗중요(빨간색)';
    lines.push(head);
    if (a.type === 'update') {
      if (a.title && old && a.title !== old.title) lines.push('   제목 → ' + a.title);
      if (a.start) lines.push('   시간 → ' + fmtRange_(a.start, a.end, a.all_day));
      else if (a.end) lines.push('   끝 시간 → ' + fmtDate_(new Date(a.end), true));
    }
    if (a.location) lines.push('   장소: ' + a.location);
    (a.props || []).forEach(function (p) {
      lines.push('   소품: ' + p.name + ' ' + (p.from ? p.from + '→' : '') + p.to);
    });
    if (a.note) lines.push('   메모: ' + a.note.split('\n').join('\n         '));
    if (a.confidence === 'low') lines.push('   ⚠ 확실하지 않음: "' + (a.source_quote || '') + '"');
    if (a.type !== 'create' && !old) lines.push('   ⚠ 기존 일정을 찾지 못함');
    return lines.join('\n');
  });
  const full = '이렇게 반영할까요?\n\n' + out.join('\n');
  // 단축어 메뉴 창은 설명 글을 스크롤할 수 없어서 길면 반영/취소 버튼이 화면 밖으로 밀려남 → 짧은 목록으로
  const lineCount = full.split('\n').length;
  return full.length <= SUMMARY_MAX_CHARS_ && lineCount <= SUMMARY_MAX_LINES_
    ? full : compactSummary_(actions, eventsById);
}

// 아이폰 글자 크기를 키운 경우 한 줄이 두 줄로 접히므로 넉넉히 짧게 잡음
const SUMMARY_MAX_CHARS_ = 300;
const SUMMARY_MAX_LINES_ = 10;
const COMPACT_MAX_DATES_ = 5;
const COMPACT_MAX_CHANGES_ = 3;

/**
 * 일정이 많을 때: 날짜별 개수만 보여 주고, 기존 일정을 건드리는 변경·취소만 따로 나열.
 * 전체 화면이 15줄 안쪽이 되도록 제한 (넘치면 단축어 메뉴의 반영/취소 버튼이 화면 밖으로 밀려남)
 */
function compactSummary_(actions, eventsById) {
  const cut = function (s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
  const count = function (t) { return actions.filter(function (a) { return a.type === t; }).length; };
  const out = ['일정 ' + actions.length + '개를 반영할까요?',
    '새 ' + count('create') + ' · 변경 ' + count('update') + ' · 취소 ' + count('cancel'), ''];

  // 새 일정: 날짜별 개수
  const byDate = {};
  const dates = [];
  actions.forEach(function (a) {
    if (a.type !== 'create' || !a.start) return;
    const d = Utilities.formatDate(parseDate_(a.start), TZ, 'yyyyMMdd');
    if (!byDate[d]) { byDate[d] = { n: 0, label: fmtDate_(parseDate_(a.start), false) }; dates.push(d); }
    byDate[d].n++;
  });
  dates.sort();
  const changes = actions.filter(function (a) { return a.type !== 'create'; });
  const maxDates = changes.length ? COMPACT_MAX_DATES_ : COMPACT_MAX_DATES_ + 3;
  dates.slice(0, maxDates).forEach(function (d) { out.push(byDate[d].label + ' ' + byDate[d].n + '개'); });
  if (dates.length > maxDates) out.push('…외 ' + (dates.length - maxDates) + '일');

  // 변경·취소: 어느 기존 일정인지 꼭 보이게
  if (changes.length) {
    out.push('');
    changes.slice(0, COMPACT_MAX_CHANGES_).forEach(function (a) {
      const old = a.event_id && eventsById[a.event_id];
      out.push('[' + (a.type === 'cancel' ? '취소' : '변경') + '] ' + cut(old ? old.title : (a.title || '?'), 12));
    });
    if (changes.length > COMPACT_MAX_CHANGES_) out.push('…외 ' + (changes.length - COMPACT_MAX_CHANGES_) + '개');
  }

  const flags = [];
  const imp = actions.filter(function (a) { return a.important; }).length;
  const low = actions.filter(function (a) { return a.confidence === 'low'; }).length;
  if (imp) flags.push('❗중요 ' + imp);
  if (low) flags.push('⚠확실치 않음 ' + low);
  if (flags.length) out.push('', flags.join(' · '));
  return out.join('\n');
}

// ---------------------------------------------------------------- 수동 테스트 / 도우미

/**
 * 처음 한 번 실행: 권한 승인 + '카톡테스트' 캘린더를 만들고(이미 있으면 재사용)
 * 이 프로그램이 그 캘린더를 쓰도록 연결
 */
function setup() {
  const name = '카톡테스트';
  const found = CalendarApp.getCalendarsByName(name);
  const cal = found.length ? found[0] : CalendarApp.createCalendar(name, { color: CalendarApp.Color.ORANGE });
  PropertiesService.getScriptProperties().setProperty('CALENDAR_ID', cal.getId());
  UrlFetchApp.fetch('https://api.anthropic.com', { muteHttpExceptions: true });  // 외부 호출 권한 승인용
  console.log('준비 완료! 연결된 캘린더: ' + name + ' (' + cal.getId() + ')');
}

/** 편집기에서 실행: 내 캘린더 목록과 ID를 로그에 출력 */
function listCalendars() {
  CalendarApp.getAllCalendars().forEach(function (c) {
    console.log(c.getName() + '  →  ' + c.getId());
  });
}

/** 편집기에서 실행: 샘플 문장으로 분석 결과(미리보기)를 확인. 캘린더는 바꾸지 않음 */
function testParse() {
  const cfg = getConfig_();
  const sample = '[김실장] [오후 3:10] 11/15 오후 2시 촬영 3시로 변경됐습니다\n' +
                 '[김실장] [오후 3:11] 의자 10개 말고 12개로 부탁드려요\n' +
                 '[박PD] [오후 3:15] 다음주 수요일 10시 사전미팅 잡을게요 (본사 3층)';
  const res = handleParse_(sample, cfg, resolveUser_(cfg.secret, cfg));
  console.log(res.summary);
  console.log('token: ' + res.token);
}

/** 대화 내보내기 중복 방지 기록 초기화 */
function resetLastProcessed() {
  PropertiesService.getScriptProperties().deleteProperty('LAST_TS');
  console.log('초기화 완료');
}
