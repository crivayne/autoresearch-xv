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

## Open Issue 1. Windows에서 torch.compile 불가 — 양 벤더 공통 (Triton 부재)

- 상태: blocked (Windows 한정)
- 갱신(2026-08-30): **NVIDIA(3060 Ti, cu128 휠)에서도 동일 확인** — `torch._inductor.exc.TritonMissing`. PyTorch Windows 휠은 벤더 불문 Triton 미동봉. Windows 비교는 양쪽 eager로 공평, compile 축 측정은 Linux/WSL2 필요. NVIDIA는 커뮤니티 `triton-windows` 패키지 시도 여지 있음
- 항목: torch.compile(Inductor) 실행 시 `ModuleNotFoundError: No module named 'triton'` (Inductor GEMM 튜닝이 triton.runtime.driver 요구). repo.radeon.com rocm-rel-7.2.1 Windows 릴리스에 Triton 휠 미포함 확인 (2026-08-30, 휠 6종뿐)
- 관련 파일: train.py (`_maybe_compile`, `AR_NO_COMPILE`), 실행 로그는 로컬 기록 저장소에 보관
- 현재 판단: Windows 네이티브 경로는 eager 실행만 가능 → andyluo7 포크의 eager MFU 3%대 한계를 Windows에서는 벗어날 수 없음. "효율화 본편은 Linux(1c 듀얼부팅)" 판단을 뒷받침. triton-windows(커뮤니티 빌드)는 NVIDIA 중심이라 ROCm 백엔드 검증 필요, TheRock 나이틀리(경로 B)는 triton 포함 가능성 있으나 안정성 미검증
- 다음 확인: eager 베이스라인 확보 후, (a) TheRock/멀티아치 휠의 Windows triton 동봉 여부 (b) WSL2 경로의 compile 가능 여부 중 택일 조사

## Open Issue 2. ROCm eager의 스텝별 수렴 열세 (수치 정밀도 의심)

- 상태: tracking — **우선순위 높음**
- 갱신(2026-08-30): PC1 동일 조건 재실행으로 **체계적 차이 확정** — 런 간 val_bpb 차 0.003(1.9225→1.9192, 스텝 손실 소수 3자리 일치) vs 벤더 간 차 0.18 (분산의 60배). 진단 노브 추가: `AR_SDPA_FP32=1`(어텐션만 fp32), `AR_NO_AUTOCAST=1`(전체 fp32)
- 갱신(2026-08-31) 진단 결과 종합:
  - 무죄 확정: 토크나이저/데이터(해시 일치, 로더 결정적), 초기화 RNG(동일 수열, 말단 비트만 차이), 어텐션(fp32화 무변화), matmul 누적 플래그(무변화, no-op 가능성), Muon 직교화(fp32화 무변화)
  - 시드 분산 측정(PC1, 시드 42/43/123): val_bpb σ≈0.02, step10 σ≈0.08, step20 σ≈0.06 → **벤더 격차(bpb 0.18~0.22)는 ~10σ, 시드 노이즈 아님**
  - 전체 fp32(autocast off)는 양 벤더 모두 개선하나 fp32끼리도 격차 잔존(step10: 7.09 vs 6.42) → 단일 연산 정밀도가 아닌 구조적 차이
  - 한계: PC1 내부 A/B는 "PC1 전 경로 공통 결함"(예: 특정 op backward가 모든 구성에서 동일하게 부정확)을 배제 못함
- **판별 완료(2026-09-02): 범인 = Windows ROCm 7.2.1 SDK 커널 라이브러리 전반.** WSL(Linux ROCm 스택, 같은 GPU·시드·데이터)에서 step5 7.69/step10 6.74로 NVIDIA(8.17/7.02)보다도 우수 — Windows 네이티브(8.11/7.25)만 열세. Windows에서 `AR_BLAS=cublas` 무변화로 hipBLASLt 단독 범인설은 반증. 런타임 노브로 우회 불가 → 품질 비교·효율화는 Linux 스택 한정 (듀얼부팅 이행). 업스트림 보고 후보
- 파생 이슈: WSL에서 hipBLASLt `HIPBLAS_STATUS_INTERNAL_ERROR`(rocBLAS 폴백), WSL 실효 성능 ~764 tok/s로 실용 불가
- 항목: 동일 커밋·조건(SDPA eager bs8, seed 42)에서 9070 XT가 3060 Ti 대비 스텝별 손실 하강이 체계적으로 느림. step 0~5는 근사 일치(9.01 동일 출발) → step 10부터 벌어짐(step 20: 6.41 vs 5.93, step 44: 5.81 vs 5.06). 결과적으로 PC1이 1.55배 토큰을 쓰고도 val_bpb 열세(1.9225 vs 1.7422)
- 관련 파일: train.py (norm/SDPA/muon_step_fused의 bf16 경로), 로그는 로컬 기록 저장소
- 현재 판단: 시간 예산 고정으로 LR/WD 스케줄이 스텝축에서 다른 효과가 섞여 있으나, lrm=1.00 구간에서 이미 벌어지므로 스케줄만으로 설명 부족. ROCm 쪽 연산 정밀도(SDPA backward, rms_norm, bf16 축적) 의심
- 다음 확인: ① PC1 동일 조건 재실행으로 런 간 분산 측정 (분산 작으면 체계적 차이 확정) ② 확정 시 연산별 분리 테스트 (SDPA만 fp32, norm만 fp32 등) — 이것 자체가 A-1의 "조용한 폴백/정밀도 함정" 연구 소재

## Open Issue 3. kernels 라이브러리 API 변경으로 FA3 로드 실패 (NVIDIA)

- 상태: deferred (minor)
- 항목: kernels 0.16.x에서 `get_kernel()`이 version/revision 명시 요구 → upstream 코드(>=0.11.7 가정)와 비호환. 3060 Ti에서 SDPA로 자동 폴백돼 벤치는 진행됨
- 다음 확인: `kernels==0.11.*` 고정 또는 `get_kernel(repo, version=...)` 수정. FA3 축 측정이 필요해질 때 처리
