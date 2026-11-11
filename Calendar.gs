/** Claude가 만든 작업을 실제 캘린더에 반영 */

const PROPS_HEADER_ = '[소품]';

function applyAction_(cal, a) {
  if (a.type === 'create') return createEvent_(cal, a);
  if (!a.event_id) throw new Error('기존 일정 id가 없습니다');
  const ev = cal.getEventById(a.event_id);
  if (!ev) throw new Error('기존 일정을 찾지 못했습니다 (' + a.event_id + ')');
  if (a.type === 'cancel') return cancelEvent_(ev, a);
  return updateEvent_(ev, a);
}

function createEvent_(cal, a) {
  if (!a.title || !a.start) throw new Error('제목 또는 시작 시간이 없습니다');
  const desc = buildDescription_('', a);
  const opts = { description: desc, location: a.location || '' };
  let ev;
  if (a.all_day) {
    const s = parseDate_(a.start);
    ev = a.end && a.end !== a.start
      ? cal.createAllDayEvent(a.title, s, addDays_(parseDate_(a.end), 1), opts)  // end는 마지막 날 포함
      : cal.createAllDayEvent(a.title, s, opts);
  } else {
    const s = parseDate_(a.start);
    const e = a.end ? parseDate_(a.end) : new Date(s.getTime() + 3600000);
    ev = cal.createEvent(a.title, s, e, opts);
  }
  if (a.important) ev.setColor(CalendarApp.EventColor.RED);
  return '새 일정: ' + ev.getTitle() + ' · ' + fmtRange_(a.start, a.end, a.all_day);
}

function updateEvent_(ev, a) {
  const changes = [];
  if (a.title && a.title !== ev.getTitle()) {
    ev.setTitle(a.title);
    changes.push('제목');
  }
  if (a.start) {
    if (a.all_day) {
      const s = parseDate_(a.start);
      if (a.end && a.end !== a.start) ev.setAllDayDates(s, addDays_(parseDate_(a.end), 1));
      else ev.setAllDayDate(s);
    } else {
      const s = parseDate_(a.start);
      let e;
      if (a.end) e = parseDate_(a.end);
      else if (ev.isAllDayEvent()) e = new Date(s.getTime() + 3600000);
      else e = new Date(s.getTime() + (ev.getEndTime() - ev.getStartTime()));  // 기존 길이 유지
      ev.setTime(s, e);
    }
    changes.push('시간');
  } else if (a.end && !ev.isAllDayEvent()) {
    ev.setTime(ev.getStartTime(), parseDate_(a.end));  // 끝 시간만 바뀜
    changes.push('끝 시간');
  }
  if (a.location) {
    ev.setLocation(a.location);
    changes.push('장소');
  }
  if ((a.props && a.props.length) || a.note) {
    ev.setDescription(buildDescription_(ev.getDescription() || '', a));
    changes.push(a.props && a.props.length ? '소품' : '메모');
  }
  if (a.important) {
    ev.setColor(CalendarApp.EventColor.RED);
    changes.push('중요 표시');
  }
  return '변경: ' + ev.getTitle() + ' (' + (changes.join(', ') || '변경 없음') + ')';
}

function cancelEvent_(ev, a) {
  // 실수 방지를 위해 삭제하지 않고 제목에 표시만 함
  const title = ev.getTitle();
  if (title.indexOf('[취소]') !== 0) ev.setTitle('[취소] ' + title);
  ev.setDescription(buildDescription_(ev.getDescription() || '',
    { note: '취소됨: "' + (a.source_quote || '') + '"' }));
  return '취소 표시: ' + title;
}

/**
 * 설명란 구조:
 *   (기존 설명 / 메모)
 *
 *   [소품]
 *   - 의자: 12개 (10개→12개, 11/09 변경)
 */
function buildDescription_(current, a) {
  const idx = current.indexOf(PROPS_HEADER_);
  let body = (idx >= 0 ? current.slice(0, idx) : current).trim();
  const propLines = idx >= 0
    ? current.slice(idx + PROPS_HEADER_.length).split('\n').map(function (l) { return l.trim(); }).filter(Boolean)
    : [];

  // 기존 소품 목록을 이름 기준으로 갱신
  const order = [];
  const map = {};
  propLines.forEach(function (l) {
    const m = l.match(/^-\s*([^:]+):\s*(.*)$/);
    const name = m ? m[1].trim() : l;
    if (!map[name]) order.push(name);
    map[name] = l;
  });
  const stamp = Utilities.formatDate(new Date(), TZ, 'MM/dd');
  (a.props || []).forEach(function (p) {
    const name = String(p.name).trim();
    if (!map[name]) order.push(name);
    map[name] = '- ' + name + ': ' + p.to +
      ' (' + (p.from ? p.from + '→' + p.to + ', ' : '') + stamp + ' 변경)';
  });

  // 새 일정이면 메모를 그대로, 기존 일정에 덧붙일 때만 "[MM/dd 추가]" 구분 줄을 따로 넣음
  if (a.note) body = body ? body + '\n\n[' + stamp + ' 추가]\n' + a.note : a.note;

  let out = body;
  if (order.length) {
    out += (out ? '\n\n' : '') + PROPS_HEADER_ + '\n' +
      order.map(function (n) { return map[n]; }).join('\n');
  }
  return out;
}

/** "2026-11-15T14:00:00+09:00" 또는 "2026-11-15"(서울 기준 자정) */
function parseDate_(s) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T00:00:00+09:00');
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += '+09:00';  // 시간대가 빠져 있으면 서울로 간주
  const d = new Date(s);
  if (isNaN(d.getTime())) throw new Error('날짜 형식 오류: ' + s);
  return d;
}

function addDays_(d, n) {
  return new Date(d.getTime() + n * 86400000);
}
