# CONTRACTS

> **curation 규칙**: append-only 로그가 아니다. 현재 유효한 계약만 유지하고, 대체된 계약의 근거는
> 별도 아카이브로 보존한다. 작업 중 서술은 브랜치 저널에, **머지 시 지속되는 것만** 여기로 승격한다.
> 여기에는 `## <date> update:` 서술 로그를 쌓지 않는다.

DB/API/persistence/file format/external integration 계약을 축별로 정리한다. 구현 세부보다 “무엇을 깨면 안 되는지”와 “저장/복원/호출 순서”를 고정한다.

## 공통 원칙

1. 기존 public API, 저장 데이터, 파일 포맷은 명시적 결정 없이 깨지 않는다.
2. 새 필드는 가능한 한 하위 호환을 유지하며 추가한다.
3. persistence 변경은 저장 경로와 복원 경로를 함께 문서화한다.
4. migration 또는 backfill이 필요하면 적용 순서와 rollback 가능성을 남긴다.

## 측정 프로토콜 계약 (벤치마크 비교 조건)

크로스 벤더 수치는 아래 고정 조건에서 측정한 것만 비교 대상으로 인정한다:

| 항목 | 고정값 | 비고 |
| --- | --- | --- |
| 지표 | val_bpb / tok/sec / mfu_percent / peak_vram_mb | train.py 최종 요약 출력 |
| 시간 예산 | 300s (TIME_BUDGET, prepare.py) | 워밍업 10 스텝 제외는 upstream 로직 유지 |
| 모델 | depth 8, vocab 8192, seq 2048 | upstream 기본값 |
| 유효 배치 | TOTAL_BATCH_SIZE 2^19 고정 | DEVICE_BATCH_SIZE는 장비별 튜닝 노브 (스필 없는 최대) |
| 어텐션 | 동일 조건 비교는 SDPA로 통일 (`AR_FORCE_SDPA=1`) | FA3/Triton 경로는 별도 축으로 측정 |
| MFU 분모 | train.py `get_bf16_peak_flops` 테이블 | 값 변경 시 과거 수치 재환산 필요 — 테이블 수정은 DECISIONS 기록 필수 |
| 기록 | 장비/OS/드라이버/torch 버전/env 플래그를 로그와 함께 저널에 | 예: 9070 XT/Win10/26.2.2급/2.9.1+rocm7.2.1 |

## API 계약

| API | 역할 | 요청 | 응답 | 권한/주의 |
| --- | --- | --- | --- | --- |
| `<METHOD /path>` | `<purpose>` | `<request shape>` | `<response shape>` | `<auth/notes>` |

## DB 계약

| 테이블/컬렉션 | 역할 | 주요 필드 | 주의 |
| --- | --- | --- | --- |
| `<table>` | `<purpose>` | `<fields>` | `<notes>` |

## Persistence 계약

| 축 | 저장 위치 | 저장 시점 | 복원 시점 | 호환성 |
| --- | --- | --- | --- | --- |
| `<domain>` | `<store>` | `<when>` | `<when>` | `<compat rule>` |

## 외부 연동 계약

| 시스템 | 용도 | 계약 | 장애/대체 흐름 |
| --- | --- | --- | --- |
| `<service>` | `<purpose>` | `<contract>` | `<fallback>` |
