#!/usr/bin/env node
// scripts/worklog.js
// Branch-journal helper for the AGENT docs system.
// CJS로 작성됐다 — 호스트 package.json이 "type": "module"이어도 동작하도록 scripts/package.json이
// 이 폴더를 "type": "commonjs"로 고정한다. scripts/를 복사할 때 그 파일도 함께 가져가야 한다.
//   node scripts/worklog.js new [slug]  - scaffold docs/ai/journal/<date>_<slug>[-N].md for the
//                                         current git branch and rebuild INDEX.md. If the branch
//                                         already has an active journal, points at it instead of
//                                         splitting the branch across multiple files.
//   node scripts/worklog.js close [target] [--status <terminal-status>]
//                                       - move a branch's active journal to merged (default),
//                                         abandoned, or cancelled and rebuild INDEX.md. Canonical order is
//                                         merge first, then close from the default branch with an
//                                         explicit target (branch name, journal file, or slug) —
//                                         that also works after the source branch is deleted.
//                                         With no target it closes the CURRENT branch's journal;
//                                         non-merge outcomes must be selected explicitly with --status.
//   node scripts/worklog.js index       - rebuild INDEX.md from journal front-matter (idempotent)
//   node scripts/worklog.js check       - warn if shared state docs exceed their LF-normalized byte cap
//                                         (verify with `wc -c` on LF-normalized content), if the required-read docs together
//                                         exceed the configured session budget (root AGENTS/CLAUDE included — they
//                                         cost session budget too), or accumulate dated
//                                         narrative logs (append-only drift). It exits 1 when the
//                                         distributed preset structure, required initial context,
//                                         journal front matter schema, or high-confidence credentials in
//                                         AI memory are invalid. It also compares distributed machine files
//                                         with the applied preset's local hash baseline, accepts only exact
//                                         project-declared differences, and never rewrites either side. Date-H2 rules are
//                                         per-doc: DECISIONS/CONTRACTS allow the canonical
//                                         "## <date> | title" entry heading; PROJECT_CONTEXT/
//                                         VALIDATION/CURRENT_TASK/IMPLEMENTATION_PLAN/OPEN_ISSUES
//                                         forbid any date H2; CHANGELOG's date H2 is its own format,
//                                         but "## <date> update:" narrative logs are flagged in
//                                         every doc, CHANGELOG included (always-on check).
//                                         Also soft-warns if cumulative-progress tokens (milestones,
//                                         test counts, "done") creep into VALIDATION's green/red
//                                         "현재 전역 상태" section (their home is CHANGELOG), if
//                                         INDEX.md is missing or no longer matches the journals
//                                         (it is a generated artifact — `check` rebuilds the body
//                                         via the shared `buildIndexLines()` and compares), and if
//                                         the journal title placeholder is still sitting in a
//                                         journal's front-matter or in INDEX.md (title filled in but
//                                         `index` never re-run).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const PRESET_MANIFEST_FILE = '.ai-preset.json';
const PRESET_LOCK_FILE = '.ai-preset-lock.json';
const PRESET_DRIFT_CONFIG_RELATIVE = 'scripts/preset-drift.config.js';
const PRESET_DRIFT_CONFIG_FILE = path.join(REPO_ROOT, PRESET_DRIFT_CONFIG_RELATIVE);
const PRESET_LOCK_SCHEMA_VERSION = 1;
const PRESET_DRIFT_CONFIG_SCHEMA_VERSION = 1;
// 상태 문서와 프로젝트별 설정은 적용 뒤 달라지는 것이 정상이다. 아래 파일만 프리셋이 배포하는
// 기계 정본으로 보고, 같은 버전의 `.ai-preset-lock.json`에 든 LF 정규화 SHA-256과 비교한다.
// lock은 자기 자신을 해시하지 않아 갱신 순환을 피하고, 차이 선언 설정은 프로젝트 소유라 제외한다.
const MANAGED_PRESET_FILES = Object.freeze([
  PRESET_MANIFEST_FILE,
  'AGENTS.md',
  'CLAUDE.md',
  'scripts/package.json',
  'scripts/preset-manifest.js',
  'scripts/worklog.js',
]);
const AI_DIR = path.join(REPO_ROOT, 'docs', 'ai');
const JOURNAL_DIR = path.join(AI_DIR, 'journal');
const TEMPLATE = path.join(JOURNAL_DIR, '_TEMPLATE.md');
const INDEX = path.join(JOURNAL_DIR, 'INDEX.md');

// `new`가 심는 제목 자리표시자. `check`가 이 문구로 "채우지 않은 저널"과 "채웠지만 INDEX를
// 재생성하지 않은 상태"를 잡으므로, 폴백 템플릿과 검사가 같은 상수를 본다.
// `_TEMPLATE.md`를 고칠 때는 이 값도 함께 맞춘다.
const TITLE_PLACEHOLDER = 'TODO 한 줄 slice 제목';
const JOURNAL_FRONT_MATTER_KEYS = ['branch', 'date', 'status', 'slice'];
const JOURNAL_FRONT_MATTER_KEY_SET = new Set(JOURNAL_FRONT_MATTER_KEYS);
const TERMINAL_JOURNAL_STATUS_VALUES = new Set(['merged', 'abandoned', 'cancelled']);
const JOURNAL_STATUS_VALUES = new Set(['active', ...TERMINAL_JOURNAL_STATUS_VALUES]);

// Shared state docs and their date-H2/session policies. Project-calibrated byte caps live in
// scripts/worklog.config.js so this engine can be replaced without overwriting local measurements:
//   'pipe'   - date H2 is only legitimate as the canonical entry heading "## <date> | title";
//              any other "## <date> ..." is narrative-log drift. (DECISIONS/CONTRACTS)
//   'forbid' - no date H2 belongs here at all; any "## <date> ..." is drift. (curated/pointer docs)
//   'allow'  - date H2 is the doc's own format; never flag it. (CHANGELOG)
//
// 규모는 **줄이 아니라 LF로 정규화한 바이트**로 잰다.
//
// 줄 수를 버린 이유: 문서마다 뜻이 다르다. 자매 프로젝트 실측 평균 줄 길이가 AGENTS 63자 /
// OPEN_ISSUES 71자 / CONTRACTS 140자 / DECISIONS 239자 / CHANGELOG 381자로 **3.8배까지 벌어져**,
// 종전 줄 cap에서는 크기가 똑같이 135KB인 DECISIONS(456줄)는 걸리고 CHANGELOG(294줄)는 통과했다.
// 게다가 줄 cap은 **줄을 길게 쓰면 통과**되는 역인센티브가 있다.
//
// "문자"가 아니라 바이트인 이유: JS `String.length`는 UTF-16 코드 단위라 이모지(surrogate pair)에서
// 코드 포인트와 어긋나고, 코드 포인트·grapheme 중 무엇을 "문자"로 볼지도 합의가 필요하다.
// 바이트는 그 논쟁이 없고 LF로 정규화한 내용의 `wc -c`로 **누구나 같은 값을 확인**할 수 있다.
// 작업 트리의 raw 크기는 Windows `core.autocrlf=true`에서 줄마다 1B씩 커지므로 같은 커밋도 OS마다
// 다른 cap 판정을 낸다. 체크아웃 정책 전체를 바꾸지 않고 측정 경계에서만 CRLF를 LF로 본다.
//
// `session: true` = AGENTS.md "작업 시작 전 기본 읽기"의 고정 대상. `conditionalSession: true`인
// `NEXT_WORK.md`는 현재 브랜치의 활성 저널이 없을 때만 합산한다. 나머지 cap의 근거는 문서 가독성이다.
/** 1KB = 1024B. cap을 이 단위로 적어야 표기(`kb()`)와 값이 어긋나지 않는다 — 130000을 적고
 *  `127KB`가 찍히면 읽는 사람이 둘 중 무엇이 기준인지 알 수 없다. */
const KB = 1024;

/**
 * cap을 넘었을 때 **무엇을 하라고 말할지**. 종전에는 모든 문서에 "DECISIONS_ARCHIVE.md 등으로
 * 이관 권장"이라는 한 문구를 썼는데, 아카이브 파일이 있는 문서는 `DECISIONS.md` 하나뿐이라
 * 나머지 7개는 **존재하지 않는 목적지**를 안내받았다. 안내가 행동으로 이어지지 않으면 경고는
 * 소음이 되고, 실제로 그렇게 무시된 사례가 파생 저장소에서 나왔다(역류).
 *
 * 그래서 문서마다 처방을 따로 둔다. 아카이브가 **없는** 문서에는 "어디로 옮겨라" 대신
 * **무엇을 덜어내라**를 적는다 — 그쪽이 그 문서가 커지는 실제 원인이다.
 *
 * 처방을 쓸 때의 기준: **옮긴 뒤에도 찾을 수 있는가까지 말해야 한다.** "어디로 옮겨라"만 적으면
 * 이력이 조용히 사라진다. 이 저장소에서 **헤더가 이관 방법을 스스로 담은 문서는 `DECISIONS.md`
 * 하나뿐**이므로(실측), 나머지는 처방이 발견 경로까지 말한다 — `CONTRACTS`는 아카이브를 만들 때
 * 본문에서 링크하라고, `CHANGELOG`는 상단에 기간 링크를 남기라고 적는다(`journal/INDEX.md`는
 * `_archive/`를 색인하지 않는다).
 */
const CAP_REMEDY = {
  'PROJECT_CONTEXT.md': '설계 서술이 섞였는지 본다 — 배경이 아닌 것은 DECISIONS/CONTRACTS로.',
  'CURRENT_TASK.md': '여기에 slice를 다시 쓰는 중이다 — 브랜치 저널로 옮긴다.',
  'NEXT_WORK.md': '상세 계획·진행 로그를 덜어낸다 — phase 상태는 IMPLEMENTATION_PLAN, 이슈 본문은 OPEN_ISSUES, 작업 서술은 브랜치 저널에 둔다.',
  'DECISIONS.md':
    '대체·정착된 결정을 DECISIONS_ARCHIVE.md로 이관하되 **판정 전에 두 가지를 본다.** '
    + '① **인바운드 참조를 센다** — 다른 라이브 문서가 `[날짜 DECISIONS](DECISIONS.md)` 로 가리키는 '
    + '결정을 옮기면 **그 링크가 끊긴다.** ② **"CONTRACTS에 같은 날짜 항목이 있다"는 근거가 아니다** '
    + '— 같은 날 전혀 다른 주제일 수 있다. 내용이 실제로 대응하는지 본다. '
    + '그리고 **옮긴 자리에 한 줄 스텁(날짜 + 제목 + 아카이브 링크)을 남긴다** — 본문만 옮기면 다음 '
    + '세션은 그 결정이 **존재한다는 사실 자체를 모르고**, 모르면 찾아보지도 않는다(grep 하면 나오지만 '
    + 'grep 할 생각을 못 한다). **판정을 정교하게 만드는 것보다 스텁이 싸고 튼튼하다** — 판정이 틀려도 '
    + '정보가 사라지지 않는다.',
  'CONTRACTS.md':
    '대체된 계약을 CONTRACTS_ARCHIVE.md 로 이관한다(없으면 만든다). 만들면 **CONTRACTS.md 헤더에서 '
    + '링크하고 헤딩 형식은 그대로 둔다** — 링크가 없으면 필수 읽기 경로에서 발견되지 않고, '
    + '헤딩을 바꾸면 grep 으로도 못 찾는다.',
  'VALIDATION.md': '진행 이력이 재유입됐는지 본다 — 그건 CHANGELOG의 몫이다.',
  'IMPLEMENTATION_PLAN.md': 'phase 구조 외의 서술을 덜어낸다 — 상세는 저널에 있다.',
  'OPEN_ISSUES.md':
    '해소된 항목은 본문을 지우고 문서 끝 "해소된 항목" 절에 **한 줄 스텁**(번호 + 무엇이 닫혔나 + '
    + '날짜)만 남긴다 — 경위의 단일 출처는 CHANGELOG 와 저널이다. **번호는 재사용·재번호하지 '
    + '않는다**(저널·CHANGELOG·DECISIONS·코드 주석이 번호로 참조한다). 활성 트래커 본문에 해소 '
    + '항목을 남겨 두면 미해결과 섞여 트래커 구실을 잃는다. **스텁화 전에 그 본문에 미해결이 '
    + '얹혀 있는지 본다 — 닫는 순간 같이 사라진다.** 얹혀 있으면 별도 항목으로 승격하고 닫는다. '
    + '부분 해소는 아예 닫지 말고 **해소된 서술만** 포인터로 줄인다.',
  'CHANGELOG.md':
    '오래된 기간을 journal/_archive/(없으면 만든다) 로 잘라 내되 **CHANGELOG 상단에 "기간 → 파일" 링크를 남긴다** — '
    + 'journal/INDEX.md 는 _archive/ 를 색인하지 않으므로 포인터가 없으면 단일 연대기가 '
    + '찾을 수 없는 곳으로 갈라진다(연대기라 삭제하지 않는다). **항목 하나가 계속 커지면 이관보다 '
    + '먼저 볼 것이 있다 — 요약이 아니라 연대기를 쓰고 있는 것이다.** slice 당 3줄이 규정이고 '
    + 'full 서술은 브랜치 저널의 몫이다. 리뷰 라운드마다 문장을 잇다 보면 그렇게 된다.',
};

