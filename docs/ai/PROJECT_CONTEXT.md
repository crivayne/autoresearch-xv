# PROJECT_CONTEXT

이 문서는 프로젝트의 고정 배경, 목표, 도메인 개념을 요약하는 공통 진입점이다. 자주 바뀌는 진행 로그나 일시적인 구현 방향은 이 문서에 넣지 않는다.

## 프로젝트 개요

- 프로젝트 이름: `autoresearch-xv`
- 한 줄 설명: `karpathy/autoresearch를 NVIDIA/AMD 벤더 무관 단일 소스로 유지하며, 고정 시간 예산에서 벤더 간 학습 효율 격차를 재현 가능하게 측정하는 포크`
- 주요 사용자: `크로스 벤더(특히 RDNA4/ROCm) LLM 학습 효율에 관심 있는 연구자·엔지니어`
- 주요 실행 환경: `CLI (train.py 5분 예산 벤치, prepare.py). 품질 측정은 Linux(Ubuntu + ROCm/CUDA), Windows는 추론·인프라`
- 주요 기술 스택: `PyTorch 2.9.1, torch.compile(Inductor)+Triton, SDPA/FA3 폴백, Muon/NorMuon 옵티마이저, Python`

## 목표

1. `upstream train.py를 벤더 분기 최소의 단일 소스로 유지 (런타임 선택: FA3↔SDPA, compile on/off, MFU 피크 테이블)`
2. `고정 시간 예산에서 벤더별(NVIDIA/AMD) 효율 지표(val_bpb / tok·s / MFU / peak VRAM) 격차를 재현 가능하게 측정`
3. `자동 실험 루프로 플랫폼별 레시피를 탐색하고, 재현·확정된 결정만 문서로 승격`

## 비목표

- `범용 학습 프레임워크화 (스코프 가드레일: "이 실험에 필요해서 만드나?"가 판별 기준)`
- `upstream 대비 대규모 아키텍처 재설계`

## 도메인 개념

| 개념 | 의미 | 관련 파일/모듈 |
| --- | --- | --- |
| 표준 레시피 축 | 고정 아키텍처, 크로스 벤더 비교의 기준선 | `docs/ai/VALIDATION.md`, `docs/ai/DECISIONS.md` |
| 예산 특화 축 | 고정 시간 예산 하 스텝수/스케일 최적화 (크로스 벤더 비교 미사용) | `docs/ai/VALIDATION.md` |
| 자동 실험 루프 | 무인 가설→수정→커밋→실행→판독→keep/revert | `docs/ai/DECISIONS.md`, `program.md` |
| MFU 피크 테이블 | 디바이스명 → bf16 peak FLOPS 조회 | `train.py` (`get_bf16_peak_flops`) |

## 시스템 구성

- Frontend: `해당 없음 (CLI 연구 코드)`
- Backend: `train.py (학습·벤치), prepare.py (데이터 shard 다운로드 + BPE 토크나이저)`
- Data: `karpathy/climbmix-400b-shuffle parquet shards + BPE vocab 8192 (검증 shard 06542 고정)`
- External services: `없음 (로컬 GPU 실행). 문서 시스템은 scripts/worklog.js`

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
