# PROJECT_CONTEXT

이 문서는 프로젝트의 고정 배경, 목표, 도메인 개념을 요약하는 공통 진입점이다. 자주 바뀌는 진행 로그나 일시적인 구현 방향은 이 문서에 넣지 않는다.

> **초기화 필수**: 아래 프로젝트 개요 5개 항목과 목표 placeholder를 실제 값으로 바꾼다. 목표가 3개보다
> 적으면 쓰지 않는 목표 줄을 삭제한다. 남아 있으면 `node scripts/worklog.js check`가 exit 1로 차단한다.

## 프로젝트 개요

- 프로젝트 이름: `<project-name>`
- 한 줄 설명: `<what this project does>`
- 주요 사용자: `<target users>`
- 주요 실행 환경: `<browser/server/cli/mobile/etc.>`
- 주요 기술 스택: `<frontend/backend/db/runtime/etc.>`

## 목표

1. `<goal-1>`
2. `<goal-2>`
3. `<goal-3>`

## 비목표

- `<explicit-non-goal-1>`
- `<explicit-non-goal-2>`

## 도메인 개념

| 개념 | 의미 | 관련 파일/모듈 |
| --- | --- | --- |
| `<term>` | `<definition>` | `<path>` |

## 시스템 구성

- Frontend: `<entry points, routes, UI shells>`
- Backend: `<server, route modules, service boundaries>`
- Data: `<database, storage, file formats>`
- External services: `<APIs, auth, queues, etc.>`

## 운영 원칙

- 기존 동작과 저장 계약을 우선 보존한다.
- 큰 변경은 작은 slice로 나누어 검증 가능한 상태로 전달한다.
- 브라우저 또는 외부 시스템 검증이 필요한 경우, 자동 검증만으로 성공을 단정하지 않는다.

## 참고 문서

- 현재 작업: **활성 브랜치 저널** `docs/ai/journal/<YYYY-MM-DD>_<branch-slug>.md` (없으면 `docs/ai/NEXT_WORK.md`, 목록은 `docs/ai/journal/INDEX.md`)
- 구현 계획: `docs/ai/IMPLEMENTATION_PLAN.md`
- 결정 기록: `docs/ai/DECISIONS.md`
- 계약 기록: `docs/ai/CONTRACTS.md`
- 검증 기록: `docs/ai/VALIDATION.md`
- 진행 연대기: `docs/ai/CHANGELOG.md`