/**
 * 처방을 여러 줄로 접어 낸다. **처방을 짧게 쓰는 대신 출력을 접는다** — cap 처방은 함정을 알려
 * 주는 것이 일인데, 한 줄로 뭉개지면 읽히지 않아 없는 것과 같아진다(2026-08-24 실측: 가장 긴
 * 처방이 한 줄 500자였다). 한글은 폭이 2인 글자가 섞이므로 코드 포인트가 아니라 **표시 폭**으로 잰다.
 *
 * **이어지는 줄에도 `[soft]` 를 붙인다.** `check` 출력을 `grep '[soft]'` 로 걸러 보는 것이 문서화된
 * 사용법인데, 태그 없는 들여쓰기로 접으면 **머리줄만 남고 처방이 통째로 걸러진다** — 접기 전보다
 * 나빠진다. 태그가 앞에 붙으면 정렬은 조금 덜 예쁘지만 **필터를 쓰는 사람이 처방을 잃지 않는다.**
 */
function wrapRemedy(text, width = 84, indent = '[soft]   ') {
  const w = (ch) => (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1);
  const lines = [];
  let cur = '';
  let curW = 0;
  for (const word of String(text).split(' ')) {
    const ww = [...word].reduce((a, ch) => a + w(ch), 0);
    if (cur && curW + 1 + ww > width) { lines.push(cur); cur = word; curW = ww; }
    else { cur = cur ? `${cur} ${word}` : word; curW += (cur === word ? 0 : 1) + ww; }
  }
  if (cur) lines.push(cur);
  return lines.map((l) => indent + l).join('\n');
}

const SHARED_DOCS = [
  { file: 'PROJECT_CONTEXT.md', dates: 'forbid', session: true },
  { file: 'CURRENT_TASK.md', dates: 'forbid' },
  { file: 'NEXT_WORK.md', dates: 'forbid', conditionalSession: true },
  { file: 'DECISIONS.md', dates: 'pipe', session: true },
  { file: 'CONTRACTS.md', dates: 'pipe', session: true },
  { file: 'VALIDATION.md', dates: 'forbid', session: true },
  { file: 'IMPLEMENTATION_PLAN.md', dates: 'forbid' },
  { file: 'OPEN_ISSUES.md', dates: 'forbid' },
  { file: 'CHANGELOG.md', dates: 'allow' },
];

const SIZE_POLICY_RELATIVE = 'scripts/worklog.config.js';
const SIZE_POLICY_FILE = path.join(REPO_ROOT, SIZE_POLICY_RELATIVE);
const SIZE_POLICY_SCHEMA_VERSION = 1;

// 구버전 파생 저장소가 설정 파일 없이 `worklog.js`만 갱신해도 종전 판정을 유지하기 위한 호환값이다.
// 새 프로젝트와 프로젝트별 보정의 정본은 `worklog.config.js`이며, 근거 주석도 그 파일에만 둔다.
const FALLBACK_SIZE_POLICY = Object.freeze({
  schemaVersion: SIZE_POLICY_SCHEMA_VERSION,
  documentCaps: Object.freeze({
    'PROJECT_CONTEXT.md': 8 * KB,
    'CURRENT_TASK.md': 2 * KB,
    'NEXT_WORK.md': 4 * KB,
    'DECISIONS.md': 32 * KB,
    'CONTRACTS.md': 24 * KB,
    'VALIDATION.md': 8 * KB,
    'IMPLEMENTATION_PLAN.md': 12 * KB,
    'OPEN_ISSUES.md': 16 * KB,
    'CHANGELOG.md': 48 * KB,
  }),
  sessionBudget: 64 * KB,
  adapterMaxBytes: 4 * KB,
});

function sizePolicyIssues(policy) {
  const issues = [];
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return ['module.exports는 설정 객체여야 합니다.'];
  }

  const expectedTopKeys = ['schemaVersion', 'documentCaps', 'sessionBudget', 'adapterMaxBytes'];
  for (const key of expectedTopKeys) {
    if (!Object.prototype.hasOwnProperty.call(policy, key)) issues.push(`필수 key 누락: ${key}`);
  }
  for (const key of Object.keys(policy)) {
    if (!expectedTopKeys.includes(key)) issues.push(`알 수 없는 key: ${key}`);
  }
  if (policy.schemaVersion !== SIZE_POLICY_SCHEMA_VERSION) {
    issues.push(`schemaVersion은 ${SIZE_POLICY_SCHEMA_VERSION}이어야 합니다.`);
  }

  const caps = policy.documentCaps;
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
    issues.push('documentCaps는 문서별 cap 객체여야 합니다.');
  } else {
    const expectedFiles = SHARED_DOCS.map(({ file }) => file);
    for (const file of expectedFiles) {
      if (!Object.prototype.hasOwnProperty.call(caps, file)) {
        issues.push(`documentCaps 필수 key 누락: ${file}`);
      } else if (!Number.isSafeInteger(caps[file]) || caps[file] <= 0) {
        issues.push(`documentCaps.${file}: 양의 정수 바이트여야 합니다.`);
      }
    }
    for (const file of Object.keys(caps)) {
      if (!expectedFiles.includes(file)) issues.push(`documentCaps 알 수 없는 key: ${file}`);
    }
  }

  for (const key of ['sessionBudget', 'adapterMaxBytes']) {
    if (Object.prototype.hasOwnProperty.call(policy, key)
        && (!Number.isSafeInteger(policy[key]) || policy[key] <= 0)) {
      issues.push(`${key}: 양의 정수 바이트여야 합니다.`);
    }
  }
  return issues;
}

function loadSizePolicy() {
  if (!fs.existsSync(SIZE_POLICY_FILE)) {
    return { policy: FALLBACK_SIZE_POLICY, issues: [] };
  }
  if (!fs.statSync(SIZE_POLICY_FILE).isFile()) {
    return {
      policy: FALLBACK_SIZE_POLICY,
      issues: ['설정 경로가 일반 파일이어야 합니다.'],
    };
  }
  let policy;
  try {
    policy = require(SIZE_POLICY_FILE);
  } catch (error) {
    return {
      policy: FALLBACK_SIZE_POLICY,
      issues: [`설정 모듈을 불러올 수 없습니다: ${error.code || error.message || error}`],
    };
  }
  const issues = sizePolicyIssues(policy);
  return {
    policy: issues.length ? FALLBACK_SIZE_POLICY : policy,
    issues,
  };
}

/**
 * 공통 정본 + Claude adapter import chain의 세션 비용. AGENTS.md 자체에는 개별 cap을 두지 않는다.
 */
const ROOT_SESSION_DOCS = ['AGENTS.md', 'CLAUDE.md'];
const REQUIRED_ADAPTER_IMPORTS = {
  'CLAUDE.md': '@AGENTS.md',
};
const AI_MEMORY_ROOT_DOCS = ['AGENTS.md', ...Object.keys(REQUIRED_ADAPTER_IMPORTS)];

// `init-preset.js` 배포물의 필수 core 구조 계약. 프로젝트 설정 2개와 lock은 구버전 파생 저장소가
// 엔진만 갱신해도 동작하도록 제외한다. 규모 설정·차이 선언이 존재하지만 invalid면 hard, lock 부재는
// soft이며 invalid면 hard다. 경로는 오류 출력이 OS와 무관하게 복사 계획/문서 표기와 같도록 `/`로 둔다.
const REQUIRED_PRESET_FILES = [
  PRESET_MANIFEST_FILE,
  'AGENTS.md',
  'CLAUDE.md',
  'scripts/worklog.js',
  'scripts/preset-manifest.js',
  'scripts/package.json',
  ...SHARED_DOCS.map(({ file }) => `docs/ai/${file}`),
  'docs/ai/DECISIONS_ARCHIVE.md',
  'docs/ai/journal/INDEX.md',
  'docs/ai/journal/_TEMPLATE.md',
];

// 새 프로젝트에서 세션 방향을 정하는 데 필요한 최소 초기 입력만 강제한다. CONTRACTS의 예시 행,
// VALIDATION의 unknown 상태, 시스템 구성의 선택적 항목까지 일반 `<...>` 패턴으로 전부 잡으면
// 프로젝트마다 필요 없는 항목을 억지로 채우게 되므로 정확한 marker만 열거한다. 목표 줄이 필요 없으면
// placeholder를 다른 말로 바꾸는 대신 그 줄을 삭제해도 된다(검사는 marker 잔존만 본다).
const REQUIRED_PLACEHOLDERS = {
  'docs/ai/PROJECT_CONTEXT.md': [
    '<project-name>',
    '<what this project does>',
    '<target users>',
    '<browser/server/cli/mobile/etc.>',
    '<frontend/backend/db/runtime/etc.>',
    '<goal-1>',
    '<goal-2>',
    '<goal-3>',
  ],
  'docs/ai/NEXT_WORK.md': [
    '<ready|blocked|none>',
    '<next-work>',
    '<why-now>',
    '<first-check>',
    '<blockers-or-none>',
  ],
};

const REQUIRED_PLACEHOLDER_REMEDY = {
  'docs/ai/PROJECT_CONTEXT.md': '실제 값으로 바꾸거나 필요 없는 목표 줄은 삭제하세요.',
  'docs/ai/NEXT_WORK.md': '실제 값으로 바꾸고, 다음 작업이 없으면 상태와 작업을 none/없음으로 명시하세요.',
};

/** 바이트를 KB로 표기한다. LF 정규화 내용의 `wc -c`와 대조할 수 있도록 1024 기준을 쓴다. */
const kb = (n) => (n / KB).toFixed(0) + 'KB';

