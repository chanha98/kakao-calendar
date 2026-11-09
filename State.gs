/**
 * 입력 텍스트 정리
 *  - 카톡 '대화 내보내기' 파일이면: 마지막으로 처리한 메시지 이후 것만 골라냄 (중복 반영 방지)
 *  - 그냥 복사·붙여넣은 메시지면: 그대로 사용
 */

const FIRST_RUN_DAYS_ = 14;   // 처음 내보내기를 보냈을 때는 최근 14일 치만 분석
const MAX_CHARS_ = 40000;     // 너무 길면 최근 메시지 위주로 자름

// 내보내기 형식 예시
//   2026. 11. 9. 오후 2:30, 홍길동 : 내용        (iOS)
//   2026년 11월 9일 오후 2:30, 홍길동 : 내용     (안드로이드/PC)
const EXPORT_LINE_RE_ =
  /^(\d{4})(?:년|\.)\s*(\d{1,2})(?:월|\.)\s*(\d{1,2})(?:일|\.)?\s*(오전|오후)\s*(\d{1,2}):(\d{2}),?\s*(.*)$/;

function extractMessages_(text, stateKey) {
  text = String(text || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  const msgs = [];
  lines.forEach(function (line) {
    const m = line.match(EXPORT_LINE_RE_);
    if (m) {
      let h = Number(m[5]) % 12;
      if (m[4] === '오후') h += 12;
      const iso = m[1] + '-' + pad2_(m[2]) + '-' + pad2_(m[3]) + 'T' + pad2_(h) + ':' + m[6] + ':00+09:00';
      msgs.push({ ts: new Date(iso).getTime(), label: iso.slice(0, 16).replace('T', ' '), body: m[7] });
    } else if (msgs.length && line.trim()) {
      msgs[msgs.length - 1].body += '\n' + line;   // 여러 줄 메시지의 이어지는 줄
    }
  });

  // 날짜가 붙은 줄이 거의 없으면 복사·붙여넣기 텍스트로 판단
  if (msgs.length < 3) {
    return { isExport: false, messages: tail_(text.trim()), latestTs: 0 };
  }

  const saved = Number(PropertiesService.getScriptProperties().getProperty(stateKey) || 0);
  const since = saved || (Date.now() - FIRST_RUN_DAYS_ * 86400000);
  const fresh = msgs.filter(function (m) { return m.ts > since; });
  const latestTs = msgs.reduce(function (mx, m) { return Math.max(mx, m.ts); }, saved);

  const out = fresh.map(function (m) {
    const parts = m.body.split(' : ');
    const who = parts.length > 1 ? parts.shift() : '';
    return '[' + m.label + '] ' + (who ? who + ': ' : '') + parts.join(' : ');
  }).join('\n');

  return { isExport: true, messages: tail_(out), latestTs: latestTs };
}

function saveLastTs_(stateKey, ts) {
  const p = PropertiesService.getScriptProperties();
  const cur = Number(p.getProperty(stateKey) || 0);
  if (ts > cur) p.setProperty(stateKey, String(ts));
}

function tail_(s) {
  return s.length > MAX_CHARS_ ? s.slice(s.length - MAX_CHARS_) : s;
}

function pad2_(n) {
  return ('0' + n).slice(-2);
}
