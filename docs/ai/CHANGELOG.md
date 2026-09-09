# CHANGELOG

**slice/마일스톤 단위 요약**을 담는 단일 연대기 문서다. 브랜치 저널이 진실(full 진행/검증 서술)이고,
이 문서는 저장소 전체를 가로지르는 요약이다. 머지되거나 의미 있는 마일스톤에 도달한 slice마다
아래 3줄(변경/검증/문서)로 짧게 남긴다.

## 기록 형식

```md
## YYYY-MM-DD

- 변경: <this slice/milestone에서 바뀐 것>
- 검증: <validation summary>
- 문서: <files updated>
```

## 2026-09-09

- 변경: 자동 실험 루프 무인 밤샘 완주(감독 1 + 밤샘 1). 예산 특화 축 최적화로 val_bpb 1.5054(baseline) → 1.1177 (52실험 keep8/discard41/crash3). 표준 레시피 축(1.5039)은 불변.
- 검증: results.tsv 회수·판독 완료. 최고 config depth4/width512/batch64/total 2^17, MFU ~48.9%. 크래시는 전부 예상된 OOM(width640/depth5@batch64).
- 문서: DECISIONS(승격 다리·이중 축 규칙), VALIDATION(예산 특화 축 행 추가)