/**
 * 크기를 **정확히** 보여야 하는 자리에서 쓴다. KB만 쓰면 반올림 때문에
 * `187KB > 예산 187KB`처럼 자기모순으로 보이는 출력이 나온다(1KB 안쪽 초과).
 * 구분자를 넣지 않는 이유: 이 값은 LF 정규화 내용의 `wc -c` 출력과 대조하라고 찍는 것이고 `wc -c`는
 * 구분자가 없다. `toLocaleString()`은 실행 환경 로케일에 따라 구분자가 달라지기까지 한다.
 */
const kbExact = (n) => `${kb(n)}(${n}B)`;

/**
 * 체크아웃 줄바꿈과 무관한 텍스트 크기. Buffer를 문자열로 디코드·재인코드하지 않고 CRLF 쌍의
 * CR(0x0d)만 제외한다. 따라서 LF로 커밋된 같은 내용은 Windows CRLF 작업 트리에서도 같은 값을 내며,
 * standalone CR과 CP949 등 비 UTF-8 바이트를 포함한 나머지 모든 바이트는 원본 그대로 센다.
 */
function normalizedTextBytes(buffer) {
  let crlfPairs = 0;
  for (let i = 0; i + 1 < buffer.length; i++) {
    if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a) crlfPairs++;
  }
  return buffer.length - crlfPairs;
}

const normalizedFileBytes = (file) => normalizedTextBytes(fs.readFileSync(file));

/**
 * 크기 측정과 같은 경계로 텍스트 기계 파일을 해시한다. CRLF의 CR만 hash 입력에서 제외하므로
 * 같은 커밋이 Windows 작업 트리에서는 CRLF여도 LF 정본과 같은 SHA-256을 낸다. 문자열로
 * 디코드하지 않아 비 UTF-8 바이트와 standalone CR도 바뀌지 않는다.
 */
function normalizedTextSha256(buffer) {
  const hash = crypto.createHash('sha256');
  let start = 0;
  for (let i = 0; i + 1 < buffer.length; i++) {
    if (buffer[i] !== 0x0d || buffer[i + 1] !== 0x0a) continue;
    hash.update(buffer.subarray(start, i));
    start = i + 1;
  }
  hash.update(buffer.subarray(start));
  return hash.digest('hex');
}

const normalizedFileSha256 = (file) => normalizedTextSha256(fs.readFileSync(file));
const SHA256_HEX = /^[0-9a-f]{64}$/;

function exactObjectKeys(value, expected, label) {
  const issues = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${label}은 객체여야 합니다.`];
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) issues.push(`${label} 필수 key 누락: ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) issues.push(`${label} 알 수 없는 key: ${key}`);
  }
  return issues;
}

function presetLockIssues(lock) {
  const issues = exactObjectKeys(lock, ['schemaVersion', 'files'], 'lock');
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return issues;
  if (lock.schemaVersion !== PRESET_LOCK_SCHEMA_VERSION) {
    issues.push(`schemaVersion은 ${PRESET_LOCK_SCHEMA_VERSION}이어야 합니다.`);
  }
  const files = lock.files;
  issues.push(...exactObjectKeys(files, MANAGED_PRESET_FILES, 'files'));
  if (files && typeof files === 'object' && !Array.isArray(files)) {
    for (const [relative, digest] of Object.entries(files)) {
      if (!MANAGED_PRESET_FILES.includes(relative)) continue;
      if (typeof digest !== 'string' || !SHA256_HEX.test(digest)) {
        issues.push(`files.${relative}: 소문자 SHA-256 64자리여야 합니다.`);
      }
    }
  }
  return issues;
}

function loadPresetLock() {
  const absolute = path.join(REPO_ROOT, PRESET_LOCK_FILE);
  if (!fs.existsSync(absolute)) return { lock: null, issues: [], missing: true };
  if (!fs.statSync(absolute).isFile()) {
    return { lock: null, issues: ['경로가 일반 파일이어야 합니다.'], missing: false };
  }
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    return { lock: null, issues: [`JSON을 읽을 수 없습니다: ${error.message || error}`], missing: false };
  }
  const issues = presetLockIssues(lock);
  return { lock: issues.length ? null : lock, issues, missing: false };
}

function presetDriftConfigIssues(config) {
  const issues = exactObjectKeys(config, ['schemaVersion', 'intentionalDifferences'], '설정');
  if (!config || typeof config !== 'object' || Array.isArray(config)) return issues;
  if (config.schemaVersion !== PRESET_DRIFT_CONFIG_SCHEMA_VERSION) {
    issues.push(`schemaVersion은 ${PRESET_DRIFT_CONFIG_SCHEMA_VERSION}이어야 합니다.`);
  }
  const differences = config.intentionalDifferences;
  if (!differences || typeof differences !== 'object' || Array.isArray(differences)) {
    issues.push('intentionalDifferences는 경로별 선언 객체여야 합니다.');
    return issues;
  }
  for (const [relative, declaration] of Object.entries(differences)) {
    if (!MANAGED_PRESET_FILES.includes(relative)) {
      issues.push(`intentionalDifferences 알 수 없는 기계 파일: ${relative}`);
      continue;
    }
    issues.push(...exactObjectKeys(
      declaration,
      ['reviewedUpstreamSha256', 'acceptedSha256', 'reason'],
      `intentionalDifferences.${relative}`,
    ));
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) continue;
    if (typeof declaration.reviewedUpstreamSha256 !== 'string'
        || !SHA256_HEX.test(declaration.reviewedUpstreamSha256)) {
      issues.push(`intentionalDifferences.${relative}.reviewedUpstreamSha256: 소문자 SHA-256 64자리여야 합니다.`);
    }
    if (typeof declaration.acceptedSha256 !== 'string' || !SHA256_HEX.test(declaration.acceptedSha256)) {
      issues.push(`intentionalDifferences.${relative}.acceptedSha256: 소문자 SHA-256 64자리여야 합니다.`);
    }
    if (typeof declaration.reason !== 'string' || !declaration.reason.trim()) {
      issues.push(`intentionalDifferences.${relative}.reason: 비어 있지 않은 근거가 필요합니다.`);
    }
  }
  return issues;
}

function loadPresetDriftConfig() {
  if (!fs.existsSync(PRESET_DRIFT_CONFIG_FILE)) {
    return { config: { intentionalDifferences: {} }, issues: [] };
  }
  if (!fs.statSync(PRESET_DRIFT_CONFIG_FILE).isFile()) {
    return { config: { intentionalDifferences: {} }, issues: ['경로가 일반 파일이어야 합니다.'] };
  }
  let config;
  try {
    config = require(PRESET_DRIFT_CONFIG_FILE);
  } catch (error) {
    return {
      config: { intentionalDifferences: {} },
      issues: [`설정 모듈을 불러올 수 없습니다: ${error.code || error.message || error}`],
    };
  }
  const issues = presetDriftConfigIssues(config);
  return {
    config: issues.length ? { intentionalDifferences: {} } : config,
    issues,
  };
}

// A markdown H2 whose text starts with an ISO date, e.g. "## 2026-07-22 update: ...".
// The trailing capture is the remainder after the date (used to spot the canonical "| title" form).
const DATE_H2 = /^##[ \t]*(20\d\d-\d\d-\d\d)(.*)$/gim;

// The narrowest narrative-log signature: a date H2 with an "update:" suffix. Checked in EVERY doc
// regardless of its date-H2 policy — 'allow' (CHANGELOG) exempts date H2 as the doc's own format,
// which used to exempt "## <date> update: ..." session logs along with it. CHANGELOG's canonical
// heading is the bare "## <date>", so this suffix never false-positives there.
const NARRATIVE_H2 = /^##[ \t]*20\d\d-\d\d-\d\d[ \t]+update:.*$/gim;

// Return the "## <date> update: ..." heading lines in `text` (the always-on narrative check).
function narrativeLogDrift(text) {
  const src = String(text).replace(/\r\n/g, '\n');
  NARRATIVE_H2.lastIndex = 0;
  return (src.match(NARRATIVE_H2) || []).map((l) => l.trim());
}

// Cumulative-progress tokens that must NOT re-enter VALIDATION's "현재 전역 상태" (green/red axis
// snapshot): milestone markers (M0, M1-4a), test-count ratios (46/46), and "done". Their single
// source is CHANGELOG (progress chronology) / IMPLEMENTATION_PLAN (phase state) — keeping them out
// here prevents the same fact living in two docs where only one has an update rule (→ stale).
const PROGRESS_TOKENS = /\bM\d+\b|\b\d+\s*\/\s*\d+\b|\bdone\b/i;

