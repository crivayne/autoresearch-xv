# DECISIONS

> **curation 규칙**: append-only 로그가 아니다. 대체 시 옛 항목을 `DECISIONS_ARCHIVE.md`로 옮기고
> 라이브 문서에는 날짜·제목·아카이브 링크 한 줄을 남긴다. 작업 중 서술은 브랜치 저널에,
> **머지 시 지속되는 것만** 여기로 승격한다. 여기에는 `## <date> update:` 서술 로그를 쌓지 않는다.

확정된 아키텍처 결정만 기록한다. 긴 분석, 논쟁 과정, 임시 아이디어는 필요한 경우 epic/archive 문서에 남기고 이 문서에는 결론과 이유, 영향 범위만 적는다.

## 기록 형식

```md
## YYYY-MM-DD | <decision title>

- 결정: <what was decided>
- 이유: <why this is the preferred direction>
- 영향 범위: <files/modules/contracts affected>
- 대안/보류: <optional alternatives or deferred work>
```

## 결정 목록

## 2026-08-30 | 크로스 벤더 단일 소스 원칙 및 어텐션 폴백

- 결정: upstream(karpathy/autoresearch) train.py를 단일 소스로 유지하며 벤더 분기 최소화. FA3 커널 로드는 try/except — NVIDIA에서 가능하면 FA3, 실패·ROCm이면 PyTorch SDPA(full causal) 폴백. MFU 피크 FLOPS는 디바이스명 테이블(`get_bf16_peak_flops`)로 조회. `AR_FORCE_SDPA=1`(NVIDIA에서도 SDPA 강제, 공정 비교용), `AR_NO_COMPILE=1`(torch.compile 전면 비활성) 탈출구 제공
- 이유: 연구 질문이 "단일 소스가 벤더별 수제 최적화 대비 얼마나 적은 손해인가"이므로 포크 분기 대신 런타임 선택. andyluo7 포크 패턴(SDPA 대체, compile 비활성) 참조하되, PT 2.9.1이므로 compile은 기본 활성
- 영향 범위: train.py (어텐션 forward, MFU 계산, DEVICE_BATCH_SIZE 128→32, 옵티마이저 compile 데코레이터)
- 대안/보류: SDPA에서 sliding window(SSSL) 미지원 → full causal로 저하 수용. 추후 Triton FA2(`FLASH_ATTENTION_TRITON_AMD_ENABLE`) 또는 flex_attention으로 window 복원 검토

## 2026-08-30 | 자동 실험 루프의 무인 커밋 예외

- 결정: autoresearch 에이전트 밤샘 루프가 만드는 실험 커밋은 프리셋의 "커밋 전 사용자 확인" 원칙의 예외로 한다. 실험 커밋은 실험 브랜치에 한정하고, main 반영은 사용자 확인 유지
- 이유: 무인 자동 실험이 이 프로젝트의 본질 기능이므로 원칙과 정면 충돌 (프로젝트 착수 시 사전 합의됨)
- 영향 범위: 브랜치 전략, worklog 운영
- 대안/보류: 실험→DECISIONS/CHANGELOG 승격 다리는 구동 성공 후 설계
