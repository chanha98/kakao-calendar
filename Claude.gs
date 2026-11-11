/** Claude API로 카톡 메시지를 캘린더 작업 목록으로 변환 (structured outputs: output_config.format) */

const ACTIONS_SCHEMA_ = {
  type: 'object',
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['create', 'update', 'cancel'],
            description: 'create=새 일정, update=기존 일정 수정(시간/제목/장소/소품), cancel=기존 일정 취소' },
          event_id: { type: 'string', description: 'update/cancel일 때 기존 일정 목록의 id. create면 생략' },
          title: { type: 'string', description: 'create면 필수. update면 제목이 바뀔 때만' },
          start: { type: 'string', description: 'ISO 8601, +09:00 포함 (예: 2026-11-15T14:00:00+09:00). 종일이면 날짜만(2026-11-15). update면 시간이 바뀔 때만' },
          end: { type: 'string', description: 'start와 같은 형식. 모르면 생략. 여러 날 종일 일정이면 마지막 날' },
          all_day: { type: 'boolean' },
          location: { type: 'string', description: '바뀌거나 새로 언급될 때만' },
          props: {
            type: 'array',
            description: '소품/물품 수량. 새로 언급되거나 바뀐 것만',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '소품 이름 (예: 의자)' },
                from: { type: 'string', description: '이전 수량 (예: 10개). 모르면 생략' },
                to: { type: 'string', description: '새 수량 (예: 12개). 빼기로 했으면 "취소"' },
              },
              required: ['name', 'to'],
              additionalProperties: false,
            },
          },
          note: { type: 'string', description: '일정에 덧붙일 메모(준비물, 담당자, 작업 내용 등). 항목이 여러 개면 줄바꿈(\\n)으로 나눔. 원문 표현 그대로. 없으면 생략' },
          important: { type: 'boolean', description: '원문에서 빨간색(글씨·배경)으로 강조된 내용이 이 일정에 있으면 true. 캘린더에서 빨간색으로 표시됨' },
          source_quote: { type: 'string', description: '근거가 된 원문 메시지 일부' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['type', 'source_quote', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['actions'],
  additionalProperties: false,
};

function buildSystemPrompt_(cfg) {
  const now = new Date();
  const today = Utilities.formatDate(now, TZ, 'yyyy-MM-dd HH:mm') +
    ' (' + WEEKDAYS_[Number(Utilities.formatDate(now, TZ, 'u')) % 7] + '요일)';
  return [
    '너는 업무 단체 카톡방' + (cfg.roomName ? '("' + cfg.roomName + '")' : '') +
      ' 메시지를 읽고 구글 캘린더 작업 목록(JSON)으로 바꾸는 비서다.',
    '현재 시각: ' + today + ', 시간대: Asia/Seoul(+09:00).',
    '',
    '규칙:',
    '- 일정 공지, 일정 변경·취소, 소품/물품 수량 변경만 뽑는다. 인사, 잡담, 단순 확인("넵", "확인했습니다")은 무시한다. 해당 내용이 없으면 actions를 빈 배열로 한다.',
    '- "내일", "다음주 수요일" 같은 상대 날짜는 그 메시지가 올라온 시각 기준으로 계산한다. 메시지 시각이 없으면 현재 시각 기준으로 계산한다.',
    '- 기존 일정 목록에 같은 건으로 보이는 일정이 있으면 새로 만들지 말고 그 event_id로 update/cancel 한다. 날짜, 제목 키워드, 맥락으로 판단한다.',
    '- 새 일정과 함께 언급된 소품은 그 create 작업의 props에 넣는다. 기존 일정의 소품 변경은 update(props)로 붙인다. 어느 일정인지 애매하면 가장 가까운 관련 일정에 붙이고 confidence를 low로 한다.',
    '- 같은 일정에 대한 여러 메시지는 하나의 작업으로 합친다. 마지막에 확정된 내용 기준으로 정리한다.',
    '- update에는 바뀌는 필드만 넣는다. 끝 시간만 바뀌면 start 없이 end만 넣는다.',
    '- 끝나는 시간을 모르면 end는 생략한다.',
    '- 원문(텍스트·이미지)에 적힌 정보만 쓴다. 적혀 있지 않은 시작/끝 시간, 장소, 수량은 만들어 넣지 않는다. 시간이 전혀 없고 날짜만 있으면 종일 일정으로 한다.',
    '- 어느 일정인지 등 해석이 애매하면 원문대로 넣고 confidence를 low로 한다.',
    '',
    '일정표(표) 이미지 규칙:',
    '- 표 전체의 모든 날짜·모든 행을 빠짐없이 처리한다. 빨간 테두리 박스나 형광 칠은 "그 부분이 중요하다"는 강조일 뿐, 그 부분만 처리하라는 뜻이 아니다. 빨간 테두리 안의 일정은 important를 true로 한다.',
    '- "휴식", "점심", "식사"처럼 쉬는 시간만 적힌 행은 일정을 만들지 않는다.',
    '- 날짜 칸이 여러 행에 걸쳐 합쳐져 있으면 그 날짜는 해당 행 전체에 적용된다.',
    '- 시간 칸에 시간이 적힌 행이 새 일정의 시작이다. 시간 칸이 비어 있는 행은 바로 위에서 가장 가까운 시간이 적힌 행의 일정에 속한다. 빈 행 때문에 새 시간을 추정하지 않는다.',
    '- 시간 칸이 "~22시"처럼 "~시각"만 있는 행은 "그 시각까지 끝내면 되는 마감"이다. 별도 일정을 만들지 않는다. 바로 위에서 가장 가까운 시간이 적힌 행의 일정에 넣되, note의 맨 마지막 줄(표에서 맨 아래 있으므로)에 "~22시까지 완료: (내용 원문)"으로 적고, 그 일정의 end를 그 시각(22:00)으로 한다.',
    '- 일정의 end는 표에 끝 시간(또는 위의 "~시각" 마감)이 적힌 경우에만 넣는다. 다음 행의 시간을 끝 시간으로 쓰지 않는다.',
    '- note의 줄 순서는 표의 위→아래 순서를 그대로 따른다.',
    '- CALL TIME(콜타임, 집합 시간)이 있으면 그날 첫 일정의 note 첫 줄에 "콜타임 09:00"처럼 적는다. 첫 일정 시작 시간과 다르면 콜타임으로 별도 일정을 만들지 말고 note에만 적는다.',
    '- 셀 안의 내용 중 일정 시간이나 시간 칸이 아닌 곳에 적힌 시각(예: "*백석창고이동: 제작팀 17시 출발 예정")은 일정의 시작 시간으로 쓰지 말고 note에 그대로 둔다.',
    '- 한 일정에 소제목(예: 백석창고 이동, 신관창고 이동)이 여러 개면 note에 소제목별로 줄을 나눠 원문 그대로 적는다. "*"로 시작하는 보충 문구는 그 문구가 가리키는 소제목 줄에 붙이고(예: "백석창고 이동: ... (제작팀 17시 출발 예정)"), 특정 소제목을 가리키지 않으면 note 맨 끝 줄에 따로 적는다. 서로 다른 소제목 내용을 섞지 않는다.',
    '- 표의 작업 목록·운반 물품은 props가 아니라 note에 적는다. props는 "○○ N개로 변경"처럼 수량을 정하거나 바꾸는 내용일 때만 쓴다.',
    '- 일정 제목은 그 시간 행에 적힌 본문을 원문 그대로 쓴다. "시작", "집합", "출발" 같은 말도 빼지 않는다(예: "양주창고 이동 시작"). 본문 뒤의 괄호 보충 문구는 제목에서 빼고 note에 적는다.',
    '- 빨간 글씨, 빨간 배경 칸처럼 빨간색으로 강조된 내용은 중요 표시다. 그 내용이 들어간 일정은 important를 true로 하고, note에서 그 내용 줄 앞에 "❗"를 붙인다(예: "❗벤치, 가로등 세트팀에 같이 보내기"). 빨간색 강조가 없으면 important는 생략한다.',
    '- 이미지나 PDF(카톡 캡처, 공지문, 일정표 사진·문서 등)가 함께 오면 이미지 속 글자도 메시지로 보고 같은 규칙으로 처리한다. source_quote에는 이미지에서 읽은 해당 문구를 적는다.',
    '- 카톡 캡처에 날짜 구분선(예: 2026년 11월 9일 월요일)이나 메시지 시각이 보이면 그것을 기준으로 상대 날짜를 계산한다. 이미지 글자가 흐리거나 잘려서 확실하지 않으면 confidence를 low로 한다.',
  ].join('\n');
}

/**
 * 첨부가 여러 개면(일정표 여러 페이지 등) 첨부마다 Claude를 동시에 따로 불러서 합침.
 * 한 번에 다 보내면 일정이 많을 때 1분 넘게 걸려 아이폰 단축어가 시간 초과로 끊기기 때문.
 */
function callClaude_(messagesText, events, cfg, images) {
  images = images || [];
  if (images.length <= 1) {
    return parseClaudeResponse_(UrlFetchApp.fetch(API_URL_, claudeRequest_(messagesText, events, cfg, images, '')));
  }
  const requests = images.map(function (img, i) {
    const hint = '첨부 ' + images.length + '개 중 ' + (i + 1) + '번째만 보내졌다. 나머지 첨부는 따로 처리되니 이 첨부 내용만 작업으로 만든다.' +
      (i > 0 ? ' 카톡 메시지(텍스트)는 1번째 첨부 쪽에서 처리하므로 여기서는 참고만 하고 작업으로 만들지 않는다.' : '');
    return claudeRequest_(messagesText, events, cfg, [img], hint);
  });
  const all = [];
  UrlFetchApp.fetchAll(requests).forEach(function (res) {
    parseClaudeResponse_(res).forEach(function (a) { all.push(a); });
  });
  return dedupeActions_(all);
}

const API_URL_ = 'https://api.anthropic.com/v1/messages';

function claudeRequest_(messagesText, events, cfg, images, hint) {
  const text =
    '## 기존 캘린더 일정 (JSON)\n' + JSON.stringify(events) +
    '\n\n## 카톡 메시지\n' + (messagesText || '(텍스트 없음)') +
    (images.length ? '\n\n## 첨부 이미지·PDF\n위 첨부 ' + images.length + '개도 카톡 메시지로 보고 함께 분석할 것.' : '') +
    (hint ? '\n' + hint : '');
  const userContent = images.map(function (img) {
    const kind = img.mediaType === 'application/pdf' ? 'document' : 'image';
    return { type: kind, source: { type: 'base64', media_type: img.mediaType, data: img.data } };
  }).concat([{ type: 'text', text: text }]);

  const payload = {
    model: cfg.model,
    max_tokens: 16000,
    system: buildSystemPrompt_(cfg),
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: ACTIONS_SCHEMA_ },
    },
    fallbacks: 'default',   // 안전 필터에 잘못 걸려 거절되면 서버가 다른 모델로 자동 재시도
    messages: [{ role: 'user', content: userContent }],
  };
  return {
    url: API_URL_,
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };
}

function parseClaudeResponse_(res) {
  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code !== 200) throw new Error('Claude API 오류 ' + code + ': ' + body.slice(0, 500));

  const data = JSON.parse(body);
  if (data.stop_reason === 'refusal') throw new Error('Claude가 이 내용을 처리하지 않았습니다.');
  if (data.stop_reason === 'max_tokens') throw new Error('응답이 너무 길어 잘렸습니다. 메시지를 나눠서 보내 주세요.');

  // thinking 블록 뒤에 오는 text 블록에 스키마대로 된 JSON이 들어 있음
  const block = (data.content || []).filter(function (b) { return b.type === 'text'; })[0];
  if (!block) throw new Error('Claude 응답에 결과가 없습니다: ' + body.slice(0, 500));
  return JSON.parse(block.text).actions || [];
}

/** 따로 처리한 첨부끼리 겹친 작업 제거: 같은 기존 일정(update/cancel)은 첫 번째만, 같은 제목+시작의 새 일정도 첫 번째만 */
function dedupeActions_(actions) {
  const seen = {};
  return actions.filter(function (a) {
    const key = a.type === 'create' ? 'c|' + a.title + '|' + a.start : a.type + '|' + a.event_id;
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}