// 장기 보존되는 AI 메모리에서만 보는 고신뢰 credential 패턴. 저장소 전체 secret scanner를 흉내 내면
// source code의 예제·fixture까지 과탐하므로 AGENTS/CLAUDE와 docs/ai Markdown으로 범위를 제한한다.
// 출력에는 match 자체를 절대 싣지 않고 파일·줄·종류만 남긴다.
const AI_MEMORY_SECRET_PATTERNS = [
  { label: 'private key block', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { label: 'GitHub access token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{20,255})\b/ },
  { label: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'Slack token', pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,200}\b/ },
  { label: 'Stripe live secret', pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,255}\b/ },
];
// 값 문자에 **비밀번호에 흔한 구두점**(`!#$%&@^`)을 더한다. 이들이 없으면 값이 첫 구두점 앞에서
// 잘려 16자 하한에 미달하고 **매치 자체가 성립하지 않아**, 구두점을 섞은 강한 비밀번호일수록
// 빠져나가는 역방향 결함이 된다(우발 붙여넣기의 전형적인 모양이다).
//
// 넓히지 **않은** 문자와 이유 — 하나같이 값 이외의 표기를 값으로 만들어 hard error를 낸다.
// 실측으로 확인한 것들이라 편의상 빼둔 것이 아니다.
// - 공백·비ASCII: "산문은 공백으로 끊긴다"는 성질이 사라진다. 비ASCII를 넣으면 공백 없이 16자를
//   넘는 한국어 서술이 통째로 값이 된다.
// - `<`·`>`: 이 문서 체계 자체가 `<...>`를 placeholder 표기로 쓴다. 실제 credential은 꺾쇠를 거의
//   쓰지 않으므로 얻는 것보다 잃는 것이 크다.
// - 따옴표·backtick: 값의 경계 역할을 그대로 둔다. **여는 쪽 연속 구간만** 아래에서 건너뛴다.
// - `(`·`)`·`[`·`]`·`{`·`}`: 넣으면 코드 표현식이 값이 된다(실측: 기본값 인자를 준 환경변수 조회,
//   헤더 조회 표기가 새로 차단됐다). `${…}`·호출 표기만으로 이뤄진 값은 그래서 여전히 매치되지
//   않는다 — 그 잔여는 OPEN_ISSUES 3에 남겼다.
// - `:`·`|`·`,`·`;`: URL과 Markdown 표 셀, 산문 구분자를 값으로 이어 붙인다.
// - `?`·`*`·`\`: 다른 표기법의 기호와 충돌한다 — 순서대로 optional chaining(`settings?.creds?.key`),
//   YAML alias(`*anchor_name`), UNC 경로(`\\host\share\path`)가 값이 된다. 셋 다 반드시 잡아야 할
//   값 어디에도 쓰이지 않으므로 뺀다(괄호를 뺀 것과 같은 기준: 코드·경로 표기를 값으로 만들지 않는다).
//   대가로 그 문자가 든 비밀번호는 해당 문자 앞에서 잘린다. OPEN_ISSUES 3의 잔여에 포함된다.
//
// **더한 문자가 다른 표기법의 기호이기도 하면** 그 표기를 참조로 인정하거나(→ `%VAR%`를
// `ENV_REFERENCE_VALUE`에 추가) 대가를 받아들인다. 후자가 무엇인지는 이 검사의 판정 규칙 자체다:
//
//   값 자리에서 구분자(와 선택적 여는 따옴표) **바로 뒤부터** 값 문자가 16자 이상 이어지면
//   그 앞머리가 후보가 되고, 고유문자가 8개 이상이면 값으로 잡힌다. 기호가 앞에 오든 중간에
//   오든 구분하지 않으며, **16자를 채운 뒤에 오는 문자는 값 문자가 아니어도 상관없다**
//   (반대로 값 문자가 아닌 문자가 **먼저** 오면 매치 자체가 없다). 예외는 알려진 환경변수 참조,
//   명시적 placeholder 접두, 전부 `*`인 마스크뿐이다.
//
// 이 규칙은 새로 생긴 것이 아니다 — 확장 이전에도 `plain-old-english-word`처럼 기존 값 문자만으로
// 16자를 넘는 토큰은 그대로 차단됐다. 확장이 바꾼 것은 **어떤 토큰이 이 규칙에 걸리는지**뿐이며,
// 그래서 YAML anchor·주석·태그·Ruby instance variable·이메일·percent-encoding이 새로 들어왔다.
// 기호별로 참조 표기를 인정하는 안은 폐기했다 — 인정하는 순간 값 자리의 passphrase에 그 기호만
// 붙여 빠져나갈 수 있고, 그 문자들은 비밀번호 첫 글자로도 흔하다.
// 대가가 좁은 이유: **공백이 뒤따르는** 보통의 주석·태그·수식은 첫 토큰이 문턱 아래라 통과한다.
//
// 여는 따옴표에 backtick을 더한 것은 검사 대상이 Markdown이라 값이 코드 스팬에 담기기 때문이다.
// 값의 **끝**을 닫는 backtick으로 정하지는 않는다 — 경계를 만들면 그 너머로 값을 놓는 우회가 생긴다.
// 값 문자 집합은 아래 `ENV_REFERENCE_VALUE`의 경계 lookahead와 **반드시 같아야 한다**. 어긋나면
// 한쪽에만 있는 문자를 참조 뒤에 붙여 판정을 건너뛸 수 있다 — 실측: 값 문자만 넓히고 lookahead를
// 옛 집합으로 두었더니 `<참조><새 문자><짧은 값>`이 통째로 참조로 인정돼 통과했다. 그래서 두 곳이
// 이 상수 하나를 공유한다(따로 적으면 다음 확장에서 같은 결함이 조용히 되살아난다).
const CREDENTIAL_VALUE_CHARS = 'A-Za-z0-9!#$%&+\\-./=@^_~';
const CREDENTIAL_KEY = '(?:api[_-]?key|access[_-]?(?:key|token)|refresh[_-]?token|auth[_-]?token'
  + '|client[_-]?secret|private[_-]?key|password|passwd|session[_-]?(?:id|token)'
  + '|credential|creds|secret)';
const GENERIC_CREDENTIAL_ASSIGNMENT = new RegExp(
  // 여는 구분자는 **종류·개수를 가리지 않는 연속 구간**으로 받는다. 값 앞에 남는 구분자가 하나라도
  // 있으면 거기서 값 매치가 시작되지 못해(구분자는 값 문자가 아니다) 줄 전체가 통과한다 — 실측으로
  // 다중 backtick 코드 스팬 → 삼중 따옴표 → 코드 스팬 안의 따옴표가 차례로 그렇게 빠져나갔다.
  // 종류나 개수를 축으로 하나씩 받으면 그 조합만큼 우회가 남으므로 구간으로 받는다.
  // **공백은 이 구간에 넣지 않는다.** 넣으면 `<key>: "" <긴 주석>`처럼 값이 비었음을 명시한 줄에서
  // 닫는 따옴표까지 여는 구분자로 삼아 뒤의 주석을 값으로 잡는다(실측 4종). 표기상으로도 따옴표는
  // 값에 붙어 있으므로, 사이의 공백은 "값이 거기서 시작하지 않는다"는 신호다.
  // 두 문자 집합은 서로소라 이 `*`는 backtracking을 만들지 않는다.
  // 닫는 쪽은 여전히 보지 않는다(경계를 정하면 그 너머로 값을 놓는 우회가 생긴다).
  `${CREDENTIAL_KEY}\\b[ \\t]*[:=][ \\t]*["'\`]*([${CREDENTIAL_VALUE_CHARS}]{16,})`,
  'gi',
);
const BEARER_CREDENTIAL = /\bauthorization[ \t]*:[ \t]*bearer[ \t]+([A-Za-z0-9._~+/-]{20,})/gi;
// `allowEnvReference`는 generic 할당에만 준다. Bearer는 실제 인증 헤더 형태 자체가 고신뢰 신호이므로
// 이번 오탐 수정으로 약화하지 않는다.
const ASSIGNED_SECRET_PATTERNS = [
  { label: 'credential assignment', pattern: GENERIC_CREDENTIAL_ASSIGNMENT, allowEnvReference: true },
  { label: 'Authorization bearer token', pattern: BEARER_CREDENTIAL, allowEnvReference: false },
];
const OBVIOUS_PLACEHOLDER = /^(?:example|sample|dummy|test|fake|redacted|masked|replace|changeme|placeholder|unset|todo|your|x{4,})/i;

// 환경변수 참조는 credential 값이 아니다. 검사의 처방문 자체가 "값 대신 환경변수 이름을 남기라"고
// 안내하므로 `process.env.CLIENT_SECRET` 같은 참조를 차단하면 처방과 동작이 모순된다. 일반 판정
// (최소 길이·고유문자 수)을 느슨하게 만드는 대신 **알려진 참조 형태만** 좁게 제외한다 — `env`,
// `secret`, `process` 같은 단어가 섞였다는 이유만으로는 제외하지 않는다.
// 환경변수 API는 이름 표기를 강제하지 않는다 — `CLIENT_SECRET`·`npm_package_version`뿐 아니라
// `ClientSecret`·`Path`(Windows) 같은 이름도 실제로 쓰인다. 그래서 표기 관습으로 진짜 참조를
// 가려내지 않고 일반적인 identifier 범위를 받는다. 남은 위장 여지는 OPEN_ISSUES를 참조.
const ENV_NAME = '[A-Za-z_][A-Za-z0-9_]*';
const ENV_REFERENCE_VALUE = new RegExp(
  '^(?:'
  + `process\\.env\\.${ENV_NAME}`
  + `|process\\.env\\[[ \t]*(['"])${ENV_NAME}\\1[ \t]*\\]`
  + `|os\\.environ\\[[ \t]*(['"])${ENV_NAME}\\2[ \t]*\\]`
  + `|os\\.getenv\\([ \t]*(['"])${ENV_NAME}\\3[ \t]*\\)`
  + `|System\\.getenv\\([ \t]*(['"])${ENV_NAME}\\4[ \t]*\\)`
  + `|\\$\\{${ENV_NAME}\\}`
  + `|\\$${ENV_NAME}`
  // Windows(cmd) 표기 두 가지 — 일반 확장 `%NAME%`과 지연 확장 `!NAME!`. `%`·`!`를 값 문자에
  // 더하면서 필요해졌다: 값 문자로만 두면 처방대로 남긴 환경변수 참조가 credential로 잡혀 규칙과
  // 검사가 모순된다. 위장 여지는 `$NAME`과 같다(이름 문법에 맞는 문자열만 제외된다).
  // **짝을 이룬 형태만** 인정한다 — 닫는 기호가 없는 `!word_word`(YAML 태그)는 환경변수 참조가
  // 아니므로 계속 차단된다. 같은 이유로 환경변수 참조가 아닌 `@NAME@`(autoconf 치환)도 넣지 않는다.
  + `|%${ENV_NAME}%`
  + `|!${ENV_NAME}!`
  // 수식어가 붙은 cmd 표기(`%NAME:~0,8%`)는 **인정하지 않는다.** 인정하려 세 번 시도했고 세 번
  // 다 값이 빠져나갈 자리를 남겼다: 이름만 소비 → 짝 없는 `%<값>:<꼬리>` 통과, 닫는 구분자 확인
  // 추가 → 수식어 본문이 아무 문자열이어도 통과. 조건을 더 붙이는 대신 예외를 없앤다.
  // 문법을 완전히 검증해도 **이름 자리** 위장(`%<값>:~0,8%`)은 남는데, 그건 `%NAME%` 자체가 가진
  // 잔여와 같은 것이라 수식어 예외가 지키는 것이 없다(OPEN_ISSUES 5). 대가는 수식어 표기가
  // 차단되는 과탐 하나이고, 이 문서 체계에서 나올 표기가 아니다(OPEN_ISSUES 2에 고정).
  // Nushell. `$env`까지만 보면 뒤의 `.`이 값 문자라 경계 검사에 걸리므로 완성형으로 인정한다.
  + `|\\$env\\.${ENV_NAME}`
  // 경계: 참조 **바로 뒤**에 값 문자가 오면 참조로 인정하지 않는다(그 줄은 값이 이어 붙은 것이다).
  // 문자 집합은 `CREDENTIAL_VALUE_CHARS`와 같아야 한다 — 위 주석 참조.
  + `)(?![${CREDENTIAL_VALUE_CHARS}])`,
);
// 값 표현식을 잇는 문자(공백·따옴표·괄호·연산자). 값 문자 집합과 **서로소여야 한다** — 겹치면
// 값의 앞머리·꼬리가 연결 문자로 먼저 삼켜져 짧아진 후보로 판정이 뒤집힌다. 그래서 비밀번호 구두점을
// 값 문자에 더할 때 `&`를 이 집합에서 뺐다: 무조건 벗기면 같은 16자 값이 직접 할당은 차단되고
// 참조 뒤에서는 문턱 아래로 떨어져 통과하는 우회가 생긴다(실측 확인).
const GLUE_CHARS = ' \\t"\'`\\])};,|?:';
const EXPRESSION_GLUE = new RegExp(`^[${GLUE_CHARS}]*`);
const TRAILING_GLUE = new RegExp(`[${GLUE_CHARS}]+$`);
// `&`를 연결자로 특별 취급하지 않는다. 공백으로 띄운 연결(`<참조> && <참조>`)에서는 `&&`가 짧은
// 덩어리로 끊겨 문턱 아래로 떨어지므로 그냥 통과하고, 공백 없는 연결은 참조 경계 lookahead가
// 이미 값으로 판정한다(받아들인 과탐). 연결자를 따로 건너뛰면 **같은 문자열이 값 자리에서는
// 차단되고 참조 뒤에서는 통과**하는 불일치가 생긴다 — 낱말 예외와 달리 여기서는 예외를 두지 않는다.
// 후보는 **공백으로 끊기는 덩어리 하나**로 본다. 값을 문자 종류별로 쪼개면 `<낱말>!<짧은 값>`처럼
// 지원하지 않는 구두점을 끼워 조각마다 문턱 아래로 떨어뜨리는 우회가 생긴다. 산문은 공백으로
// 나뉘므로 이 단위가 낱말과 리터럴을 함께 다룬다.
const EXPRESSION_CHUNK = /^\S+/;
// 후보로 볼 최소 길이. `likelyCredentialValue`는 원래 `{16,}` 캡처만 받도록 만들어졌으므로 같은
// 문턱을 지킨다 — 없으면 `quarterly` 같은 평범한 낱말이 고유문자 8개를 넘겨 hard error가 된다.
const CREDENTIAL_TOKEN_MIN_LENGTH = 16;
// 길이만으로는 `misconfiguration` 같은 긴 낱말이 남는다. credential은 숫자·구분자·대소문자 혼용 중
// 하나를 거의 항상 갖는 반면, 같은 대소문자의 글자만으로 이뤄진 덩어리는 낱말이다.
const PROSE_WORD = /^(?:[a-z]+|[A-Z]+)$/;

