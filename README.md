# 패권의 시간 (Age of Hegemony)

OpenFrontIO의 싱글플레이 개선 포크입니다. 서버 없이 브라우저만으로 플레이합니다.

**플레이: https://sigco3111.github.io/hegemony-war-pages/**

## 원작과의 차이

- **로컬 기록실**: 맵별 승리 메달과 전적이 계정 서버 대신 기기에 저장됩니다. 로그인이 없습니다.
- **전황 대시보드**: 국가별 영토 점유율 파이, 점유율 추이 그래프, 전쟁 연대기를 게임 중에 열어봅니다.
- **챌린지**: 한반도의 기상, 포위 돌파, 핵전쟁 생존자 등 7개의 목표와 보상 배지가 있습니다.
- **완전 오프라인 구조**: 서버 목록, 뉴스, 광고, 코스메틱, 프로모션 등 외부 요청을 소스에서 차단했습니다. 사운드는 없습니다.
- 한국어 기본 UI, 135개 맵 전부 수록.

설계 배경과 구현 상세는 [docs/DESIGN.md](docs/DESIGN.md)에, 원작의 원문 README는 [README.en.md](README.en.md)에 보존되어 있습니다.

## 저장소 구조

- 이 저장소(`hegemony-war`): 게임 소스. `*payload.zip`이 푸시되면 apply-payload 워크플로가 변경을 main에 적용합니다.
- `sigco3111/hegemony-war-pages`: 배포 전용. 워크플로를 수동 실행하면 이 저장소를 빌드해 GitHub Pages에 올립니다.

## 라이선스

원작 [OpenFrontIO](https://github.com/openfrontio/OpenFrontIO)의 AGPLv3 라이선스를 따르며, §7에 따라 "© OpenFront and Contributors" 저작자 표시를 유지합니다. 원작 에셋은 CC BY-SA 4.0입니다.
