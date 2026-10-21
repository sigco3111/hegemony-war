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

### 기록 검증과 마이그레이션 (v1.1)

- 시나리오형 챌린지는 클리어한 게임이 해당 프리셋의 규칙을 실제로 만족했을 때만 인정되며, 통과한 클리어는 증거(challengeProofs)가 기록에 고정됩니다.
- 과거 버그로 잘못 부여된 챌린지의 정정은 증거 기반으로만 합니다. 증거가 있는 정상 클리어는 보존하고, 무효가 확실한 부여만 한 번 회수하며, 증거 부재만으로는 삭제하지 않습니다. 마이그레이션은 기기당 한 번 실행되고 멱등입니다.
- 증거 없는 업적 재지급은 하지 않습니다.

## 개선 4 — AI 외교 심화 (견제 외교)

한 국가가 지도를 지배하기 시작하면 다른 국가 AI가 결집해 견제합니다.

- 도주 선두 판정: FFA에서 1위의 점유 타일이 2위의 일정 배수 이상일 때 (보통 3배 / 어려움 2배 / 불지옥 1.5배). 쉬움 난이도의 국가는 조직하지 않습니다.
- 견제 연합 수락: 도주 선두의 병력이 자신의 2배를 넘으면, 평소라면 거절할 약체의 동맹 요청도 연합 파트너로 수락합니다.
- 초국경 연합 요청: 명백한 열세(선두 병력의 절반 미만)일 때 국경을 공유하지 않는 위협받는 국가에게도 동맹을 제안합니다 (공격 틱마다 1/20 확률 게이트).
- 패자 동맹 해소: 도주 선두와 맺은 동맹은 자산이 아니라 위협이 되므로 스스로 파기합니다.
- 기회주의 배신: 동맹이 다른 세력에게 다굴당하는 중(들어오는 공격 병력이 동맹의 보유 병력 초과)이고 자신이 더 강하면 배신에 합류합니다 (어려움·불지옥 한정). 원작의 배신 규칙(최대 이득 동맹 배신, 유일 인접 약체 배신)과 별개 분기입니다.
- 동맹 끄기 설정에서는 전부 발동하지 않습니다.
- 구현: `packages/engine/src/execution/nation/NationAllianceBehavior.ts`의 `maybeContainmentDiplomacy` 등. `NationExecution`이 매 공격 틱에 호출하며, 동맹 체결·파기는 전황 대시보드 연대기에 기록됩니다.

## 개선 5 — 외교 상황판과 AI 외교 설명

개선 4에서 만든 AI 외교를 플레이어가 읽고 활용할 수 있게 합니다.

- `src/client/hud/layers/DiplomacyBoard.ts`: 싱글 게임 왼쪽 사이드바의 악수 버튼으로 여는 외교 상황판입니다.
  - 위협: 나를 공격 중인 세력과 총 병력, 도주 선두(패권 위협) 배너. 판정은 엔진 `findRunawayLeader`와 같은 규칙(난이도별 배수, FFA 한정)을 클라이언트에서 미러링합니다.
  - 동맹 관계: 살아있는 국가들의 모든 동맹 쌍과 남은 시간. 내 동맹은 강조합니다.
  - 국가 현황: 국가별 점유율·관계 상태(동맹/제안 보냄/제안 받음/교전 중/중립)·그 국가의 동맹 목록과 동맹 제안/파기 버튼. 기존 의도 파이프라인(`SendAllianceRequestIntentEvent` / `SendBreakAllianceIntentEvent`)을 그대로 쓰며, 동맹 끄기 설정에서는 숨깁니다.
- AI 행동 이유: `NationAllianceBehavior`가 판단 순간에 `GameUpdateType.DiplomacyNote` 업데이트(행위자·대상·위협·이유 코드)를 내보내고, 전황 대시보드 연대기가 동맹 체결/파기 항목에 그 이유를 덧붙입니다.
  - `accept_containment`(견제 연합 수락), `break_hegemon`(패권국 동맹 파기), `betray_opportunistic`(기회주의 배신)는 개선 4 분기입니다.
  - `betray_juiciest`·`betray_weak`·`betray_traitor`·`betray_lonely`는 원작 배신 분기의 이유 표기입니다.
  - 동맹 수락 판단은 `decideAlliance`가 어떤 분기가 결정했는지 함께 반환해, 견제가 실제 결정 사유일 때만 표기합니다.

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

## 검증 현황과 한계

- 단위 테스트: 기록 검증, 챌린지 게이트, 견제·기회주의 외교 등 31건 (`tests/RecordsRevalidate.test.ts`, `tests/ChallengesGate.test.ts`, `tests/NationContainment.test.ts`, `tests/NationOpportunisticBetrayal.test.ts`).
- 통제 통합 테스트: `tests/NationContainmentIntegration.test.ts`가 배포와 같은 엔진 배선(`NationExecution` → `executeNextTick`)으로 도주 선두 트리거를 결정적으로 재현합니다. 견제 연합 성립, 패자 동맹 파기, 연대기가 소비하는 업데이트(AllianceRequestReply·BrokeAlliance) 방출을 확인합니다.
- 자연 플레이 관찰 (유럽·어려움, 사망 후 관전): AI 간 동맹 89건 자연 체결, 연대기 이유 문구 실측 — "Ukraine → Romanian Lordship 동맹 파기 — 압도적 열세 동맹 배신". 플레이어 동맹 제안 → AI 수락 → 파기(배신자 플래그) 전 사이클을 실입력으로 확인. 도주 선두 견제 연합의 자연 발동 장면은 아직 미관찰(관찰 종료 시 선두 비율 1.04배)이므로, 견제는 통제 통합 테스트 증거와 구분해서 평가합니다.
- 후속 수정: 언어 JSON fetch에 `cache:"no-cache"`(무해시 URL이라 구 캐시가 남아 신규 문자열이 영어로 폴백하던 문제), 외교판 국가 목록을 멤버십 변경 시에만 재정렬(200ms 틱 재정렬로 버튼이 커서 아래에서 움직이던 문제). 데스크톱·모바일(390px) 실기기 렌더링 검증 완료.
- 알려진 잔여 리스크: 기록 재검증이 백업 없이 삭제하던 이전 배포에 노출된 기기에서 기록 로테이션(200건 초과)까지 진행된 경우, 그때 삭제된 업적은 복구할 수 없습니다.

## 빌드와 배포

- 포크: `sigco3111/hegemony-war` (소스, apply-payload 워크플로가 `*payload.zip`을 main에 적용)
- 배포: `sigco3111/hegemony-war-pages` (workflow_dispatch → 포크 체크아웃 → vite build → GitHub Pages)
- 빌드 환경: `PAGES_BASE=/hegemony-war-pages/ CDN_BASE=/hegemony-war-pages GAME_ENV=prod DOMAIN=sigco3111.github.io npx vite build --mode static`
- GitHub Pages는 index.html을 10분 캐시하므로 검증 시 `?v=N` 쿼리와 서빙 중인 번들 해시를 함께 확인합니다.

## 라이선스

- 코드: AGPLv3 (원작 고지 "© OpenFront and Contributors" 유지)
- 원작 에셋: CC BY-SA 4.0