function likelyCredentialValue(value) {
  if (!value || OBVIOUS_PLACEHOLDER.test(value) || /^\*+$/.test(value)) return false;
  return new Set(value).size >= 8;
}

/**
 * 참조 뒤 **같은 줄 어디에도** credential 후보가 없을 때만 참조로 인정한다.
 *
 * 값이 어디서 끝나는지 경계를 정하지 않는다. 구분자로 경계를 추측하면 markdown 코드 스팬, 다중
 * backtick, template literal, 따옴표 fallback마다 정답이 달라 한쪽을 막을 때 다른 쪽이 열리고,
 * 산문에서 멈추면 산문 뒤에 값을 놓아 빠져나갈 수 있다. 경계를 없애면 그 결함 계열 전체가 사라진다.
 *
 * 대가로 참조와 긴 파일 경로가 한 줄에 있으면 과탐한다 — 안전한 방향이고, 그런 줄은 이 수정 전에도
 * 어차피 차단됐다. 판정은 기존 `likelyCredentialValue`를 재사용해 일반 기준을 완화하지 않는다.
 *
 * 낱말 예외는 **참조를 이미 지난 뒤**에만 준다. 참조 앞은 값 자리이므로 거기 놓인 문자열은
 * passphrase일 수 있고, 기존 판정을 그대로 받아야 한다.
 */
function pureEnvReferenceValue(expression) {
  let rest = expression;
  let sawReference = false;
  while (rest) {
    rest = rest.replace(EXPRESSION_GLUE, '');
    if (!rest) break;
    const reference = ENV_REFERENCE_VALUE.exec(rest);
    if (reference) {
      sawReference = true;
      rest = rest.slice(reference[0].length);
      continue;
    }
    const chunk = EXPRESSION_CHUNK.exec(rest)[0];
    rest = rest.slice(chunk.length);
    const literal = chunk.replace(TRAILING_GLUE, '');
    if (literal.length < CREDENTIAL_TOKEN_MIN_LENGTH) continue;
    if (sawReference && PROSE_WORD.test(literal)) continue;
    if (likelyCredentialValue(literal)) return false;
  }
  return sawReference;
}

function secretFindings(relative, text) {
  const findings = [];
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  lines.forEach((line, index) => {
    for (const { label, pattern } of AI_MEMORY_SECRET_PATTERNS) {
      if (pattern.test(line)) findings.push({ relative, line: index + 1, label });
    }
    for (const { label, pattern, allowEnvReference } of ASSIGNED_SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(line)) !== null) {
        // 캡처된 값은 문자 클래스에서 잘리므로(`process.env['X']` → `process.env`) 참조 판정은
        // 캡처가 아니라 값 시작 위치부터의 표현식을 본다.
        const valueStart = match.index + match[0].length - match[1].length;
        if (allowEnvReference && pureEnvReferenceValue(line.slice(valueStart))) continue;
        if (likelyCredentialValue(match[1])) {
          findings.push({ relative, line: index + 1, label });
          break;
        }
      }
    }
  });
  return findings;
}

function markdownFilesUnder(dir, prefix) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...markdownFilesUnder(absolute, relative));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push({ absolute, relative });
  }
  return files;
}

function aiMemoryMarkdownFiles(invalidFileSet) {
  const roots = AI_MEMORY_ROOT_DOCS
    .filter((relative) => !invalidFileSet.has(relative))
    .map((relative) => ({ absolute: path.join(REPO_ROOT, relative), relative }));
  return [...roots, ...markdownFilesUnder(AI_DIR, 'docs/ai')];
}

// Return offending lines if cumulative-progress narrative has crept back into VALIDATION's
// "현재 전역 상태" section. Scoped to that section only, so the header's "46/46" counter-example
// and dated "last checked" notes (hyphenated ISO dates) never false-positive.
function validationStateDrift(text) {
  const src = String(text).replace(/\r\n/g, '\n');
  const start = src.search(/^##[ \t]+현재 전역 상태[ \t]*$/m);
  if (start === -1) return [];
  const afterHeading = src.slice(start).replace(/^.*\n/, ''); // drop the heading line itself
  const nextH2 = afterHeading.search(/^## /m);
  const body = nextH2 === -1 ? afterHeading : afterHeading.slice(0, nextH2);
  return body.split('\n').map((l) => l.trim()).filter((l) => l && PROGRESS_TOKENS.test(l));
}

// Return the drift heading lines in `text` given a doc's date-H2 policy (see SHARED_DOCS).
function dateHeadingDrift(text, policy) {
  if (policy === 'allow') return [];
  const hits = [];
  const src = String(text).replace(/\r\n/g, '\n');
  DATE_H2.lastIndex = 0;
  let m;
  while ((m = DATE_H2.exec(src)) !== null) {
    // 'pipe' docs keep "## <date> | title" entry headings; only non-pipe date H2 is drift.
    if (policy === 'pipe' && m[2].trim().startsWith('|')) continue;
    hits.push(m[0].trim());
  }
  return hits;
}

function hasCanonicalAdapterImport(text, requiredImport) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.charCodeAt(0) === 0xFEFF) lines[0] = lines[0].slice(1);

  let index = 0;
  while (index < lines.length && lines[index].trim() === '') index++;
  if (/^#[ \t]+\S/.test(lines[index] || '')) {
    index++;
    while (index < lines.length && lines[index].trim() === '') index++;
  }
  return lines[index] === requiredImport;
}

