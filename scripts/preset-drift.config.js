'use strict';

/**
 * 프로젝트가 의도적으로 정본과 다르게 유지하는 기계 파일.
 *
 * `worklog.js check`가 출력한 LF 정규화 SHA-256을 두 해시 필드에 넣고, 왜 이 프로젝트에는 차이가
 * 필요한지 reason에 남긴다. 검토 당시 상류와 승인한 프로젝트 내용을 함께 고정해야 어느 한쪽이
 * 바뀌어도 다시 검토할 수 있다. 정본과 다시 같아지거나 승인 뒤 내용이 바뀌어도 검사가 알린다.
 * 이 파일은 프로젝트 소유 설정이므로 프리셋 기계 파일을 갱신할 때 덮어쓰지 않는다.
 */

module.exports = {
  schemaVersion: 1,

  intentionalDifferences: {
    // 'AGENTS.md': {
    //   reviewedUpstreamSha256: '<차이를 검토한 당시 기준 SHA-256>',
    //   acceptedSha256: '<worklog.js check가 출력한 현재 SHA-256>',
    //   reason: '<이 프로젝트에서 이 차이를 유지해야 하는 이유>',
    // },
  },
};
