# Korea Electricity Bill Calculator (한국 전력 요금 계산기)

Homey 앱으로 한국전력(KEPCO) 누진제 요금 체계를 기반으로 전기 요금을 계산합니다.

## 기능

- 한국전력 주거용 전기요금 계산 (누진제)
- 저압/고압 요금제 지원
- 계절별 요금 적용 (하계/동계/기타)
- 복지 할인 지원 (대가족, 장애인, 기초생활수급자 등)
- 월별 예상 요금 계산
- 검침일 기준 사용량 추적

## 요금 체계

### 누진 구간 (주거용 저압)
| 구간 | 사용량 | 기본요금 | 전력량요금 |
|------|--------|----------|------------|
| 1단계 | 0~200kWh | 910원 | 120.0원/kWh |
| 2단계 | 201~400kWh | 1,600원 | 214.6원/kWh |
| 3단계 | 401kWh~ | 7,300원 | 307.3원/kWh |

*하계(7~8월) 및 동계(12~2월) 슈퍼유저 요금은 별도 적용

### 부가 요금
- 기후환경요금
- 연료비조정액
- 부가가치세 (10%)
- 전력산업기반기금 (2.7%)

## 설치 방법

1. Homey 앱에서 "Korea Electricity Bill Calculator" 검색
2. 앱 설치
3. 디바이스 추가 후 전력 미터 소스 선택
4. 검침일 설정

## 설정

- **검침일**: 한전 검침일 (1~31)
- **전압**: 저압(low) / 고압(high)
- **대가족 할인**: 5인 이상 가구, 출산가구, 3자녀 이상 등
- **복지 할인**: 장애인, 유공자, 기초생활수급자 등

## 참고 자료

이 프로젝트는 다음 오픈소스 프로젝트를 참고하여 개발되었습니다:

### Base Project
- **Power by the Hour** by Robin de Gruijter
  - Repository: https://github.com/gruijter/com.gruijter.powerhour
  - License: GPL-3.0-or-later
  - Homey 에너지 요약 앱의 기본 구조로 사용

### 한국 전력 요금 계산 로직
- **kwh_to_won** by dugurs
  - Repository: https://github.com/dugurs/kwh_to_won
  - Home Assistant용 한국 전기요금 계산 통합 구성요소
  - 한국전력(KEPCO) 누진제 요금 계산 로직 참고

## 라이선스

GPL-3.0-or-later

## 개발자

- LomoHome (mokorean@gmail.com)

## 관련 링크

- [한국전력 전기요금표](https://online.kepco.co.kr/PRM033D00)
- [Homey Developer Documentation](https://developer.athom.com/)