function pad(n) { return String(n).padStart(2, '0'); }
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function slugify(s) {
  return String(s || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

// 첫 파일명은 기존 계약(<date>_<slug>.md)을 유지한다. 같은 날짜·slug 파일이 이미 있으면 이를
// "현재 브랜치의 파일"이라고 추측하지 않는다 — 다른 Unicode 브랜치가 ASCII 제거 뒤 같은 `work`로
// 접히던 경로에서 exit 0만 반환하고 새 저널은 만들지 않았기 때문이다. 순번은 기존 파일을 보존하면서
// 같은 날 같은 slug로 새 slice를 다시 여는 경우까지 다룬다.
function nextJournalFileName(date, slug) {
  let serial = 1;
  while (true) {
    const suffix = serial === 1 ? '' : `-${serial}`;
    const candidate = `${date}_${slug}${suffix}.md`;
    if (!fs.existsSync(path.join(JOURNAL_DIR, candidate))) return candidate;
    serial++;
  }
}
// `symbolic-ref`를 먼저 쓴다: HEAD는 커밋이 0개인 저장소(unborn branch)에서도 refs/heads/<name>을
// 가리키므로 이름을 얻을 수 있다. `rev-parse --abbrev-ref HEAD`는 그 경우 가리킬 커밋이 없어 exit
// 128로 실패했고, 그 폴백('unknown-branch')이 **저널 front-matter와 INDEX에 그대로 박혀** 브랜치
// 매칭을 깨뜨렸다(자기 저널을 close 못 하고, 다음 날 `new`가 두 번째 저널을 만든다).
// detached HEAD에서는 반대로 symbolic-ref가 실패하므로 rev-parse로 폴백한다(종전대로 'HEAD').
// stderr를 버리는 이유: 후보를 순서대로 시도하는 구조라 중간 실패의 `fatal:`은 사용자에게 노이즈다.
function currentBranch() {
  for (const cmd of ['git symbolic-ref --quiet --short HEAD', 'git rev-parse --abbrev-ref HEAD']) {
    try {
      const out = execSync(cmd, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (out) return out;
    } catch (_) { /* 다음 후보로 */ }
  }
  return 'unknown-branch';
}
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

// 이 front matter는 full YAML이 아니라 네 개의 `key: value` 행으로 제한한 작은 제어 schema다.
// Normalize CRLF→LF first: on Windows checkouts (git autocrlf) journal files are often CRLF.
// 종전 parser는 정규식에 안 맞는 행을 버리고 중복 key를 마지막 값으로 덮어써, malformed metadata가
// INDEX와 수명주기에 조용히 들어갔다. inspect는 기존 meta 결과를 제공하면서 check용 오류도 함께 모은다.
function inspectJournalFrontMatter(text) {
  text = String(text).replace(/\r\n/g, '\n');
  const m = text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  const meta = {};
  const issues = [];
  if (!m) return { meta, issues: ['유효한 `---` front matter block이 없습니다.'] };

  const seen = new Set();
  for (const [index, line] of m[1].split('\n').entries()) {
    if (!line.trim()) continue;
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) {
      issues.push(`${index + 2}행: \`key: value\` 형식이 아닙니다.`);
      continue;
    }
    const key = kv[1];
    const value = kv[2].trim();
    if (seen.has(key)) issues.push(`중복 key: ${key}`);
    seen.add(key);
    if (!JOURNAL_FRONT_MATTER_KEY_SET.has(key)) issues.push(`알 수 없는 key: ${key}`);
    meta[key] = value; // 기존 parser와 같이 마지막 값을 보존하되 check가 중복을 hard 차단한다.
  }

  for (const key of JOURNAL_FRONT_MATTER_KEYS) {
    if (!seen.has(key)) issues.push(`필수 key 누락: ${key}`);
    else if (!meta[key]) issues.push(`빈 값: ${key}`);
  }

  if (meta.status && !JOURNAL_STATUS_VALUES.has(meta.status)) {
    issues.push(`허용되지 않은 status: ${meta.status} (허용: ${[...JOURNAL_STATUS_VALUES].join(', ')})`);
  }
  if (meta.date) {
    const formatMatches = /^\d{4}-\d{2}-\d{2}$/.test(meta.date);
    const timestamp = formatMatches ? Date.parse(`${meta.date}T00:00:00Z`) : NaN;
    const roundTrips = Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === meta.date;
    if (!roundTrips) issues.push(`유효하지 않은 date: ${meta.date} (형식: YYYY-MM-DD)`);
  }
  return { meta, issues };
}

function parseFrontMatter(text) {
  return inspectJournalFrontMatter(text).meta;
}

function journalFiles() {
  try {
    if (!fs.statSync(JOURNAL_DIR).isDirectory()) return [];
  } catch (_) {
    return [];
  }
  return fs.readdirSync(JOURNAL_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => f !== 'INDEX.md' && f !== '_TEMPLATE.md')
    .filter((f) => !f.startsWith('_'));
}

// INDEX.md 본문을 만든다. 저널 디렉터리를 **읽지만 아무것도 쓰지 않고**, 같은 저널 상태에서는
// 같은 결과를 낸다(결정적). `index`는 이걸 파일로 쓰고, `check`는 이걸 현재 파일과 대조한다
// — 생성기를 공유해야 "INDEX는 생성물"이라는 계약이 조용히 깨지지 않는다.
function buildIndexLines() {
  const rows = journalFiles().map((f) => {
    const meta = parseFrontMatter(fs.readFileSync(path.join(JOURNAL_DIR, f), 'utf8'));
    return {
      file: f,
      date: meta.date || f.slice(0, 10),
      branch: meta.branch || '',
      slice: meta.slice || '',
      status: meta.status,
    };
  });
  rows.sort((a, b) => (b.date + b.file).localeCompare(a.date + a.file));

  const fmtRow = (r) => {
    const slice = r.slice || '(제목 없음)';
    return `- [${r.date}] \`${r.branch}\` — ${slice} → [journal](${r.file})`;
  };
  const sections = [
    { status: 'active', heading: '활성 (active)', empty: '활성 저널 없음' },
    { status: 'merged', heading: '머지됨 (merged)', empty: '머지된 저널 없음' },
    { status: 'abandoned', heading: '중단됨 (abandoned)', empty: '중단된 저널 없음' },
    { status: 'cancelled', heading: '취소됨 (cancelled)', empty: '취소된 저널 없음' },
  ];

  const lines = [
    '# 브랜치 저널 인덱스',
    '',
    '세션 시작 시에는 자신의 **활성 브랜치 저널 1개만** 읽는다. 이 인덱스는 다른 브랜치 이력이',
    '필요할 때만 스캔한다. 자동 생성 파일 — `node scripts/worklog.js index`로 재생성한다.',
    '',
  ];
  if (!rows.length) {
    lines.push('_아직 저널이 없습니다. `node scripts/worklog.js new`로 생성하세요._');
  } else {
    sections.forEach((section, index) => {
      if (index) lines.push('');
      lines.push(`## ${section.heading}`, '');
      const matching = rows.filter((r) => r.status === section.status);
      if (matching.length) matching.forEach((r) => lines.push(fmtRow(r)));
      else lines.push(`_${section.empty}._`);
    });
    const invalid = rows.filter((r) => !JOURNAL_STATUS_VALUES.has(r.status));
    if (invalid.length) {
      lines.push('', '## 잘못된 상태 (invalid)', '');
      invalid.forEach((r) => lines.push(`${fmtRow(r)} *(status: ${r.status || '(없음)'})*`));
    }
  }
  lines.push('');
  return { lines, count: rows.length };
}

function rebuildIndex() {
  const { lines, count } = buildIndexLines();
  ensureDir(JOURNAL_DIR);
  fs.writeFileSync(INDEX, lines.join('\n'), 'utf8');
  return count;
}

function templateBody() {
  if (fs.existsSync(TEMPLATE)) return fs.readFileSync(TEMPLATE, 'utf8');
  return [
    '---', 'branch: __BRANCH__', 'date: __DATE__', 'status: active',
    `slice: ${TITLE_PLACEHOLDER}`, '---', '', '# __BRANCH__', '',
    '## 목표 / 범위', '', '## 영향 파일', '', '## 진행 노트', '', '## 검증', '',
    '## 남은 수동 검증', '',
  ].join('\n');
}

function journalMeta(file) {
  return parseFrontMatter(fs.readFileSync(path.join(JOURNAL_DIR, file), 'utf8'));
}

// Journals matching a branch with the given status ('active' by default). One branch owns one
// active journal even when the branch spans several days — keyed on front-matter, not filename.
function journalsForBranch(branch, status) {
  return journalFiles().filter((f) => {
    const meta = journalMeta(f);
    return meta.branch === branch && meta.status === status;
  });
}

function invalidJournals() {
  return journalFiles().map((f) => {
    const raw = fs.readFileSync(path.join(JOURNAL_DIR, f), 'utf8');
    const { issues } = inspectJournalFrontMatter(raw);
    return { f, issues };
  }).filter(({ issues }) => issues.length);
}

function printJournalSchemaErrors(invalid) {
  invalid.forEach(({ f, issues }) => {
    console.error(`[ERROR] journal/${f}: front matter schema 오류 ${issues.length}건:`);
    issues.forEach((issue) => console.error(`  - ${issue}`));
  });
}

function cmdNew(slugArg) {
  const branch = currentBranch();
  const date = today();
  ensureDir(JOURNAL_DIR);
  const invalid = invalidJournals();
  if (invalid.length) {
    console.error(`새 저널 생성 차단: 저장소에 front matter schema 오류 저널이 ${invalid.length}개 있습니다.`);
    printJournalSchemaErrors(invalid);
    console.error('오류 저널을 모두 고친 뒤 다시 new 하세요. 저널과 INDEX.md는 변경하지 않았습니다.');
    process.exit(1);
  }
  // A branch that spans multiple days must stay in one journal — don't split on date+slug filename.
  const existing = journalsForBranch(branch, 'active');
  // Two+ active journals means the invariant is already broken (hand edits, merge-conflict leftovers,
  // or the pre-f3efeba unborn-branch bug). Same principle as `close`'s ambiguity handling: never
  // silently pick one — pointing at existing[0] would keep appends flowing into an arbitrary file.
  // Error path touches no file (no INDEX rebuild), so exit 1 leaves the tree clean.
  if (existing.length > 1) {
    console.error(`활성 저널이 ${existing.length}개입니다 — 브랜치 '${branch}'는 1개만 가져야 합니다.`);
    existing.forEach((f) => console.error(describeJournal(f)));
    console.error('어느 저널이 진짜인지 정한 뒤, 나머지를 `node scripts/worklog.js close <파일명>`으로 마감하세요.');
    process.exit(1);
  }
  if (existing.length) {
    console.log(`이미 이 브랜치의 활성 저널이 있습니다: docs/ai/journal/${existing[0]}`);
    console.log('같은 브랜치는 여러 날에 걸쳐도 저널 1개를 유지합니다 — 새 slice는 이 파일에 append 하세요.');
    console.log('(정말 새 저널이 필요하면 먼저 `node scripts/worklog.js close`로 기존 저널을 마감하세요.)');
    console.log(`INDEX.md 갱신 (저널 ${rebuildIndex()}개).`);
    return;
  }
  const slug = slugify(slugArg || branch) || 'work';
  const fileName = nextJournalFileName(date, slug);
  const filePath = path.join(JOURNAL_DIR, fileName);
  const body = templateBody().replace(/__BRANCH__/g, branch).replace(/__DATE__/g, date);
  fs.writeFileSync(filePath, body, 'utf8');
  console.log(`생성: docs/ai/journal/${fileName}`);
  console.log(`INDEX.md 갱신 (저널 ${rebuildIndex()}개).`);
}

function cmdIndex() { console.log(`INDEX.md 재생성 완료 (저널 ${rebuildIndex()}개).`); }

function describeJournal(f) {
  const meta = journalMeta(f);
  return `  - ${f} — branch: ${meta.branch || '(없음)'} / status: ${meta.status || '(없음)'}`;
}

// List the journals INDEX still shows as open, plus the command that closes one. This is the
// discovery path after "merge, then switch to the default branch": the journal's front-matter
// still names the source branch, so `close` needs that name (or the file) as an explicit target.
function printOpenJournals(write) {
  const open = journalFiles().filter((f) => journalMeta(f).status === 'active');
  if (!open.length) {
    write('열린 저널이 없습니다.');
    return;
  }
  write('열린 저널:');
  open.forEach((f) => write(describeJournal(f)));
  write('머지 후에는 대상을 지정해 마감합니다: node scripts/worklog.js close <branch|파일명|slug>');
  write('비머지 종료는 상태를 명시합니다: node scripts/worklog.js close [대상] --status <abandoned|cancelled>');
}

function parseCloseArgs(args) {
  let target;
  let status = 'merged';
  let hasExplicitStatus = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--status') {
      if (hasExplicitStatus) return { error: '`--status`는 한 번만 지정할 수 있습니다.' };
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
        return { error: '`--status` 뒤에 종료 상태가 필요합니다.' };
      }
      status = args[++i];
      hasExplicitStatus = true;
      continue;
    }
    if (arg.startsWith('--')) return { error: `알 수 없는 close 옵션: ${arg}` };
    if (target !== undefined) return { error: `close 대상은 하나만 지정할 수 있습니다: ${target}, ${arg}` };
    target = arg;
  }

  if (!TERMINAL_JOURNAL_STATUS_VALUES.has(status)) {
    return {
      error: `close 종료 상태는 ${[...TERMINAL_JOURNAL_STATUS_VALUES].join(', ')} 중 하나여야 합니다: ${status}`,
    };
  }
  return { target, status };
}

// Pick the active journal(s) `close` should move to the selected terminal status.
//   no target - the current branch's active journal(s), as before.
//   a target  - journal(s) matched by front-matter branch, then file name, then slug.
//               Branch matches prefer active journals, so retained terminal history does not make
//               the supported "same branch, new active journal" flow ambiguous. Two+ actives still fail.
//               With no active, journals already in the requested terminal status are returned as
//               an idempotent no-op even when several histories for that branch share that result.
//               This is what makes closing possible AFTER the merge (from the default branch, or
//               once the source branch is deleted), where the current branch never matches.
// On failure returns an `error` so the caller can print the hint and touch no file.
function resolveCloseTargets(target, status) {
  if (!target) {
    const branch = currentBranch();
    const targets = journalsForBranch(branch, 'active');
    if (targets.length === 1) return { targets };
    // Two+ actives: the target (current branch) is unambiguous but the RESULT SET is not — closing
    // them all would silently mark the wrong journal merged. Same rule as the explicit-target path
    // below; naming a file still closes journals one at a time, so there is a way through.
    if (targets.length > 1) {
      return { error: `활성 저널이 ${targets.length}개입니다 — 일괄 마감하지 않습니다.`, candidates: targets, exitCode: 1 };
    }
    // Non-blocking: an already-closed slice lands here too, so this is a nudge, not a failure.
    return { error: `활성 저널 없음: 브랜치 '${branch}'에 status:active 저널이 없습니다.`, exitCode: 0 };
  }
  const files = journalFiles();
  const slug = slugify(target);
  const byBranch = files.filter((f) => journalMeta(f).branch === target);
  const activeByBranch = byBranch.filter((f) => journalMeta(f).status === 'active');
  const byFile = files.filter((f) => f === path.basename(target));
  const bySlug = slug ? files.filter((f) => f.includes(slug)) : [];
  const sameTerminalByBranch = byBranch.filter((f) => journalMeta(f).status === status);
  if (byBranch.length && !activeByBranch.length && sameTerminalByBranch.length) {
    return { targets: sameTerminalByBranch };
  }
  const branchMatches = activeByBranch.length ? activeByBranch : byBranch;
  const matches = byBranch.length ? branchMatches : (byFile.length ? byFile : bySlug);
  if (!matches.length) return { error: `대상 저널 없음: '${target}'과 일치하는 저널이 없습니다.`, exitCode: 1 };
  // `new` names files from `slug || branch`, so a slug match can hit several journals — a typo must
  // not silently close the wrong one.
  if (matches.length > 1) {
    return { error: `대상이 모호합니다: '${target}'이 저널 ${matches.length}개와 일치합니다.`, candidates: matches, exitCode: 1 };
  }
  return { targets: matches };
}

