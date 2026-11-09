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
          note: { type: 'string', description: '일정에 덧붙일 짧은 메모(준비물, 담당자 등). 없으면 생략' },
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
    '- update에는 바뀌는 필드만 넣는다.',
    '- 끝나는 시간을 모르면 end는 생략한다.',
    '- 날짜나 대상이 확실하지 않으면 추측해서 넣되 confidence를 low로 한다.',
  ].join('\n');
}

function callClaude_(messagesText, events, cfg) {
  const userContent =
    '## 기존 캘린더 일정 (JSON)\n' + JSON.stringify(events) +
    '\n\n## 카톡 메시지\n' + messagesText;

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

  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

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
