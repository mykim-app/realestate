# 부동산 가격 조회 사이트

지도에서 위치를 눌러 **관심 위치로 저장**하면 필지의 **개별공시지가**, 같은 지번의 **최근 아파트 실거래**, 지역별 **한국부동산원 주간 가격 변동률**을 보여 주고, 매주 금요일 아침 자동으로 기록을 쌓습니다. 모든 설치는 웹 화면에서만 진행합니다.

## 구성
- `index.html` : 화면 (GitHub Pages로 게시)
- `supabase/schema.sql` : 테이블 3개 (관심 위치, 주간 기록, 지역 주간 동향)
- `supabase/functions/realestate/index.ts` : 공공 API 중계·저장 함수
- `.github/workflows/weekly.yml` : 매주 자동 기록

## 설치 순서 (모두 웹에서)
1. **API 키 발급** (모두 무료)
   - 브이월드(vworld.kr) 오픈API 인증키 (서비스 URL에는 게시할 GitHub Pages 주소 입력)
   - 공공데이터포털(data.go.kr) "국토교통부_아파트 매매 실거래가 자료" 활용신청 후 일반 인증키
   - 한국부동산원 R-ONE(reb.or.kr/r-one) Open API 인증키와, 명세서의 주간 아파트 매매·전세 통계표 ID
2. **Supabase 대시보드 → SQL Editor**: `supabase/schema.sql` 내용을 붙여 넣고 Run
3. **Supabase 대시보드 → Edge Functions → Deploy a new function(Via Editor)**: 이름 `realestate`, `index.ts` 내용을 붙여 넣고 배포한 뒤, 함수 설정에서 **Verify JWT를 끕니다.**
4. **Supabase 대시보드 → Edge Functions → Secrets**: 아래 이름으로 값을 입력합니다. 키 값은 코드에 넣지 않고 여기에만 보관됩니다.

   | 이름 | 넣을 값 |
   |---|---|
   | APP_PASSWORD | 사이트 접속 비밀번호 (직접 정함) |
   | VWORLD_KEY | 브이월드 인증키 |
   | VWORLD_DOMAIN | 게시 주소 (예: 계정.github.io) |
   | DATA_GO_KR_KEY | 공공데이터포털 인증키 |
   | REB_KEY | 한국부동산원 인증키 (선택) |
   | REB_SALE_STATBL_ID | 주간 매매 통계표 ID (선택) |
   | REB_JEONSE_STATBL_ID | 주간 전세 통계표 ID (선택) |

5. **GitHub 웹**: 새 저장소를 만들고 `index.html`, `README.md`를 업로드합니다. 자동 기록 파일은 Add file → Create new file에서 이름을 `.github/workflows/weekly.yml`로 입력해 내용을 붙여 넣습니다.
6. **GitHub 웹 → Settings → Pages**: 브랜치를 지정해 게시합니다. **Settings → Secrets and variables → Actions**에 `APP_PASSWORD`(위와 같은 비밀번호)를 등록합니다.
7. 게시된 주소에 접속 → 비밀번호 입력 → 지도에서 위치 선택 → 저장

## 알아 둘 점
- 공시지가 단위는 **원/㎡**이며, 1평(3.305785㎡)당 금액은 환산값입니다.
- 실거래가는 신고 지연으로 최대 30일 늦게 반영되며, **같은 지번의 아파트 매매**만 표시합니다. 토지·단독주택 지번은 거래가 없다고 나옵니다.
- 한국부동산원 주간 동향은 지번별이 아니라 시·군·구 단위 통계입니다.
- 통계표 ID를 비워 두면 지역 주간 동향만 빠지고, 공시지가·실거래는 정상 동작합니다.
- 비밀번호를 아는 사람만 저장·조회할 수 있습니다.