// Move active target journal(s) to the selected terminal status so INDEX archives them by outcome.
// Preserves the file's existing newline style (CRLF on Windows checkouts).
function cmdClose(args) {
  const parsed = parseCloseArgs(args);
  if (parsed.error) {
    console.error(parsed.error);
    console.error('사용법: node scripts/worklog.js close [branch|파일명|slug] [--status <merged|abandoned|cancelled>]');
    process.exit(1);
  }
  const { target, status } = parsed;
  const invalid = invalidJournals();
  if (invalid.length) {
    console.error(`저널 마감 차단: 저장소에 front matter schema 오류 저널이 ${invalid.length}개 있습니다.`);
    printJournalSchemaErrors(invalid);
    console.error('오류 저널을 모두 고친 뒤 다시 close 하세요. 저널과 INDEX.md는 변경하지 않았습니다.');
    process.exit(1);
  }
  const { targets, error, candidates, exitCode } = resolveCloseTargets(target, status);
  if (error) {
    const write = exitCode ? console.error : console.log;
    write(error);
    if (candidates) {
      write('후보:');
      candidates.forEach((f) => write(describeJournal(f)));
      const statusOption = status === 'merged' ? '' : ` --status ${status}`;
      write(`정확한 파일명으로 다시 실행하세요: node scripts/worklog.js close <파일명>${statusOption}`);
    } else {
      printOpenJournals(write);
    }
    if (exitCode) process.exit(exitCode);
    console.log(`INDEX.md 갱신 (저널 ${rebuildIndex()}개).`);
    return;
  }
  const journalStates = targets.map((f) => {
    const fp = path.join(JOURNAL_DIR, f);
    const raw = fs.readFileSync(fp, 'utf8');
    return { f, fp, raw, currentStatus: parseFrontMatter(raw).status };
  });
  const conflicting = journalStates.filter(({ currentStatus }) => currentStatus !== 'active' && currentStatus !== status);
  if (conflicting.length) {
    conflicting.forEach(({ f, currentStatus }) => {
      console.error(`종료 상태 전이 차단: docs/ai/journal/${f} — ${currentStatus} → ${status}`);
    });
    console.error('terminal 상태는 다른 결과로 덮어쓰지 않습니다. 재개가 필요하면 새 브랜치 저널을 만드세요.');
    process.exit(1);
  }

  let closed = 0;
  for (const { f, fp, raw, currentStatus } of journalStates) {
    if (currentStatus === status) {
      console.log(`이미 ${status}: docs/ai/journal/${f} — 변경 없음.`);
      continue;
    }
    // `.` excludes \r, so `.*` stops before CRLF's \r — the original newline is left intact.
    const updated = raw.replace(/^status:.*$/m, `status: ${status}`);
    fs.writeFileSync(fp, updated, 'utf8');
    closed++;
    console.log(`close: docs/ai/journal/${f} → status: ${status}`);
  }
  console.log(`INDEX.md 갱신 (저널 ${rebuildIndex()}개).`);
  if (closed) {
    // 안내가 커밋에서 멈추면 안 된다 — 이 메시지는 마감하는 그 순간에 읽히므로 push까지 말한다.
    // 다만 **push를 빠뜨렸을 때 무엇이 깨지는지는 단정하지 않는다.** 그 답은 커밋이 어디에
    // 떨어지는지에 달렸는데, 이 명령은 그것을 모른다:
    // - `status`는 대리 지표일 뿐이다. `close <branch>`(기본 `merged`)를 **작업 브랜치에서**
    //   실행할 수 있고(인자 생략 시 현재 브랜치 마감은 문서화된 경로다), 반대로 기본 브랜치에서
    //   `--status abandoned`를 실행할 수도 있다. 둘 다 CLI 호환상 허용된다.
    // - 어느 쪽이 기본 브랜치인지도 알 수 없다(이름은 저장소마다 다르고, 원격 조회는 폐쇄망에서
    //   작동하지 않는다).
    // 모르는 것을 단정하면 절반의 호출에 거짓을 말하게 된다. 의무(커밋 + push)만 말하고 이유는
    // 정본 두 절로 보낸다 — 체크리스트 9가 같은 이유로 같은 방식을 쓴다.
    console.log('저널과 INDEX.md가 변경되었습니다 — doc-only 커밋으로 남기고 push 하세요.');
    console.log('  커밋하지 않으면 브랜치 전환이 막힙니다.');
    console.log('  push를 빠뜨렸을 때 무엇이 깨지는지는 마감 경로마다 다릅니다 — AGENTS.md의 "저널 마감 순서"·"비머지 마감 순서"를 보세요.');
  }
}

function checkPresetDrift(invalidFileSet) {
  let hard = 0;
  let soft = 0;
  const lockResult = loadPresetLock();
  const configResult = loadPresetDriftConfig();

  if (lockResult.missing) {
    soft++;
    console.warn(`[soft] ${PRESET_LOCK_FILE}: 적용 버전의 기계 파일 기준이 없어 오프라인 드리프트를 검사할 수 없습니다 — 프리셋 갱신 시 이 파일도 함께 가져오세요(비차단).`);
  } else if (lockResult.issues.length) {
    hard++;
    console.error(`[ERROR] ${PRESET_LOCK_FILE}: 드리프트 기준 오류 ${lockResult.issues.length}건:`);
    lockResult.issues.forEach((issue) => console.error(`  - ${issue}`));
  }

  if (configResult.issues.length) {
    hard++;
    console.error(`[ERROR] ${PRESET_DRIFT_CONFIG_RELATIVE}: 의도적 차이 설정 오류 ${configResult.issues.length}건:`);
    configResult.issues.forEach((issue) => console.error(`  - ${issue}`));
  }

  if (!lockResult.lock || configResult.issues.length) return { hard, soft };
  const declarations = configResult.config.intentionalDifferences;
  for (const relative of MANAGED_PRESET_FILES) {
    if (invalidFileSet.has(relative)) continue;
    const absolute = path.join(REPO_ROOT, ...relative.split('/'));
    const current = normalizedFileSha256(absolute);
    const upstream = lockResult.lock.files[relative];
    const declaration = declarations[relative];

    if (current === upstream) {
      if (declaration) {
        soft++;
        console.warn(`[soft] 프리셋 의도적 차이 선언이 불필요해짐: ${relative} — 현재 파일이 기준과 같습니다. ${PRESET_DRIFT_CONFIG_RELATIVE}에서 선언을 제거하세요(비차단).`);
      }
      continue;
    }
    if (!declaration) {
      soft++;
      console.warn(`[soft] 선언되지 않은 프리셋 기계 파일 차이: ${relative} — 자동 수정하지 않습니다.`);
      console.warn(`[soft]   기준 SHA-256: ${upstream}`);
      console.warn(`[soft]   현재 SHA-256: ${current}`);
      console.warn(`[soft]   의도한 차이면 기준·현재 해시와 이유를 ${PRESET_DRIFT_CONFIG_RELATIVE}에 선언하세요.`);
      continue;
    }
    if (declaration.reviewedUpstreamSha256 !== upstream) {
      soft++;
      console.warn(`[soft] 선언 검토 뒤 바뀐 프리셋 기준: ${relative} — 자동 수정하지 않습니다.`);
      console.warn(`[soft]   선언이 검토한 기준 SHA-256: ${declaration.reviewedUpstreamSha256}`);
      console.warn(`[soft]   현재 기준 SHA-256: ${upstream}`);
      console.warn('[soft]   새 상류 변경과 프로젝트 차이를 다시 검토한 뒤 두 승인 해시와 이유를 갱신하세요.');
      continue;
    }
    if (declaration.acceptedSha256 !== current) {
      soft++;
      console.warn(`[soft] 승인 뒤 다시 바뀐 프리셋 기계 파일: ${relative} — 자동 수정하지 않습니다.`);
      console.warn(`[soft]   선언 SHA-256: ${declaration.acceptedSha256}`);
      console.warn(`[soft]   현재 SHA-256: ${current}`);
      console.warn('[soft]   새 차이를 검토한 뒤에만 승인 해시와 이유를 갱신하세요.');
    }
  }
  return { hard, soft };
}

