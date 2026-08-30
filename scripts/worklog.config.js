'use strict';

/**
 * 프로젝트별 문서 규모 정책.
 *
 * 이 파일은 `worklog.js` 엔진과 별도로 유지한다. 프리셋 엔진을 갱신할 때 이 파일을 덮어쓰지 않아야
 * 프로젝트가 실측으로 보정한 cap·예산과 판단 근거가 보존된다. 값을 바꿀 때는 근거 주석도 바로 옆에서
 * 함께 고친다. 파일이 없으면 엔진은 하위 호환을 위해 아래 프리셋 기본값과 같은 내장값을 사용한다.
 */

const KB = 1024;

module.exports = {
  schemaVersion: 1,

  documentCaps: {
    // 고정 배경. 넘으면 배경이 아니라 설계 서술이 섞였는지 확인할 시점이다.
    'PROJECT_CONTEXT.md': 8 * KB,
    // 브랜치 저널로 대체된 포인터. 넘으면 여기에 slice를 다시 쓰는 중이라는 신호다.
    'CURRENT_TASK.md': 2 * KB,
    // 활성 저널이 없는 기본 브랜치 bootstrap 포인터. 상세 계획이 들어오기 전의 상한이다.
    'NEXT_WORK.md': 4 * KB,
    // 프리셋 실측은 항목당 약 1.4KB다. 약 22건이면 대체된 결정을 ARCHIVE로 정리할 시점이다.
    'DECISIONS.md': 32 * KB,
    // API/DB/persistence/외부 연동 축별 표. 넘으면 계약 원문이 섞였는지 확인한다.
    'CONTRACTS.md': 24 * KB,
    // 명령 카탈로그와 green/red 스냅샷만 둔다. 넘으면 진행 이력이 재유입됐는지 확인한다.
    'VALIDATION.md': 8 * KB,
    // phase/slice 구조만 두는 세션 미로드 문서의 가독성 기준이다.
    'IMPLEMENTATION_PLAN.md': 12 * KB,
    // 세션 비용이 아니라 활성 이슈 트래커로서의 가독성 기준이다.
    'OPEN_ISSUES.md': 16 * KB,
    // 단일 연대기는 계속 자라므로 기간 이관을 검토할 가독성 기준이다.
    'CHANGELOG.md': 48 * KB,
  },

  // 필수 문서의 개별 cap 합보다 낮게 둬, 각 파일이 통과해도 합계가 커지는 상태를 별도로 잡는다.
  sessionBudget: 64 * KB,

  // adapter는 공통 규칙을 복제하지 않는 얇은 import 진입점이어야 한다.
  adapterMaxBytes: 4 * KB,
};
