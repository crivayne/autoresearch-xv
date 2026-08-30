# VALIDATION

재사용 가능한 **자동 검증 명령 카탈로그**와 **현재 전역 검증 상태(green/red 축 스냅샷)**만 담는 슬림 문서다.
날짜별 검증 서술은 브랜치 저널에 남기고 여기에는 쌓지 않는다.

> **단일 출처**: 진행 이력은 `CHANGELOG.md`, phase/slice 상태는 `IMPLEMENTATION_PLAN.md`에 둔다.
> 여기의 현재 전역 상태에는 각 검증 축의 지금 green/red/unknown만 기록한다.

## 기본 원칙

- 브라우저 수동 검증을 하지 못했으면 브라우저 동작 성공으로 단정하지 않는다.
- 가능한 가장 좁은 검증부터 수행한다.
- 라우트, 정적 파일, 빌드 산출물, API가 바뀌면 fresh server 또는 clean build로 확인한다.
- 검증 실패는 원인 가설과 다음 확인 방법을 브랜치 저널에 기록한다.

## 자동 검증 명령 카탈로그

```powershell
# 환경 확인 (venv: G:\venvs\rocm721, torch 2.9.1+rocm7.2.1)
G:\venvs\rocm721\Scripts\python.exe -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"

# 데이터/토크나이저 준비 (1회)
G:\venvs\rocm721\Scripts\python.exe prepare.py

# 5분 벤치 실행 (측정 지표: val_bpb / tok/sec / mfu_percent / peak_vram_mb)
# 환경변수: AR_NO_COMPILE=1 (compile 끔, Windows 필수 — Open Issue 1)
#           AR_DEVICE_BATCH_SIZE=N (기본 32), AR_FORCE_SDPA=1 (NVIDIA에서 SDPA 강제)
$env:AR_NO_COMPILE = "1"
G:\venvs\rocm721\Scripts\python.exe -u train.py

# 문서 시스템
node scripts/worklog.js check
```

## 현재 전역 상태

| 축 | 상태 | 메모(마지막 확인) |
| --- | --- | --- |
| 환경(torch+gfx1201) | green | 2026-08-30, is_available True, matmul OK |
| prepare.py | green | 2026-08-30, 11 shards + vocab 8192 |
| train.py eager | green | 2026-08-30 **베이스라인 bs16**: val_bpb 1.8637 / ~102K tok/s / MFU 25.42% / peak 12.0GB. (bs32: 스필로 MFU 9.0%, bs8: 동속·bpb 1.9225) |
| train.py compile | red | 2026-08-30, Windows Triton 부재 (Open Issue 1) |

## Stale Server 체크

- 개발 서버 재시작이 필요한 변경인지 확인한다.
- 브라우저 hard reload 또는 cache disable 상태에서 재확인한다.
- API 응답과 정적 asset timestamp/hash가 최신인지 확인한다.