function cmdCheck() {
  // hard = 불완전한 프리셋/필수 입력 또는 커밋을 막는 실 anti-pattern. soft = 비차단 위생 넛지.
  let hard = 0;
  let soft = 0;
  let sessionBytes = 0;
  const sizePolicyResult = loadSizePolicy();
  const sizePolicy = sizePolicyResult.policy;
  if (sizePolicyResult.issues.length) {
    hard++;
    console.error(`[ERROR] ${SIZE_POLICY_RELATIVE}: 규모 설정 오류 ${sizePolicyResult.issues.length}건 — 판정은 내장 기본값으로 계속합니다:`);
    sizePolicyResult.issues.forEach((issue) => console.error(`  - ${issue}`));
  }

  const invalidFiles = REQUIRED_PRESET_FILES.filter((relative) => {
    try { return !fs.statSync(path.join(REPO_ROOT, relative)).isFile(); }
    catch (_) { return true; }
  });
  const invalidFileSet = new Set(invalidFiles);
  if (invalidFiles.length) {
    hard++;
    console.error(`[ERROR] 필수 프리셋 파일 ${invalidFiles.length}개 누락 또는 파일 아님 — 초기화 사본을 확인하세요:`);
    invalidFiles.forEach((relative) => console.error(`  - ${relative}`));
  }

  for (const [relative, requiredImport] of Object.entries(REQUIRED_ADAPTER_IMPORTS)) {
    if (invalidFileSet.has(relative)) continue;
    const adapter = fs.readFileSync(path.join(REPO_ROOT, relative));
    if (!hasCanonicalAdapterImport(adapter.toString('utf8'), requiredImport)) {
      hard++;
      console.error(`[ERROR] ${relative}: 공통 정본 import 누락 — 선택적 H1 다음 첫 본문에 열 0 단독 행 \`${requiredImport}\`가 필요합니다.`);
    }
    const adapterBytes = normalizedTextBytes(adapter);
    if (adapterBytes > sizePolicy.adapterMaxBytes) {
      hard++;
      console.error(`[ERROR] ${relative}: adapter ${kbExact(adapterBytes)} > 최대 ${kbExact(sizePolicy.adapterMaxBytes)} — 공통 규칙은 AGENTS.md로 옮기세요.`);
    }
  }

  if (!invalidFileSet.has(PRESET_MANIFEST_FILE) && !invalidFileSet.has('scripts/preset-manifest.js')) {
    let result;
    try {
      const { loadPresetManifest } = require('./preset-manifest');
      result = loadPresetManifest(REPO_ROOT);
    } catch (error) {
      hard++;
      console.error(`[ERROR] ${PRESET_MANIFEST_FILE}: JSON을 읽을 수 없습니다: ${error.message || error}`);
    }
    if (result !== undefined) {
      const { issues } = result;
      if (issues.length) {
        hard++;
        console.error(`[ERROR] ${PRESET_MANIFEST_FILE}: manifest schema 오류 ${issues.length}건:`);
        issues.forEach((issue) => console.error(`  - ${issue}`));
      }
    }
  }

  const driftResult = checkPresetDrift(invalidFileSet);
  hard += driftResult.hard;
  soft += driftResult.soft;

  const credentialFindings = aiMemoryMarkdownFiles(invalidFileSet).flatMap(({ absolute, relative }) => (
    secretFindings(relative, fs.readFileSync(absolute, 'utf8'))
  ));
  if (credentialFindings.length) {
    hard++;
    console.error(`[ERROR] AI 메모리 민감정보 의심 ${credentialFindings.length}건 — 값은 출력하지 않습니다:`);
    credentialFindings.forEach(({ relative, line, label }) => console.error(`  - ${relative}:${line} (${label})`));
    console.error('  - 실제 credential이면 먼저 폐기·회전하고, 문서에는 환경변수 이름이나 <redacted>만 남기세요.');
  }

  for (const [relative, markers] of Object.entries(REQUIRED_PLACEHOLDERS)) {
    const fp = path.join(REPO_ROOT, relative);
    if (invalidFileSet.has(relative)) continue; // 같은 경로의 구조 오류는 위에서 한 번만 보고한다.
    const text = fs.readFileSync(fp, 'utf8');
    const remaining = markers.filter((marker) => text.includes(marker));
    if (remaining.length) {
      hard++;
      console.error(`[ERROR] ${relative}: 필수 초기 입력 ${remaining.length}개가 미작성 상태입니다:`);
      remaining.forEach((marker) => console.error(`  - ${marker}`));
      console.error(`  - ${REQUIRED_PLACEHOLDER_REMEDY[relative]}`);
    }
  }

  for (const { file, dates, session, conditionalSession } of SHARED_DOCS) {
    if (invalidFileSet.has(`docs/ai/${file}`)) continue;
    const fp = path.join(AI_DIR, file);
    const cap = sizePolicy.documentCaps[file];
    // 원본 바이트에서 줄바꿈만 정규화해 센다. `utf8`로 읽은 **문자열**을 다시 `Buffer.byteLength`로 재면
    // 디코드→재인코드 왕복이라, 깨진 UTF-8 바이트열이 대체문자(U+FFFD, 3B)로 바뀌며 `wc -c`와
    // 어긋난다(실측: CP949로 저장된 한글 문서 7B → 11B). LF 정규화 내용의 `wc -c` 대조가 바이트를
    // 고른 이유이므로 그 등식이 깨지면 기준 자체가 무의미해진다. 드리프트 검사용 텍스트만 디코드한다.
    const buf = fs.readFileSync(fp);
    const bytes = normalizedTextBytes(buf);
    const text = buf.toString('utf8');
    if (session) sessionBytes += bytes;
    if (bytes > cap) {
      soft++;
      const remedy = CAP_REMEDY[file] || '오래되거나 대체된 항목을 덜어낸다.';
      const loadLabel = session ? ' (매 세션 로드)' : conditionalSession ? ' (조건부 세션 로드)' : '';
      console.warn(`[soft] docs/ai/${file}: ${kbExact(bytes)} > 권장 ${kbExact(cap)}${loadLabel} — 비차단. 처방:`);
      console.warn(wrapRemedy(remedy));
    }
    // 서술 로그(`update:`) 상시 검사를 정책 판정보다 먼저 본다 — 'allow' 문서(CHANGELOG)는 아래
    // dateHeadingDrift가 전면 면제라 이 검사가 유일한 방어다.
    // 두 검사는 **둘 다** 돌린다. 종전에는 `else`로 이어 중복 계상을 막았는데, 그러면 `update:`
    // 헤딩이 하나라도 있는 문서에서 **다른 형태의 날짜 H2 드리프트를 통째로 놓쳤다**. 피해야 할
    // 것은 "한 헤딩이 두 번 계상되는 것"이지 "두 번째 검사"가 아니므로, 검사를 끄는 대신 날짜 H2
    // 쪽에서 서술 로그 헤딩을 빼고 센다(양쪽 모두 trim된 헤딩 원문을 돌려주므로 비교가 성립한다).
    const narrative = narrativeLogDrift(text);
    if (narrative.length) {
      hard++;
      console.error(`[WARN] docs/ai/${file}: 서술 로그(\`update:\`) 헤딩 ${narrative.length}건 감지 (예: "${narrative[0]}") — 날짜별 세션 서술은 브랜치 저널로.`);
    }
    const drift = dateHeadingDrift(text, dates).filter((l) => !narrative.includes(l));
    if (drift.length) {
      hard++;
      console.error(`[WARN] docs/ai/${file}: 날짜 H2 헤딩 ${drift.length}건 감지 (예: "${drift[0]}") — append-only 서술 로그 드리프트. 브랜치 저널로 이동.`);
    }
    if (file === 'VALIDATION.md') {
      const vdrift = validationStateDrift(text);
      if (vdrift.length) {
        soft++;
        console.warn(`[soft] docs/ai/VALIDATION.md "현재 전역 상태"에 누적-진행 토큰 ${vdrift.length}건 (예: "${vdrift[0]}") — 여긴 green/red 축 상태만. 진행 이력은 CHANGELOG, phase 상태는 IMPLEMENTATION_PLAN으로(비차단).`);
      }
    }
  }
  // INDEX.md 동기. INDEX는 **생성물**인데 `index`를 다시 돌리지 않으면 저널과 어긋난다. 아래
  // 자리표시자 검사는 "제목을 안 채운 것"만 잡으므로, 저널을 지웠다 다시 만드는 식의 드리프트는
  // 통과시켰다(자매 프로젝트 실측 — INDEX가 "활성 저널 없음"인데 활성 저널이 있는 채로 OK가 났다).
  // 생성기를 공유하므로 지금 만든 것과 파일을 대조하면 그 종류를 전부 잡는다.
  // 경로는 상단 `INDEX` 상수를 쓰고 내용은 **한 번만** 읽어 아래 자리표시자 검사와 공유한다.
  // 파일 부재/타입 오류는 위 필수 구조 검사에서 hard로 보고하며, 여기서는 내용 불일치만 soft다.
  // 대조 전 CRLF를 정규화한다: git autocrlf 체크아웃에서 INDEX는 CRLF로 내려올 수 있는데
  // `buildIndexLines()`는 항상 LF를 내므로, 정규화가 없으면 Windows에서 전부 오탐이 된다.
  const journals = journalFiles();
  const invalidJournalFrontMatter = new Set();
  for (const f of journals) {
    const raw = fs.readFileSync(path.join(JOURNAL_DIR, f), 'utf8');
    const { issues } = inspectJournalFrontMatter(raw);
    if (!issues.length) continue;
    invalidJournalFrontMatter.add(f);
    hard++;
    console.error(`[ERROR] journal/${f}: front matter schema 오류 ${issues.length}건:`);
    issues.forEach((issue) => console.error(`  - ${issue}`));
  }

  // 시작 규칙과 같은 조건으로 합산한다. 현재 브랜치의 활성 저널이 있으면 그것이 정본이고,
  // 없을 때만 NEXT_WORK가 bootstrap 포인터가 된다. 중복 활성 저널은 Phase 4에서 별도 무결성 오류로
  // 다루되, 여기서는 실제로 후보가 된 파일을 모두 세어 비용을 과소평가하지 않는다.
  const branch = currentBranch();
  const activeBranchJournals = journals.filter((f) => {
    if (invalidJournalFrontMatter.has(f)) return false;
    const meta = journalMeta(f);
    return meta.branch === branch && meta.status === 'active';
  });
  if (activeBranchJournals.length) {
    for (const f of activeBranchJournals) sessionBytes += normalizedFileBytes(path.join(JOURNAL_DIR, f));
  } else if (!invalidFileSet.has('docs/ai/NEXT_WORK.md')) {
    sessionBytes += normalizedFileBytes(path.join(AI_DIR, 'NEXT_WORK.md'));
  }
  const invalidIndex = invalidFileSet.has('docs/ai/journal/INDEX.md');
  const indexText = invalidIndex ? null : fs.readFileSync(INDEX, 'utf8');
  // schema가 틀리면 INDEX 재생성으로는 고쳐지지 않는다. 그 상태에서 stale 경고까지 내면 사용자를
  // 원인과 무관한 명령으로 보내므로, metadata를 고친 다음 check에서 내용 대조를 재개한다.
  if (!invalidJournalFrontMatter.size && indexText !== null
      && buildIndexLines().lines.join('\n') !== indexText.replace(/\r\n/g, '\n')) {
    soft++;
    console.warn('[soft] journal/INDEX.md가 저널과 어긋난다 — `node scripts/worklog.js index`로 재생성(비차단).');
  }

  // 제목 자리표시자 잔존. `new`가 심은 문구를 저널에 채워도 `index`를 다시 돌리지 않으면
  // INDEX.md에 그대로 남아, 이력을 찾을 때 어떤 slice인지 알 수 없다. 두 상태를 함께 잡는다.
  // 저널은 front-matter의 `slice:` 줄만 본다 — 본문까지 훑으면 이 문구를 언급하는 저널이 오탐된다.
  const unfilledJournals = [];
  for (const f of journals) {
    if (invalidJournalFrontMatter.has(f)) continue;
    if ((journalMeta(f).slice || '').includes(TITLE_PLACEHOLDER)) {
      unfilledJournals.push(`journal/${f}`);
    }
  }
  if (unfilledJournals.length) {
    hard++;
    console.error(`[ERROR] 저널 제목 필수 입력 ${unfilledJournals.length}건 미작성 — front-matter의 slice: 를 채우세요:`);
    unfilledJournals.forEach((relative) => console.error(`  - ${relative}`));
  } else if (!invalidJournalFrontMatter.size && indexText !== null && indexText.includes(TITLE_PLACEHOLDER)) {
    // 저널은 이미 고쳤는데 INDEX만 낡은 경우는 생성물 재생성으로 닫히는 위생 문제라 soft를 유지한다.
    soft++;
    console.warn('[soft] journal/INDEX.md에 이전 저널 제목 자리표시자가 남았다 — `node scripts/worklog.js index`로 재생성(비차단).');
  }

  // 루트의 필수 읽기 문서도 합계에 넣는다 — `docs/ai/` 밖이라고 세션 비용이 안 드는 게 아니다.
  for (const file of ROOT_SESSION_DOCS) {
    if (invalidFileSet.has(file)) continue;
    const fp = path.join(REPO_ROOT, file);
    sessionBytes += normalizedFileBytes(fp);
  }
  // 개별 파일이 각자 cap 안이어도 **합계**가 세션 비용이다. 그쪽을 따로 본다.
  if (sessionBytes > sizePolicy.sessionBudget) {
    soft++;
    console.warn(`[soft] 필수 읽기 문서 합계 ${kbExact(sessionBytes)} > 예산 ${kbExact(sizePolicy.sessionBudget)} — 매 세션 드는 비용이다(비차단).`);
  }

  console.log(`저널 ${journals.length}개, 공유 상태 문서 ${SHARED_DOCS.length}개 점검 · 필수 읽기 합계 ${kbExact(sessionBytes)} · 루트 ${ROOT_SESSION_DOCS.join('·')} 포함.`);
  if (hard) { console.error(`\n${hard}건 오류(차단). 위 항목을 정리하세요.`); process.exit(1); }
  // 마지막 줄이 soft 상태를 담아야 한다. 종전에는 soft 건수와 무관하게 "OK"만 찍어서,
  // 출력을 `| tail -2`로 자르거나 마지막 줄만 읽으면 [soft] 경고를 통째로 놓쳤다(실제 2회 재발).
  if (soft) {
    console.warn(`OK(차단 없음) — 다만 비차단 경고 ${soft}건. 위 [soft] 줄의 처방을 확인하세요.`);
    return;
  }
  console.log('OK — 공유 상태 문서 점검 통과.');
}

function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'new': return cmdNew(process.argv[3]);
    case 'close': return cmdClose(process.argv.slice(3));
    case 'index': return cmdIndex();
    case 'check': return cmdCheck();
    default:
      console.log('사용법: node scripts/worklog.js <new [slug] | close [branch|파일명|slug] [--status <merged|abandoned|cancelled>] | index | check>');
      process.exit(cmd ? 1 : 0);
  }
}
main();
