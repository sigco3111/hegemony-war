# 패권의 시간 — 설계 문서

OpenFrontIO를 싱글플레이 중심으로 개선한 포크입니다. 서버 없이 GitHub Pages 정적 배포만으로 동작하며, 계정·네트워크·사운드 없이 한 판씩 쌓이는 맛을 목표로 합니다.

- 플레이: https://sigco3111.github.io/hegemony-war-pages/
- 원작: https://github.com/openfrontio/OpenFrontIO (AGPLv3, §7 저작자 표시 유지)

## 개선 1 — 로컬 기록실과 업적 이식

원작의 맵별 승리 메달과 전적은 계정 API 서버 기반이라 정적 배포에서는 동작하지 않습니다. 이를 기기(localStorage)로 이식했습니다.

- `src/client/LocalRecords.ts`: `hegemony.records.v1` 키에 게임 기록(최대 200건, 최신순)과 맵별 승리 난이도(메달)를 저장합니다.
- 치트 옵션(무한 골드/병력, 즉시 건설)을 켠 게임은 기록에는 남지만 메달과 챌린지는 인정하지 않습니다.
- 싱글 모달의 기록 패널에서 총판·승리·승률·정복 맵 수와 판별 내역을 확인할 수 있습니다.

## 개선 2 — 전황 대시보드

게임 중 왼쪽 사이드바의 바차트 버튼으로 여는 실시간 전황 화면입니다.

- `src/client/hud/layers/WarDashboard.ts`
- 국가별 영토 점유율 도넛 차트, 시간에 따른 점유율 추이 그래프(200ms 틱, 20틱마다 표본, 최대 600표본), 전쟁 연대기(공격·정복·동맹 체결/파기/만료·교역 중단, 최대 200건).
- SVG 렌더링은 lit의 `svg` 태그를 사용합니다(`html` 태그로 만들면 HTML 네임스페이스가 되어 렌더되지 않습니다).

## 개선 3 — 챌린지와 시나리오 판

기존 맵·난이도 위에 달성 목표와 보상을 얹었습니다. 클리어 조건은 솔로 승리(치트 제외)이며, 클리어 기록은 기록실에 남고 승리 모달에 배지가 뜹니다.

업적형 챌린지:

| 챌린지 | 조건 |
| --- | --- |
| 한반도의 기상 | 대한민국 맵에서 승리 (쉬움 이상) |
| 황해의 제왕 | 황해 맵에서 승리 (보통 이상) |
| 동아시아의 패자 | 동아시아 맵에서 승리 (어려움 이상) |
| 포위 돌파 | 포위 맵에서 승리 (보통 이상) |
| 핵전쟁 생존자 | 바이칼 (핵전쟁용) 맵에서 승리 (쉬움 이상) |
| 불가능은 없다 | 아무 맵에서나 불지옥 난이도로 승리 |

시나리오형 챌린지(규칙이 다른 목표, 기록실의 도전 버튼이 설정을 즉시 불러옴):

| 챌린지 | 조건 | 프리셋 |
| --- | --- | --- |
| 속전속결 | 세계 맵에서 10분(6,000틱) 안에 승리 (보통 이상) | 세계 / 보통 / 봇 400 |
| 최후의 방어선 | 포위 맵에서 종료 타이머를 켜고 승리 (어려움 이상) | 포위 / 어려움 / 봇 400 / 타이머 10분 |
| 비핵 시대 | 핵무기 3종(원자폭탄·수소폭탄·MIRV) 금지 설정으로 승리 (보통 이상) | 보통 / 핵 3종 금지 |
| 압도적 열세 | 봇 300 이상 상대로 승리 (어려움 이상) | 어려움 / 봇 300 |

메타 챌린지:

| 챌린지 | 조건 |
| --- | --- |
| 패권의 시간 | 다른 모든 챌린지 달성 |

- `src/client/Challenges.ts`: 챌린지 정의와 난이도 비교.
- `LocalRecords.recordSoloGameEnd`가 승리 기록 시 새로 달성한 챌린지 목록을 반환하고, `WinModal`이 배지로 표시합니다.

## 네트워크 차단 (soloStatic)

정적 배포에서는 외부 서버가 없으므로, 서버 의존 경로를 소스에서 차단합니다. `ClientEnv.soloStatic()`(PAGES_BASE 설정 빌드에서 참)을 게이트로 씁니다.

- `ServerList.ensureServerList` / 폴링: 서버 목록 fetch 없이 로컬 구성만 적용
- `Api.getNews`: 번들 뉴스 즉시 반환
- `Main`: 광고(Admiral) 페이로드 비활성
- `Cosmetics`: 코스메틱 fetch 건너뜀
- `WinModal.innerHtml`: 스토어/프로모 iframe 생성 차단
- `UsernameInput`: 인증 이름 UI 제거, 기기 로컬 이름만
- `Utils.homeHref`: 서브패스 기준 홈 링크

검증은 `performance.getEntriesByType("resource")` 전수 감사로 부팅→게임→종료→메뉴 재진입 전 구간 외부 요청 0건을 확인합니다.

## 빌드와 배포

- 포크: `sigco3111/hegemony-war` (소스, apply-payload 워크플로가 `*payload.zip`을 main에 적용)
- 배포: `sigco3111/hegemony-war-pages` (workflow_dispatch → 포크 체크아웃 → vite build → GitHub Pages)
- 빌드 환경: `PAGES_BASE=/hegemony-war-pages/ CDN_BASE=/hegemony-war-pages GAME_ENV=prod DOMAIN=sigco3111.github.io npx vite build --mode static`
- GitHub Pages는 index.html을 10분 캐시하므로 검증 시 `?v=N` 쿼리와 서빙 중인 번들 해시를 함께 확인합니다.

## 라이선스

- 코드: AGPLv3 (원작 고지 "© OpenFront and Contributors" 유지)
- 원작 에셋: CC BY-SA 4.0
