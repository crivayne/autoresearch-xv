# OPEN_ISSUES

아직 닫히지 않은 이슈, 남은 수동 검증, root cause가 확정되지 않은 문제를 모은다.

## 기록 형식

```md
## Open Issue N. <title>

- 상태: <tracking|blocked|pending-validation|deferred>
- 항목: <short description>
- 관련 파일: <paths>
- 현재 판단: <known facts>
- 다음 확인: <next action>
```

## Open Issues

## Open Issue 1. Windows ROCm에서 torch.compile 불가 (Triton 부재)

- 상태: blocked (Windows 한정)
- 항목: torch.compile(Inductor) 실행 시 `ModuleNotFoundError: No module named 'triton'` (Inductor GEMM 튜닝이 triton.runtime.driver 요구). repo.radeon.com rocm-rel-7.2.1 Windows 릴리스에 Triton 휠 미포함 확인 (2026-08-30, 휠 6종뿐)
- 관련 파일: train.py (`_maybe_compile`, `AR_NO_COMPILE`), 실행 로그는 로컬 기록 저장소에 보관
- 현재 판단: Windows 네이티브 경로는 eager 실행만 가능 → andyluo7 포크의 eager MFU 3%대 한계를 Windows에서는 벗어날 수 없음. "효율화 본편은 Linux(1c 듀얼부팅)" 판단을 뒷받침. triton-windows(커뮤니티 빌드)는 NVIDIA 중심이라 ROCm 백엔드 검증 필요, TheRock 나이틀리(경로 B)는 triton 포함 가능성 있으나 안정성 미검증
- 다음 확인: eager 베이스라인 확보 후, (a) TheRock/멀티아치 휠의 Windows triton 동봉 여부 (b) WSL2 경로의 compile 가능 여부 중 택일 조사
