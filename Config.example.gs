/**
 * 설정 예시 파일.
 * 이 파일을 Config.gs로 복사한 뒤 값을 채우세요. (Config.gs는 git에 올라가지 않습니다)
 * 스크립트 속성에 같은 이름의 값이 있으면 그쪽이 우선합니다.
 */
const CONFIG = {
  CLAUDE_API_KEY: '',          // sk-ant-... (Claude API 키)
  SHARED_SECRET: '',           // 단축어 요청 검증용 임의 문자열
  CALENDAR_ID: 'primary',
  ROOM_NAME: '',
  CLAUDE_MODEL: 'claude-sonnet-5-5',

  // ---- 여러 사람이 쓰기 위한 설정 ----
  INVITE_CODE: '',              // 등록 페이지에서 입력해야 하는 초대 코드 (링크와 함께 알려줄 것)
  DAILY_LIMIT: 20,              // 1인당 하루 분석 횟수 (관리자 본인은 제한 없음)
  MAX_USERS: 30,                // 최대 등록 인원
  SHORTCUT_URL: '',             // 공유할 단축어 iCloud 링크 (만들고 나서 채움)
};
