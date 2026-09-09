# NEXT_WORK

활성 브랜치 저널이 없는 기본 브랜치 세션의 **작은 시작 포인터**다. 상세 계획·진행 로그·이슈 본문을
복제하지 않고 정본 문서와 마지막 인계 위치만 가리킨다. 작업 브랜치에서는 이 문서 대신 자신의 활성
저널을 따른다.

> **초기화 필수**: 아래 다음 시작점과 차단 요인 marker를 실제 값으로 바꾼다. 다음 작업이 없으면 상태와
> 작업을 `none`/`없음`으로 명시한다. marker가 남으면 `node scripts/worklog.js check`가 exit 1로 차단한다.

## 다음 시작점

- 상태: `ready`
- 작업: `업스트림 결함 리포트 — ROCm 7.2.1 Windows SDK 커널 수치 품질 (minimal repro 정리 + 보고서 작성)`
- 이유: `Open Issue 2 root cause 확정, PC1 듀얼부팅이 동일 GPU 최소 재현 A/B 리그로 현존, 버전 현행(7.2.1) 시한성`
- 첫 확인: `OPEN_ISSUES.md Open Issue 2 판별 완료 근거 (WSL vs Windows-native step5/10 대조, AR_BLAS 반증)`

## 차단 요인

- `없음 (PC2 compile 공정 비교는 Open Issue 1로 별도 blocked)`

## 마지막 인계

- 완료: 초기화 직후
- 근거: [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md)

## 상세 근거

- 우선순위·phase 상태: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
- 미해결 blocker: [OPEN_ISSUES.md](OPEN_ISSUES.md)
- 전체 브랜치 이력: [journal/INDEX.md](journal/INDEX.md)
